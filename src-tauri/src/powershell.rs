/// PowerShell discovery and process management.
/// Handles detecting installed PowerShell versions and managing script execution.
use crate::errors::AppError;
use crate::utils::write_secure_temp_file;
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

/// Maximum number of output lines to buffer per process (memory bound).
const MAX_OUTPUT_LINES: usize = 100_000;
/// Poll interval for checking whether the persistent PowerShell process exited.
const PROCESS_MONITOR_POLL_MS: u64 = 120;
/// Frontend/backend command markers for the persistent host protocol.
const RUN_COMMAND_MARKER_PREFIX: &str = "<<PSFORGE_RUN|";
const RUN_COMPLETE_MARKER_PREFIX: &str = "<<PSFORGE_DONE|";
const HOST_EXIT_MARKER: &str = "<<PSFORGE_EXIT>>";

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

fn parse_run_complete_marker(text: &str) -> Option<(String, i32)> {
    let trimmed = text.trim();
    if !(trimmed.starts_with(RUN_COMPLETE_MARKER_PREFIX) && trimmed.ends_with(">>")) {
        return None;
    }
    let body = trimmed
        .strip_prefix(RUN_COMPLETE_MARKER_PREFIX)?
        .strip_suffix(">>")?;
    let (id, code_str) = body.split_once('|')?;
    let code = code_str.trim().parse::<i32>().ok()?;
    if id.is_empty() {
        return None;
    }
    Some((id.to_string(), code))
}

fn persistent_host_bootstrap_script() -> String {
    let mut script = String::new();
    script.push_str(
        r#"
$ErrorActionPreference = 'Continue'

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

"#,
    );
    script.push_str(AUTH_WINDOW_HANDLE_BOOTSTRAP_PS);
    script.push_str(
        r#"

function global:Invoke-PSForgeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandId,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath
    )

    $exitCode = 0
    try {
        if ([string]::IsNullOrWhiteSpace($ScriptPath) -or
            -not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
            throw "PSForge command script not found: $ScriptPath"
        }

        & $ScriptPath
        if (-not $?) {
            $exitCode = 1
        }
    } catch {
        Write-Error $_
        $exitCode = 1
    } finally {
        [Console]::Out.WriteLine("<<PSFORGE_DONE|$CommandId|$exitCode>>")
        [Console]::Out.Flush()
        [Console]::Error.WriteLine("<<PSFORGE_DONE|$CommandId|$exitCode>>")
        [Console]::Error.Flush()
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }

    if ($line -eq '<<PSFORGE_EXIT>>') { break }

    if ($line -match '^<<PSFORGE_RUN\|([^|]+)\|(.+)>>$') {
        Invoke-PSForgeCommand -CommandId $matches[1] -ScriptPath $matches[2]
        continue
    }
}
"#,
    );
    script
}

#[derive(Debug, Clone)]
enum SessionEvent {
    Output(OutputLine),
    Exited(i32),
}

struct PersistentSession {
    ps_path: String,
    exec_policy: String,
    child: Arc<Mutex<Option<Child>>>,
    stdin_writer: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    event_rx: Arc<Mutex<mpsc::UnboundedReceiver<SessionEvent>>>,
    output_budget: Arc<AtomicUsize>,
    output_budget_warned: Arc<AtomicBool>,
    bootstrap_script_path: PathBuf,
}

