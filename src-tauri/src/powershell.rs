/// PowerShell discovery and process management.
/// Handles detecting installed PowerShell versions and managing script execution.
use crate::errors::AppError;
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

/// Maximum number of output lines to buffer per process (memory bound).
const MAX_OUTPUT_LINES: usize = 100_000;

/// PowerShell bootstrap that ensures a real (hidden) Win32 console window
/// handle exists for the child process.
///
/// Some modern auth flows (for example WAM/MSAL in ExchangeOnlineManagement)
/// query `GetConsoleWindow()` and fail when it returns `0` in redirected,
/// headless hosts.  We detach from any pseudoconsole and allocate a hidden
/// real console window when needed, while keeping stdio pipes intact.
const AUTH_WINDOW_HANDLE_BOOTSTRAP_PS: &str = r#"
try {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PSForgeNativeConsole {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AllocConsole();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction Stop | Out-Null

    if ([PSForgeNativeConsole]::GetConsoleWindow() -eq [IntPtr]::Zero) {
        [void][PSForgeNativeConsole]::FreeConsole()
        if ([PSForgeNativeConsole]::AllocConsole()) {
            $psfHwnd = [PSForgeNativeConsole]::GetConsoleWindow()
            if ($psfHwnd -ne [IntPtr]::Zero) {
                # SW_HIDE = 0
                [void][PSForgeNativeConsole]::ShowWindow($psfHwnd, 0)
            }
        }
    }
} catch {
    # Best-effort only: script execution must continue even if this fails.
}
"#;

/// Represents a discovered PowerShell installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PsVersion {
    /// Display name, e.g. "PowerShell 7.4.1" or "Windows PowerShell 5.1"
    pub name: String,
    /// Full path to the executable.
    pub path: String,
    /// Version string parsed from the executable.
    pub version: String,
}

/// A single line of output from a running script.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputLine {
    /// The stream this line came from: "stdout", "stderr", "verbose", "warning".
    pub stream: String,
    /// The text content.
    pub text: String,
    /// ISO 8601 timestamp.
    pub timestamp: String,
}

/// Debugger breakpoint specification received from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugBreakpointSpec {
    /// 1-indexed source line for line breakpoints.
    pub line: Option<u32>,
    /// Variable name for variable breakpoints.
    pub variable: Option<String>,
    /// Command/cmdlet name for command breakpoints.
    pub target_command: Option<String>,
    /// Variable breakpoint mode: Read | Write | ReadWrite.
    pub mode: Option<String>,
    /// Conditional expression that must evaluate truthy before breaking.
    pub condition: Option<String>,
    /// Break only on/after this hit count.
    pub hit_count: Option<u32>,
    /// Optional action script to run when the breakpoint triggers.
    pub command: Option<String>,
}

fn ps_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

/// Manages running PowerShell processes.
/// Thread-safe via Arc<Mutex<...>> for use across Tauri async commands.
pub struct ProcessManager {
    /// Currently running child process, if any.
    current_process: Arc<Mutex<Option<Child>>>,
    /// Stdin writer for the current process.
    stdin_writer: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    /// Kill-signal channel: populated by execute() just before it blocks on
    /// child.wait(), cleared when the wait resolves.  stop() sends on this
    /// channel so the select! inside execute() takes the kill arm -- avoiding
    /// the deadlock that would occur if stop() blocked waiting for
    /// current_process.lock() while execute() held it during child.wait().
    kill_sender: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}

impl ProcessManager {
    /// Creates a new ProcessManager with no running process.
    pub fn new() -> Self {
        Self {
            current_process: Arc::new(Mutex::new(None)),
            stdin_writer: Arc::new(Mutex::new(None)),
            kill_sender: Arc::new(Mutex::new(None)),
        }
    }

    /// Returns true if a process is currently running.
    #[allow(dead_code)]
    pub async fn is_running(&self) -> bool {
        let guard = self.current_process.lock().await;
        guard.is_some()
    }

