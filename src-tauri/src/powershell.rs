/// PowerShell discovery and process management.
/// Handles detecting installed PowerShell versions and managing script execution.
use crate::errors::AppError;
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

/// Maximum number of output lines to buffer per process (memory bound).
const MAX_OUTPUT_LINES: usize = 100_000;

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
        on_output: F,
    ) -> Result<i32, AppError>
    where
        F: Fn(OutputLine) + Send + Sync + 'static,
    {
        // Stop any existing process first
        self.stop().await?;

        info!("Executing script with {} in {}", ps_path, working_dir);
        debug!(
            "Script content (first 200 chars): {}",
            &script[..script.len().min(200)]
        );

        // Write the script to a uniquely-named temp file and run it with -File.
        // Using -File instead of -Command removes the "inline PowerShell command"
        // pattern that security tools (e.g. MDE) flag as a reverse-shell indicator.
        let temp_path = std::env::temp_dir()
            .join(format!("psforge_{}.ps1", Uuid::new_v4()));
        std::fs::write(&temp_path, script.as_bytes()).map_err(|e| AppError {
            code: "SCRIPT_WRITE_FAILED".to_string(),
            message: format!("Failed to write script to temp file: {}", e),
        })?;
        let temp_path_str = temp_path.to_string_lossy().into_owned();

        // Build args: only inject -ExecutionPolicy when the user has configured one.
        // "Default" means "honour the machine/user policy" so we omit the flag
        // entirely, avoiding -Bypass in process trees that trigger AV heuristics.
        let mut ps_args: Vec<&str> = vec!["-NoProfile", "-NonInteractive"];
        if exec_policy != "Default" {
            ps_args.push("-ExecutionPolicy");
            ps_args.push(exec_policy);
        }
        ps_args.push("-File");
        ps_args.push(&temp_path_str);

        let mut child = Command::new(ps_path)
            .args(&ps_args)
            .current_dir(working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| {
                // Clean up the temp file if the process failed to start.
                let _ = std::fs::remove_file(&temp_path);
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

        // Remove the temp script file now that execution has finished.
        let _ = std::fs::remove_file(&temp_path);

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