/// Manages PowerShell execution via a process-local persistent runspace.
/// A session is reused between runs/debug sessions until stopped or invalidated.
pub struct ProcessManager {
    /// Persistent backend host process (one session at a time).
    session: Arc<Mutex<Option<Arc<PersistentSession>>>>,
    /// True while a run/debug command is currently executing inside the session.
    active_command: Arc<Mutex<Option<String>>>,
    /// Serializes execute() calls so command output streams never interleave.
    execution_lock: Arc<Mutex<()>>,
    /// Kill-signal channel for the currently active execute() call.
    kill_sender: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl ProcessManager {
    /// Creates a new ProcessManager with no persistent session.
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            active_command: Arc::new(Mutex::new(None)),
            execution_lock: Arc::new(Mutex::new(())),
            kill_sender: Arc::new(Mutex::new(None)),
        }
    }

    /// Returns true if a script/debug command is currently executing.
    #[allow(dead_code)]
    pub async fn is_running(&self) -> bool {
        let guard = self.active_command.lock().await;
        guard.is_some()
    }

    async fn clear_active_state(&self) {
        {
            let mut ks = self.kill_sender.lock().await;
            *ks = None;
        }
        {
            let mut active = self.active_command.lock().await;
            *active = None;
        }
    }

    async fn shutdown_session(session: Arc<PersistentSession>) {
        {
            let mut stdin_guard = session.stdin_writer.lock().await;
            *stdin_guard = None;
        }
        {
            let mut child_guard = session.child.lock().await;
            if let Some(ref mut child) = *child_guard {
                if let Err(e) = child.kill().await {
                    debug!("Failed to kill persistent session process: {}", e);
                }
            }
            *child_guard = None;
        }
        let _ = std::fs::remove_file(&session.bootstrap_script_path);
    }

    async fn is_session_usable(session: &Arc<PersistentSession>) -> bool {
        let exited = {
            let mut child_guard = session.child.lock().await;
            match child_guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => {
                        *child_guard = None;
                        true
                    }
                    Ok(None) => false,
                    Err(e) => {
                        debug!("Failed to poll persistent session process: {}", e);
                        *child_guard = None;
                        true
                    }
                },
                None => true,
            }
        };
        if exited {
            let mut stdin_guard = session.stdin_writer.lock().await;
            *stdin_guard = None;
            return false;
        }
        true
    }

    async fn write_session_line(session: &PersistentSession, line: &str) -> Result<(), AppError> {
        let mut stdin_guard = session.stdin_writer.lock().await;
        let writer = stdin_guard.as_mut().ok_or_else(|| AppError {
            code: "NO_PROCESS".to_string(),
            message: "No running process to send input to".to_string(),
        })?;
        writer
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|e| AppError {
                code: "STDIN_WRITE_FAILED".to_string(),
                message: format!("Failed to write to stdin: {}", e),
            })?;
        writer.flush().await.map_err(|e| AppError {
            code: "STDIN_FLUSH_FAILED".to_string(),
            message: format!("Failed to flush stdin: {}", e),
        })
    }

    fn try_consume_output_budget(budget: &AtomicUsize) -> bool {
        let mut current = budget.load(Ordering::Relaxed);
        loop {
            if current == 0 {
                return false;
            }
            match budget.compare_exchange_weak(
                current,
                current - 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(next) => current = next,
            }
        }
    }

    fn spawn_output_reader(
        stdout_or_stderr: impl tokio::io::AsyncRead + Unpin + Send + 'static,
        stream_name: &'static str,
        tx: mpsc::UnboundedSender<SessionEvent>,
        output_budget: Arc<AtomicUsize>,
        output_budget_warned: Arc<AtomicBool>,
    ) {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout_or_stderr);
            let mut lines = reader.lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if Self::try_consume_output_budget(&output_budget) {
                            let _ = tx.send(SessionEvent::Output(OutputLine {
                                stream: stream_name.to_string(),
                                text: line,
                                timestamp: chrono_now(),
                            }));
                        } else if !output_budget_warned.swap(true, Ordering::Relaxed) {
                            warn!(
                                "Output line limit reached ({}); dropping additional lines for current command",
                                MAX_OUTPUT_LINES
                            );
                            // Keep draining to avoid filling the OS pipe and
                            // deadlocking the PowerShell process.
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        debug!("{} reader I/O error: {}", stream_name, e);
                        break;
                    }
                }
            }
        });
    }

    fn spawn_process_monitor(
        child: Arc<Mutex<Option<Child>>>,
        stdin_writer: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
        tx: mpsc::UnboundedSender<SessionEvent>,
    ) {
        tokio::spawn(async move {
            loop {
                let maybe_code = {
                    let mut child_guard = child.lock().await;
                    match child_guard.as_mut() {
                        Some(child_proc) => match child_proc.try_wait() {
                            Ok(Some(status)) => {
                                let code = status.code().unwrap_or(-1);
                                *child_guard = None;
                                Some(code)
                            }
                            Ok(None) => None,
                            Err(e) => {
                                debug!("Persistent session wait poll failed: {}", e);
                                *child_guard = None;
                                Some(-1)
                            }
                        },
                        None => return,
                    }
                };

                if let Some(code) = maybe_code {
                    let mut stdin_guard = stdin_writer.lock().await;
                    *stdin_guard = None;
                    let _ = tx.send(SessionEvent::Exited(code));
                    return;
                }

                sleep(Duration::from_millis(PROCESS_MONITOR_POLL_MS)).await;
            }
        });
    }

    async fn start_session(
        ps_path: &str,
        exec_policy: &str,
    ) -> Result<Arc<PersistentSession>, AppError> {
        let bootstrap_script = persistent_host_bootstrap_script();
        let bootstrap_script_path = write_secure_temp_file(
            "psforge_host_bootstrap",
            ".ps1",
            bootstrap_script.as_bytes(),
        )
        .map_err(|e| AppError {
            code: "SCRIPT_WRITE_FAILED".to_string(),
            message: format!("Failed to write host bootstrap script: {}", e),
        })?;

        let mut ps_args: Vec<String> = vec!["-NoLogo".to_string(), "-NoProfile".to_string()];
        if exec_policy != "Default" {
            ps_args.push("-ExecutionPolicy".to_string());
            ps_args.push(exec_policy.to_string());
        }
        ps_args.push("-File".to_string());
        ps_args.push(bootstrap_script_path.to_string_lossy().into_owned());

        let mut child = Command::new(ps_path)
            .args(ps_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| {
                let _ = std::fs::remove_file(&bootstrap_script_path);
                AppError {
                    code: "PROCESS_SPAWN_FAILED".to_string(),
                    message: format!("Failed to start PowerShell at '{}': {}", ps_path, e),
                }
            })?;

        let stdin = match child.stdin.take() {
            Some(v) => v,
            None => {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&bootstrap_script_path);
                return Err(AppError {
                    code: "PROCESS_STDIN_MISSING".to_string(),
                    message: "PowerShell process started without stdin pipe".to_string(),
                });
            }
        };
        let stdout = match child.stdout.take() {
            Some(v) => v,
            None => {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&bootstrap_script_path);
                return Err(AppError {
                    code: "PROCESS_STDOUT_MISSING".to_string(),
                    message: "PowerShell process started without stdout pipe".to_string(),
                });
            }
        };
        let stderr = match child.stderr.take() {
            Some(v) => v,
            None => {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&bootstrap_script_path);
                return Err(AppError {
                    code: "PROCESS_STDERR_MISSING".to_string(),
                    message: "PowerShell process started without stderr pipe".to_string(),
                });
            }
        };

        let (event_tx, event_rx) = mpsc::unbounded_channel::<SessionEvent>();
        let child = Arc::new(Mutex::new(Some(child)));
        let stdin_writer = Arc::new(Mutex::new(Some(stdin)));
        let output_budget = Arc::new(AtomicUsize::new(MAX_OUTPUT_LINES));
        let output_budget_warned = Arc::new(AtomicBool::new(false));

        Self::spawn_output_reader(
            stdout,
            "stdout",
            event_tx.clone(),
            output_budget.clone(),
            output_budget_warned.clone(),
        );
        Self::spawn_output_reader(
            stderr,
            "stderr",
            event_tx.clone(),
            output_budget.clone(),
            output_budget_warned.clone(),
        );
        Self::spawn_process_monitor(child.clone(), stdin_writer.clone(), event_tx.clone());

        Ok(Arc::new(PersistentSession {
            ps_path: ps_path.to_string(),
            exec_policy: exec_policy.to_string(),
            child,
            stdin_writer,
            event_rx: Arc::new(Mutex::new(event_rx)),
            output_budget,
            output_budget_warned,
            bootstrap_script_path,
        }))
    }

    async fn ensure_session(
        &self,
        ps_path: &str,
        exec_policy: &str,
    ) -> Result<Arc<PersistentSession>, AppError> {
        let existing = {
            let guard = self.session.lock().await;
            guard.clone()
        };
        if let Some(session) = existing {
            if session.ps_path.eq_ignore_ascii_case(ps_path)
                && session.exec_policy == exec_policy
                && Self::is_session_usable(&session).await
            {
                return Ok(session);
            }
        }

        self.stop().await?;
        let session = Self::start_session(ps_path, exec_policy).await?;
        let mut guard = self.session.lock().await;
        *guard = Some(session.clone());
        Ok(session)
    }

    /// Stops the active command/session and tears down the persistent process.
    pub async fn stop(&self) -> Result<(), AppError> {
        {
            let mut ks = self.kill_sender.lock().await;
            if let Some(tx) = ks.take() {
                let _ = tx.send(());
            }
        }
        {
            let mut active = self.active_command.lock().await;
            *active = None;
        }
        let session = {
            let mut guard = self.session.lock().await;
            guard.take()
        };
        if let Some(session) = session {
            info!("Stopping persistent PowerShell session");
            let _ = Self::write_session_line(&session, HOST_EXIT_MARKER).await;
            Self::shutdown_session(session).await;
        }
        Ok(())
    }

    /// Sends input to the active command's stdin (Read-Host/debugger support).
    pub async fn send_stdin(&self, input: &str) -> Result<(), AppError> {
        let is_active = {
            let active = self.active_command.lock().await;
            active.is_some()
        };
        if !is_active {
            return Err(AppError {
                code: "NO_PROCESS".to_string(),
                message: "No running process to send input to".to_string(),
            });
        }

        let session = {
            let guard = self.session.lock().await;
            guard.clone()
        }
        .ok_or_else(|| AppError {
            code: "NO_PROCESS".to_string(),
            message: "No running process to send input to".to_string(),
        })?;

        let sanitized = input.replace(['\r', '\n'], " ");
        Self::write_session_line(&session, &sanitized).await
    }

    /// Executes a PowerShell script and streams output via the provided callback.
    /// The callback receives each OutputLine as it arrives.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute<F>(
        &self,
        ps_path: &str,
        script: &str,
        working_dir: &str,
        exec_policy: &str,
        persist_runspace: bool,
        script_args: &[String],
        debug_breakpoints: Option<&[DebugBreakpointSpec]>,
        on_output: F,
    ) -> Result<i32, AppError>
    where
        F: Fn(OutputLine) + Send + Sync + 'static,
    {
        validate_ps_path(ps_path)?;
        let _exec_guard = self.execution_lock.lock().await;
        info!(
            "Executing script with persistent session {} in {}",
            ps_path, working_dir
        );
        debug!("Script size: {} bytes", script.len());
        let effective_working_dir = resolve_working_dir(working_dir);
        if !persist_runspace {
            // Force a fresh process-local runspace for this invocation.
            self.stop().await?;
        }
        let session = self.ensure_session(ps_path, exec_policy).await?;

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
        wrapper_script.push_str(
            r#"
function __psforge_coerce_arg_value {
    param([object]$Raw)
    if ($null -eq $Raw) { return $null }
    $text = [string]$Raw
    if ($text -match '^(?i)\$?true$') { return $true }
    if ($text -match '^(?i)\$?false$') { return $false }
    return $Raw
}

function __psforge_invoke_user_script {
    param([object[]]$InputArgs)

    $named = @{}
    $positional = [System.Collections.Generic.List[object]]::new()
    $i = 0
    while ($i -lt $InputArgs.Count) {
        $tokenObj = $InputArgs[$i]
        $token = if ($null -eq $tokenObj) { '' } else { [string]$tokenObj }
        if ([string]::IsNullOrWhiteSpace($token)) {
            $i++
            continue
        }

        if ($token.StartsWith('-')) {
            $body = $token.Substring(1)
            $colonIdx = $body.IndexOf(':')
            if ($colonIdx -ge 0) {
                $name = $body.Substring(0, $colonIdx).Trim()
                if ($name.Length -gt 0) {
                    $valueText = $body.Substring($colonIdx + 1)
                    $named[$name] = __psforge_coerce_arg_value $valueText
                    $i++
                    continue
                }
            } else {
                $name = $body.Trim()
                if ($name.Length -gt 0) {
                    if (($i + 1) -lt $InputArgs.Count) {
                        $named[$name] = $InputArgs[$i + 1]
                        $i += 2
                        continue
                    }
                    # Final bare switch token: treat as $true.
                    $named[$name] = $true
                    $i++
                    continue
                }
            }
        }

        $positional.Add($tokenObj)
        $i++
    }

    & $__psforge_script_path @named @positional
}
"#,
        );
        if let Some(specs) = debug_breakpoints {
            // Register debugger breakpoints. Supports line breakpoints plus
            // variable breakpoints, with optional condition/hit-count/action.
            wrapper_script.push_str("$global:__psforge_debug_scope = 0\n");
            // Use global scope so breakpoint action scriptblocks can always
            // resolve these dictionaries even when they execute in a different
            // script scope than this wrapper.
            wrapper_script.push_str("$global:__psforge_bp_hits = @{}\n");
            wrapper_script.push_str("$global:__psforge_bp_conditions = @{}\n");
            wrapper_script.push_str("$global:__psforge_bp_commands = @{}\n");

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
                    wrapper_script.push_str("$global:__psforge_bp_conditions['");
                    wrapper_script.push_str(&bp_id_ps);
                    wrapper_script.push_str("'] = '");
                    wrapper_script.push_str(&ps_single_quoted(cond));
                    wrapper_script.push_str("'\n");
                }
                if let Some(cmd_text) = command {
                    wrapper_script.push_str("$global:__psforge_bp_commands['");
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
                    "$global:__psforge_bp_hits[$__psf_id] = ([int]$global:__psforge_bp_hits[$__psf_id]) + 1; ",
                );
                if let Some(hit) = hit_count {
                    action.push_str("if ($global:__psforge_bp_hits[$__psf_id] -lt ");
                    action.push_str(&hit.to_string());
                    action.push_str(") { return } ");
                }
                action.push_str("$__psf_cond = $global:__psforge_bp_conditions[$__psf_id]; ");
                action.push_str(
                    "if ($__psf_cond) { try { if (-not (& ([scriptblock]::Create($__psf_cond)))) { return } } catch { return } } ",
                );
                action.push_str("$__psf_cmd = $global:__psforge_bp_commands[$__psf_id]; ");
                action.push_str(
                    "if ($__psf_cmd) { try { & ([scriptblock]::Create($__psf_cmd)) | Out-Null } catch {} } ",
                );
                action.push_str("Write-Host '<<PSF_DEBUG_BREAK>>");
                action.push_str(&line.unwrap_or(0).to_string());
                action.push_str("'; break");

                if let Some(line_no) = line {
                    wrapper_script
                        .push_str("Set-PSBreakpoint -Script $__psforge_script_path -Line ");
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
        wrapper_script.push_str("__psforge_invoke_user_script -InputArgs $args\n");
        std::fs::write(&wrapper_script_path, wrapper_script.as_bytes()).map_err(|e| {
            let _ = std::fs::remove_file(&user_script_path);
            AppError {
                code: "SCRIPT_WRITE_FAILED".to_string(),
                message: format!("Failed to write wrapper script to temp file: {}", e),
            }
        })?;
        let wrapper_script_path_str = wrapper_script_path.to_string_lossy().into_owned();

        // Per-run invocation script, executed by the persistent host process.
        let invoke_script_path =
            std::env::temp_dir().join(format!("psforge_invoke_{}.ps1", Uuid::new_v4()));
        let mut invoke_script = String::new();
        if exec_policy == "Default" {
            invoke_script.push_str(
                "Remove-Item Env:\\PSExecutionPolicyPreference -ErrorAction SilentlyContinue\n",
            );
        } else {
            invoke_script.push_str("$env:PSExecutionPolicyPreference = '");
            invoke_script.push_str(&ps_single_quoted(exec_policy));
            invoke_script.push_str("'\n");
        }
        invoke_script.push_str("Set-Location -LiteralPath '");
        invoke_script.push_str(&ps_single_quoted(&effective_working_dir));
        invoke_script.push_str("'\n");
        invoke_script.push_str("$__psforge_args = @(");
        for (idx, arg) in script_args.iter().enumerate() {
            if idx > 0 {
                invoke_script.push_str(", ");
            }
            invoke_script.push('\'');
            invoke_script.push_str(&ps_single_quoted(arg));
            invoke_script.push('\'');
        }
        invoke_script.push_str(")\n");
        invoke_script.push_str("& '");
        invoke_script.push_str(&ps_single_quoted(&wrapper_script_path_str));
        invoke_script.push_str("' @__psforge_args\n");
        std::fs::write(&invoke_script_path, invoke_script.as_bytes()).map_err(|e| {
            let _ = std::fs::remove_file(&user_script_path);
            let _ = std::fs::remove_file(&wrapper_script_path);
            AppError {
                code: "SCRIPT_WRITE_FAILED".to_string(),
                message: format!("Failed to write invoke script to temp file: {}", e),
            }
        })?;
        let invoke_script_path_str = invoke_script_path.to_string_lossy().into_owned();

        let command_id = Uuid::new_v4().to_string();
        let run_command = format!(
            "{}{}|{}>>",
            RUN_COMMAND_MARKER_PREFIX, command_id, invoke_script_path_str
        );
        let mut session_events = session.event_rx.lock().await;
        session
            .output_budget
            .store(MAX_OUTPUT_LINES, Ordering::Relaxed);
        session.output_budget_warned.store(false, Ordering::Relaxed);
        while session_events.try_recv().is_ok() {}
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        {
            let mut ks = self.kill_sender.lock().await;
            *ks = Some(kill_tx);
        }
        {
            let mut active = self.active_command.lock().await;
            *active = Some(command_id.clone());
        }

        if let Err(e) = Self::write_session_line(&session, &run_command).await {
            self.clear_active_state().await;
            let _ = std::fs::remove_file(&invoke_script_path);
            let _ = std::fs::remove_file(&user_script_path);
            let _ = std::fs::remove_file(&wrapper_script_path);
            return Err(e);
        }

        let mut session_terminated = false;
        let exit_code = loop {
            tokio::select! {
                _ = &mut kill_rx => {
                    break -1;
                }
                event = session_events.recv() => {
                    match event {
                        Some(SessionEvent::Output(line)) => {
                            if let Some((done_id, code)) = parse_run_complete_marker(&line.text) {
                                if done_id == command_id {
                                    break code;
                                }
                                // Marker for an unrelated command; do not surface.
                                continue;
                            }
                            on_output(line);
                        }
                        Some(SessionEvent::Exited(code)) => {
                            session_terminated = true;
                            break code;
                        }
                        None => {
                            session_terminated = true;
                            break -1;
                        }
                    }
                }
            }
        };

        self.clear_active_state().await;
        if session_terminated {
            let mut guard = self.session.lock().await;
            if guard.as_ref().is_some_and(|s| Arc::ptr_eq(s, &session)) {
                *guard = None;
            }
            let _ = std::fs::remove_file(&session.bootstrap_script_path);
        } else if !persist_runspace {
            // When persistence is disabled, terminate the host after this run.
            let session_to_stop = {
                let mut guard = self.session.lock().await;
                if guard.as_ref().is_some_and(|s| Arc::ptr_eq(s, &session)) {
                    guard.take()
                } else {
                    None
                }
            };
            if let Some(s) = session_to_stop {
                Self::shutdown_session(s).await;
            }
        }

        // Remove temp scripts now that execution has finished/interrupted.
        let _ = std::fs::remove_file(&invoke_script_path);
        let _ = std::fs::remove_file(&user_script_path);
        let _ = std::fs::remove_file(&wrapper_script_path);

        info!(
            "Script execution completed with exit code {} (persistent session)",
            exit_code
        );
        Ok(exit_code)
    }
}