    /// Kills the currently running process, if any.
    ///
    /// Two code paths handled:
    /// 1. execute() is in its output-reading phase (current_process holds the
    ///    child).  We acquire the lock, kill, and clear.
    /// 2. execute() has taken the child out of the mutex and is inside the
    ///    select!(child.wait(), kill_rx) block.  In this case current_process
    ///    is None but kill_sender holds a Sender.  Sending on it causes the
    ///    select! to take the kill arm, which calls child.kill() there.
    pub async fn stop(&self) -> Result<(), AppError> {
        // Wake any active execute() wait so it kills the process and returns.
        {
            let mut ks = self.kill_sender.lock().await;
            if let Some(tx) = ks.take() {
                let _ = tx.send(());
            }
        }

        // Also kill via the process handle if it is still in the Mutex
        // (handles the case where stop() is called before execute() sets up
        // the kill channel, e.g. during the output-reading phase).
        let mut guard = self.current_process.lock().await;
        if let Some(ref mut child) = *guard {
            info!("Stopping running PowerShell process");
            child.kill().await.map_err(|e| AppError {
                code: "PROCESS_KILL_FAILED".to_string(),
                message: format!("Failed to kill process: {}", e),
            })?;
            *guard = None;
        }
        // Also drop the stdin writer
        let mut stdin_guard = self.stdin_writer.lock().await;
        *stdin_guard = None;
        Ok(())
    }

    /// Sends input to the running process's stdin (for Read-Host support).
    pub async fn send_stdin(&self, input: &str) -> Result<(), AppError> {
        let mut guard = self.stdin_writer.lock().await;
        if let Some(ref mut writer) = *guard {
            let line = format!("{}\n", input);
            writer
                .write_all(line.as_bytes())
                .await
                .map_err(|e| AppError {
                    code: "STDIN_WRITE_FAILED".to_string(),
                    message: format!("Failed to write to stdin: {}", e),
                })?;
            writer.flush().await.map_err(|e| AppError {
                code: "STDIN_FLUSH_FAILED".to_string(),
                message: format!("Failed to flush stdin: {}", e),
            })?;
            Ok(())
        } else {
            Err(AppError {
                code: "NO_PROCESS".to_string(),
                message: "No running process to send input to".to_string(),
            })
        }
    }