impl Default for ProcessManager {
    /// Delegates to `new()` so `ProcessManager::default()` is available (Rule 2 / clippy).
    fn default() -> Self {
        Self::new()
    }
}

fn resolve_working_dir(working_dir: &str) -> String {
    let trimmed = working_dir.trim();
    if !trimmed.is_empty() {
        let candidate = PathBuf::from(trimmed);
        if candidate.is_dir() {
            return candidate.to_string_lossy().into_owned();
        }
        warn!(
            "Working directory '{}' is unavailable; falling back to current directory",
            trimmed
        );
    }
    match std::env::current_dir() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => std::env::temp_dir().to_string_lossy().into_owned(),
    }
}

/// Validates that `ps_path` points to an existing executable file.
/// Keeps checks lightweight because this is called on hot paths
/// (e.g. completions/analysis invocations).
pub fn validate_ps_path(ps_path: &str) -> Result<(), AppError> {
    let trimmed = ps_path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err(AppError {
            code: "INVALID_PS_PATH".to_string(),
            message: "PowerShell path is empty".to_string(),
        });
    }

    let path = Path::new(trimmed);
    if !path.is_file() {
        // Accept bare executable names that resolve via PATH (e.g. "pwsh.exe").
        let is_bare_command =
            !trimmed.contains('\\') && !trimmed.contains('/') && !trimmed.contains(':');
        if is_bare_command {
            let found_on_path = std::process::Command::new("where.exe")
                .arg(trimmed)
                .creation_flags(0x08000000)
                .output()
                .map(|o| {
                    o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty()
                })
                .unwrap_or(false);
            if found_on_path {
                return Ok(());
            }
        }

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