    /// Executes a PowerShell script and streams output via the provided callback.
    /// The callback receives each OutputLine as it arrives.
    pub async fn execute<F>(
        &self,
        ps_path: &str,
        script: &str,
        working_dir: &str,
        exec_policy: &str,
        script_args: &[String],
        debug_breakpoints: Option<&[DebugBreakpointSpec]>,
        on_output: F,
    ) -> Result<i32, AppError>
    where
        F: Fn(OutputLine) + Send + Sync + 'static,
    {
        validate_ps_path(ps_path)?;

        // Stop any existing process first
        self.stop().await?;

        info!("Executing script with {} in {}", ps_path, working_dir);
        debug!("Script size: {} bytes", script.len());

        // Write the user script to a uniquely-named temp file.
        // Using -File instead of -Command removes the "inline PowerShell command"
        // pattern that security tools (e.g. MDE) flag as a reverse-shell indicator.
        let user_script_path =
            std::env::temp_dir().join(format!("psforge_script_{}.ps1", Uuid::new_v4()));
        std::fs::write(&user_script_path, script.as_bytes()).map_err(|e| AppError {
            code: "SCRIPT_WRITE_FAILED".to_string(),
            message: format!("Failed to write script to temp file: {}", e),
        })?;
        let user_script_path_ps = user_script_path.to_string_lossy().replace('\'', "''");

        // Wrapper script that first ensures a valid hidden Win32 console handle
        // for auth libraries, then executes the real script path with original args.
        // In debug mode, line breakpoints are registered against the temp script path.
        let wrapper_script_path =
            std::env::temp_dir().join(format!("psforge_wrapper_{}.ps1", Uuid::new_v4()));
        let mut wrapper_script = String::new();
        wrapper_script.push_str(AUTH_WINDOW_HANDLE_BOOTSTRAP_PS);
        wrapper_script.push_str("\n$__psforge_script_path = '");
        wrapper_script.push_str(&user_script_path_ps);
        wrapper_script.push_str("'\n");
        if let Some(specs) = debug_breakpoints {
            // Register debugger breakpoints. Supports line breakpoints plus
            // variable breakpoints, with optional condition/hit-count/action.
            wrapper_script.push_str("$global:__psforge_debug_scope = 0\n");
            wrapper_script.push_str("$script:__psforge_bp_hits = @{}\n");
            wrapper_script.push_str("$script:__psforge_bp_conditions = @{}\n");
            wrapper_script.push_str("$script:__psforge_bp_commands = @{}\n");

            for (idx, spec) in specs.iter().enumerate() {
                let line = spec.line.filter(|line| *line > 0);
                let variable = spec
                    .variable
                    .as_ref()
                    .map(|v| v.trim().trim_start_matches('$').to_string())
                    .filter(|v| !v.is_empty());
                let target_command = spec
                    .target_command
                    .as_ref()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty());
                if line.is_none() && variable.is_none() && target_command.is_none() {
                    continue;
                }

                let mode = match spec.mode.as_deref() {
                    Some("Read") => "Read",
                    Some("Write") => "Write",
                    _ => "ReadWrite",
                };
                let condition = spec
                    .condition
                    .as_ref()
                    .map(|v| v.trim())
                    .filter(|v| !v.is_empty());
                let command = spec
                    .command
                    .as_ref()
                    .map(|v| v.trim())
                    .filter(|v| !v.is_empty());
                let hit_count = spec.hit_count.filter(|v| *v >= 1);

                let bp_id = format!("bp{}", idx + 1);
                let bp_id_ps = ps_single_quoted(&bp_id);

                if let Some(cond) = condition {
                    wrapper_script.push_str("$script:__psforge_bp_conditions['");
                    wrapper_script.push_str(&bp_id_ps);
                    wrapper_script.push_str("'] = '");
                    wrapper_script.push_str(&ps_single_quoted(cond));
                    wrapper_script.push_str("'\n");
                }
                if let Some(cmd_text) = command {
                    wrapper_script.push_str("$script:__psforge_bp_commands['");
                    wrapper_script.push_str(&bp_id_ps);
                    wrapper_script.push_str("'] = '");
                    wrapper_script.push_str(&ps_single_quoted(cmd_text));
                    wrapper_script.push_str("'\n");
                }

                let mut action = String::new();
                action.push_str("$__psf_id = '");
                action.push_str(&bp_id_ps);
                action.push_str("'; ");
                action.push_str(
                    "$script:__psforge_bp_hits[$__psf_id] = ([int]$script:__psforge_bp_hits[$__psf_id]) + 1; ",
                );
                if let Some(hit) = hit_count {
                    action.push_str("if ($script:__psforge_bp_hits[$__psf_id] -lt ");
                    action.push_str(&hit.to_string());
                    action.push_str(") { return } ");
                }
                action.push_str("$__psf_cond = $script:__psforge_bp_conditions[$__psf_id]; ");
                action.push_str(
                    "if ($__psf_cond) { try { if (-not (& ([scriptblock]::Create($__psf_cond)))) { return } } catch { return } } ",
                );
                action.push_str("$__psf_cmd = $script:__psforge_bp_commands[$__psf_id]; ");
                action.push_str(
                    "if ($__psf_cmd) { try { & ([scriptblock]::Create($__psf_cmd)) | Out-Null } catch {} } ",
                );
                action.push_str("Write-Host '<<PSF_DEBUG_BREAK>>");
                action.push_str(&line.unwrap_or(0).to_string());
                action.push_str("'; break");

                if let Some(line_no) = line {
                    wrapper_script.push_str("Set-PSBreakpoint -Script $__psforge_script_path -Line ");
                    wrapper_script.push_str(&line_no.to_string());
                    wrapper_script.push_str(" -Action { ");
                    wrapper_script.push_str(&action);
                    wrapper_script.push_str(" } | Out-Null\n");
                } else if let Some(var_name) = variable {
                    wrapper_script.push_str("Set-PSBreakpoint -Variable '");
                    wrapper_script.push_str(&ps_single_quoted(&var_name));
                    wrapper_script.push_str("' -Mode ");
                    wrapper_script.push_str(mode);
                    wrapper_script.push_str(" -Action { ");
                    wrapper_script.push_str(&action);
                    wrapper_script.push_str(" } | Out-Null\n");
                } else if let Some(command_name) = target_command {
                    wrapper_script.push_str("Set-PSBreakpoint -Command '");
                    wrapper_script.push_str(&ps_single_quoted(&command_name));
                    wrapper_script.push_str("' -Action { ");
                    wrapper_script.push_str(&action);
                    wrapper_script.push_str(" } | Out-Null\n");
                }
            }
        }
        wrapper_script.push_str("& $__psforge_script_path @args\n");
        std::fs::write(&wrapper_script_path, wrapper_script.as_bytes()).map_err(|e| AppError {
            code: "SCRIPT_WRITE_FAILED".to_string(),
            message: format!("Failed to write wrapper script to temp file: {}", e),
        })?;
        let wrapper_script_path_str = wrapper_script_path.to_string_lossy().into_owned();

        // Build args: only inject -ExecutionPolicy when the user has configured one.
        // "Default" means "honour the machine/user policy" so we omit the flag
        // entirely, avoiding -Bypass in process trees that trigger AV heuristics.
        let mut ps_args: Vec<String> = vec!["-NoProfile".to_string()];
        if debug_breakpoints.is_none() {
            ps_args.push("-NonInteractive".to_string());
        }
        if exec_policy != "Default" {
            ps_args.push("-ExecutionPolicy".to_string());
            ps_args.push(exec_policy.to_string());
        }
        ps_args.push("-File".to_string());
        ps_args.push(wrapper_script_path_str.clone());
        ps_args.extend(script_args.iter().cloned());

        let mut child = Command::new(ps_path)
            .args(ps_args)
            .current_dir(working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| {
                // Clean up temp files if the process failed to start.
                let _ = std::fs::remove_file(&user_script_path);
                let _ = std::fs::remove_file(&wrapper_script_path);
                AppError {
                    code: "PROCESS_SPAWN_FAILED".to_string(),
                    message: format!("Failed to start PowerShell at '{}': {}", ps_path, e),
                }
            })?;

        // Take stdin for interactive input
        let stdin = child.stdin.take();
        {
            let mut stdin_guard = self.stdin_writer.lock().await;
            *stdin_guard = stdin;
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Store the child process
        {
            let mut guard = self.current_process.lock().await;
            *guard = Some(child);
        }

        let on_output = Arc::new(on_output);
        let mut handles = Vec::new();

        // Stream stdout
        if let Some(stdout) = stdout {
            let cb = Arc::clone(&on_output);
            let handle = tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                let mut count = 0usize;
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if count >= MAX_OUTPUT_LINES {
                                warn!("stdout line limit reached ({})", MAX_OUTPUT_LINES);
                                break;
                            }
                            cb(OutputLine {
                                stream: "stdout".to_string(),
                                text: line,
                                timestamp: chrono_now(),
                            });
                            count += 1;
                        }
                        Ok(None) => break, // EOF
                        Err(e) => {
                            debug!("stdout reader I/O error: {}", e);
                            break;
                        }
                    }
                }
            });
            handles.push(handle);
        }

        // Stream stderr
        if let Some(stderr) = stderr {
            let cb = Arc::clone(&on_output);
            let handle = tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                let mut count = 0usize;
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if count >= MAX_OUTPUT_LINES {
                                warn!("stderr line limit reached ({})", MAX_OUTPUT_LINES);
                                break;
                            }
                            cb(OutputLine {
                                stream: "stderr".to_string(),
                                text: line,
                                timestamp: chrono_now(),
                            });
                            count += 1;
                        }
                        Ok(None) => break, // EOF
                        Err(e) => {
                            debug!("stderr reader I/O error: {}", e);
                            break;
                        }
                    }
                }
            });
            handles.push(handle);
        }

        // Wait for all output to finish
        for handle in handles {
            if let Err(e) = handle.await {
                error!("Output reader task failed: {}", e);
            }
        }

        // Register a kill channel so stop() can interrupt the wait below
        // without needing to hold current_process.lock() (which would
        // deadlock: execute holds it, stop can never acquire it).
        let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut ks = self.kill_sender.lock().await;
            *ks = Some(kill_tx);
        }

        // Take child out of the Mutex NOW, before waiting.  This lets stop()
        // acquire current_process.lock() (it will find None) and, if called
        // before the kill channel was ready, the kill_sender path covers it.
        let child_opt = {
            let mut guard = self.current_process.lock().await;
            guard.take()
        };

        let exit_code = if let Some(mut child) = child_opt {
            // Race between natural process exit and a stop() kill signal.
            tokio::select! {
                result = child.wait() => {
                    match result {
                        Ok(status) => status.code().unwrap_or(-1),
                        Err(e) => {
                            // Clear kill sender before propagating the error.
                            let mut ks = self.kill_sender.lock().await;
                            *ks = None;
                            return Err(AppError {
                                code: "PROCESS_WAIT_FAILED".to_string(),
                                message: format!("Failed to wait for process: {}", e),
                            });
                        }
                    }
                }
                _ = kill_rx => {
                    // stop() sent the signal: terminate the child process.
                    let _ = child.kill().await;
                    -1
                }
            }
        } else {
            // Process was already taken/killed between spawn and wait setup.
            -1
        };

        // Clear the kill sender now that the wait has resolved.
        {
            let mut ks = self.kill_sender.lock().await;
            *ks = None;
        }

        // Clean up stdin writer
        {
            let mut stdin_guard = self.stdin_writer.lock().await;
            *stdin_guard = None;
        }

        // Remove temp scripts now that execution has finished.
        let _ = std::fs::remove_file(&user_script_path);
        let _ = std::fs::remove_file(&wrapper_script_path);

        info!("Script execution completed with exit code {}", exit_code);
        Ok(exit_code)
    }
}

impl Default for ProcessManager {
    /// Delegates to `new()` so `ProcessManager::default()` is available (Rule 2 / clippy).
    fn default() -> Self {
        Self::new()
    }
}

/// Validates that `ps_path` points to an existing executable file.
/// Keeps checks lightweight because this is called on hot paths
/// (e.g. completions/analysis invocations).
pub fn validate_ps_path(ps_path: &str) -> Result<(), AppError> {
    let trimmed = ps_path.trim();
    if trimmed.is_empty() {
        return Err(AppError {
            code: "INVALID_PS_PATH".to_string(),
            message: "PowerShell path is empty".to_string(),
        });
    }

    let path = Path::new(trimmed);
    if !path.is_file() {
        return Err(AppError {
            code: "INVALID_PS_PATH".to_string(),
            message: format!("PowerShell executable not found at '{}'", trimmed),
        });
    }

    Ok(())
}

/// Discovers all installed PowerShell versions on the system.
pub fn discover_ps_versions() -> Vec<PsVersion> {
    info!("Discovering installed PowerShell versions");
    let mut versions = Vec::new();
    let mut seen_paths: HashMap<String, bool> = HashMap::new();

    // Check PS7+ in well-known paths
    let ps7_dirs = [
        r"C:\Program Files\PowerShell",
        r"C:\Program Files (x86)\PowerShell",
    ];

    for base in &ps7_dirs {
        let base_path = PathBuf::from(base);
        if base_path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&base_path) {
                for entry in entries.flatten() {
                    let pwsh = entry.path().join("pwsh.exe");
                    if pwsh.is_file() {
                        let path_str = pwsh.to_string_lossy().to_string();
                        seen_paths
                            .entry(path_str.to_lowercase())
                            .or_insert_with(|| {
                                let ver_name = entry.file_name().to_string_lossy().to_string();
                                versions.push(PsVersion {
                                    name: format!("PowerShell {}", ver_name),
                                    path: path_str.clone(),
                                    version: ver_name,
                                });
                                true
                            });
                    }
                }
            }
        }
    }

    // Check pwsh on PATH
    if let Ok(output) = std::process::Command::new("where.exe")
        .arg("pwsh.exe")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW: suppress console flash
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() && PathBuf::from(trimmed).is_file() {
                let key = trimmed.to_lowercase();
                seen_paths.entry(key).or_insert_with(|| {
                    versions.push(PsVersion {
                        name: "PowerShell (PATH)".to_string(),
                        path: trimmed.to_string(),
                        version: "7+".to_string(),
                    });
                    true
                });
            }
        }
    }

    // Windows PowerShell 5.1
    let win_ps = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    if PathBuf::from(win_ps).is_file() {
        versions.push(PsVersion {
            name: "Windows PowerShell 5.1".to_string(),
            path: win_ps.to_string(),
            version: "5.1".to_string(),
        });
    }

    if versions.is_empty() {
        error!("No PowerShell installations found");
    } else {
        info!("Found {} PowerShell installation(s)", versions.len());
        for v in &versions {
            debug!("  {} at {}", v.name, v.path);
        }
    }

    versions
}

/// Returns the current moment as a Unix epoch-seconds string.
/// The frontend's `formatTimestamp()` parses this into a locale time string.
fn chrono_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    format!("{}", secs)
}
