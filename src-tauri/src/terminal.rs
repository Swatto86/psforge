/// PSForge integrated terminal module.
/// Manages a persistent interactive PowerShell session with piped I/O.
/// Commands are sent via stdin; a sentinel marker signals completion.
use crate::errors::AppError;
use log::{debug, error, info, warn};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
// CREATE_NO_WINDOW (0x08000000): prevents a console window from flashing when
// the PowerShell child process is spawned. PSForge targets Windows only.
use std::os::windows::process::CommandExt;
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::{Emitter, Window};

/// Sentinel sent by the frontend after each command to tell the REPL to execute
/// the accumulated lines and emit the done marker.
const EXEC_SENTINEL: &str = "<<PSF_EXEC>>";

/// Sentinel emitted by the REPL script after each command completes.
const DONE_MARKER: &str = "<<PSF_CMD_DONE>>";

/// Prefix of the line emitted by the REPL script carrying the current working
/// directory after each command completes (and once on startup).
const CWD_MARKER_PREFIX: &str = "<<PSF_CWD>>";

/// The REPL PowerShell script written to a temp file at session start.
/// Using a -File launch instead of -EncodedCommand/-Command - is the only
/// reliable way to prevent PSReadLine from loading in PowerShell 7.
/// When PS is launched with -Command - it treats the session as interactive
/// and auto-loads PSReadLine, which calls $Host.UI.RawUI.CursorPosition before
/// reading any stdin -- that call throws "The handle is invalid" because there
/// is no real Win32 console (CREATE_NO_WINDOW), and the process exits.
/// With -File PS runs a non-interactive script; PSReadLine is never loaded.
const REPL_SCRIPT: &str = r#"
if (Get-Module -Name PSReadLine -ErrorAction SilentlyContinue) {
    Remove-Module -Name PSReadLine -Force -ErrorAction SilentlyContinue
}
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Emit initial working directory so the frontend path bar appears immediately.
[Console]::Out.WriteLine('<<PSF_CWD>>' + (Get-Location).Path)
[Console]::Out.Flush()

$buf = [System.Collections.Generic.List[string]]::new()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq '<<PSF_EXEC>>') {
        $script = $buf -join "`n"
        $buf.Clear()
        if ($script.Trim() -ne '') {
            try {
                . ([scriptblock]::Create($script))
            } catch {
                Write-Error $_
            }
        }
        # Emit CWD before DONE so the frontend path ref is current when the
        # terminal-done handler fires and writes the next prompt.
        [Console]::Out.WriteLine('<<PSF_CWD>>' + (Get-Location).Path)
        [Console]::Out.WriteLine('<<PSF_CMD_DONE>>')
        [Console]::Out.Flush()
    } else {
        $buf.Add($line)
    }
}
"#;

/// Maximum number of output lines emitted per terminal session (memory/IPC bound).
/// The integrated terminal is long-lived, so this prevents unbounded event emission.
const MAX_TERMINAL_LINES: usize = 100_000;

/// Holds an active terminal session.
struct Session {
    /// Child process kept alive so we can call kill() on cleanup.
    child: Child,
    /// Stdin handle for writing PS code to the session.
    stdin: ChildStdin,
    /// Temp script file path, deleted on session cleanup.
    temp_script: PathBuf,
}

// Child and ChildStdin are both Send in std, so Session is Send automatically.

/// Global terminal session (at most one active at a time).
static TERMINAL: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

/// Returns the global terminal session mutex, initialising it on first call.
fn get_terminal() -> &'static Mutex<Option<Session>> {
    TERMINAL.get_or_init(|| Mutex::new(None))
}

/// Starts a new interactive terminal session, stopping any existing one.
///
/// Spawns PowerShell with piped stdin/stdout/stderr and starts reader threads.
/// Output is forwarded to the frontend via three Tauri events:
/// - `terminal-output` (String) -- a line of stdout
/// - `terminal-stderr` (String) -- a line of stderr  
/// - `terminal-done`   (null)   -- command completed (sentinel line seen)
/// - `terminal-exit`   (null)   -- the session process has ended
#[tauri::command]
pub async fn start_terminal(window: Window, shell_path: String) -> Result<(), AppError> {
    info!("start_terminal: shell_path={:?}", shell_path);

    // Stop any existing session cleanly before starting a new one.
    kill_session();

    let program = if shell_path.is_empty() || shell_path == "auto" {
        // find_powershell() makes blocking .status() calls; run it off the
        // async runtime to avoid stalling the tokio worker thread.
        tokio::task::spawn_blocking(find_powershell)
            .await
            .map_err(|e| AppError {
                code: "PS_DISCOVERY_FAILED".to_string(),
                message: format!("PowerShell discovery task failed: {}", e),
            })?
    } else {
        shell_path.clone()
    };

    // Write the REPL script to a temp file so we can launch it with -File.
    // This avoids -EncodedCommand (opaque, error-prone base64 encoding) and
    // -Command - (triggers PSReadLine interactive mode -> "handle is invalid").
    let temp_script =
        std::env::temp_dir().join(format!("psforge_repl_{}.ps1", uuid::Uuid::new_v4()));
    std::fs::write(&temp_script, REPL_SCRIPT.as_bytes()).map_err(|e| AppError {
        code: "TERMINAL_SCRIPT_WRITE_FAILED".to_string(),
        message: format!("Failed to write REPL script to temp file: {}", e),
    })?;
    debug!("REPL script written to: {:?}", temp_script);

    let mut child = Command::new(&program)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            temp_script.to_str().unwrap_or_default(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW: suppress console flash
        .spawn()
        .map_err(|e| AppError {
            code: "TERMINAL_SPAWN_FAILED".to_string(),
            message: format!("Failed to start '{}': {}", program, e),
        })?;

    let stdin = child.stdin.take().ok_or_else(|| AppError {
        code: "TERMINAL_STDIN_MISSING".to_string(),
        message: "Failed to acquire terminal stdin handle".to_string(),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| AppError {
        code: "TERMINAL_STDOUT_MISSING".to_string(),
        message: "Failed to acquire terminal stdout handle".to_string(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| AppError {
        code: "TERMINAL_STDERR_MISSING".to_string(),
        message: "Failed to acquire terminal stderr handle".to_string(),
    })?;

    let pid = child.id();

    // Stdout reader thread: forward lines to frontend, firing terminal-done on sentinel.
    let win_out = window.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut count = 0usize;
        for line in reader.lines() {
            match line {
                Ok(text) if text == DONE_MARKER => {
                    if let Err(e) = win_out.emit("terminal-done", ()) {
                        error!("Failed to emit terminal-done: {}", e);
                    }
                }
                Ok(text) if text.starts_with(CWD_MARKER_PREFIX) => {
                    let cwd = text[CWD_MARKER_PREFIX.len()..].to_string();
                    debug!("terminal cwd: {}", cwd);
                    if let Err(e) = win_out.emit("terminal-cwd", &cwd) {
                        error!("Failed to emit terminal-cwd: {}", e);
                    }
                }
                Ok(text) => {
                    count += 1;
                    if count > MAX_TERMINAL_LINES {
                        if count == MAX_TERMINAL_LINES + 1 {
                            warn!(
                                "Terminal stdout line limit reached ({})",
                                MAX_TERMINAL_LINES
                            );
                        }
                        continue;
                    }
                    if let Err(e) = win_out.emit("terminal-output", &text) {
                        error!("Failed to emit terminal-output: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    debug!("Terminal stdout reader I/O error: {}", e);
                    break;
                }
            }
        }
        // Notify frontend the session has ended so it can update UI.
        let _ = win_out.emit("terminal-exit", ());
        debug!("Terminal stdout reader exited");
    });

    // Stderr reader thread: forward to a separate frontend channel for color differentiation.
    // Lines are also logged at error level so they appear in the Rust dev console
    // immediately -- useful for diagnosing startup crashes before the restart fires.
    let win_err = window.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut count = 0usize;
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    count += 1;
                    error!("terminal stderr: {}", text);
                    if count > MAX_TERMINAL_LINES {
                        if count == MAX_TERMINAL_LINES + 1 {
                            warn!(
                                "Terminal stderr line limit reached ({})",
                                MAX_TERMINAL_LINES
                            );
                        }
                        continue;
                    }
                    if let Err(e) = win_err.emit("terminal-stderr", &text) {
                        error!("Failed to emit terminal-stderr: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    debug!("Terminal stderr reader I/O error: {}", e);
                    break;
                }
            }
        }
    });

    // Store session for stdin access and later cleanup.
    // Use into_inner() on poison error rather than panicking, so that a
    // prior panic inside a terminal operation does not permanently brick
    // the terminal feature (the old session data is stale but harmless).
    let mut guard = get_terminal().lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Session {
        child,
        stdin,
        temp_script,
    });
    info!("Terminal session started (pid={})", pid);
    Ok(())
}

/// Sends a PS command to the active terminal session.
///
/// The command is wrapped with the sentinel marker so the frontend can detect
/// when all output for this command has been emitted.
/// Fires `terminal-output` events for each line, then `terminal-done`.
#[tauri::command]
pub async fn terminal_exec(command: String) -> Result<(), AppError> {
    debug!("terminal_exec: {:?}", command);

    let mut guard = get_terminal().lock().map_err(|_| AppError {
        code: "TERMINAL_LOCK_POISONED".to_string(),
        message: "Terminal session mutex was poisoned by a previous panic".to_string(),
    })?;

    let session = guard.as_mut().ok_or_else(|| AppError {
        code: "TERMINAL_NOT_RUNNING".to_string(),
        message: "No terminal session is active. Open the Terminal tab to start one.".to_string(),
    })?;

    // Append the exec sentinel so the REPL loop knows to execute the
    // accumulated lines and emit the done marker back to the frontend.
    // This matches the <<PSF_EXEC>> sentinel in REPL_ENCODED_COMMAND.
    let payload = format!("{command}\n{EXEC_SENTINEL}\n");

    session
        .stdin
        .write_all(payload.as_bytes())
        .map_err(|e| AppError {
            code: "TERMINAL_WRITE_FAILED".to_string(),
            message: format!("Failed to send command to terminal: {}", e),
        })?;

    session.stdin.flush().map_err(|e| AppError {
        code: "TERMINAL_FLUSH_FAILED".to_string(),
        message: format!("Failed to flush terminal stdin: {}", e),
    })?;

    Ok(())
}

/// Stops the active terminal session and cleans up the child process.
#[tauri::command]
pub async fn stop_terminal() -> Result<(), AppError> {
    info!("stop_terminal called");
    kill_session();
    Ok(())
}

/// Terminates the current session by closing stdin and killing the child process.
/// Safe to call when no session is active (no-op).
fn kill_session() {
    // Use into_inner() on poison error so a prior panic does not permanently
    // prevent session cleanup (would leak the child process).
    let mut guard = match get_terminal().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    {
        if let Some(session) = guard.take() {
            // Destructure to manage drop order explicitly.
            let Session {
                mut child,
                stdin,
                temp_script,
            } = session;
            // Close stdin: signals EOF to the REPL loop so it exits cleanly.
            drop(stdin);
            // Kill the process in case it does not exit on stdin-close alone.
            let _ = child.kill();
            // Reap the child and delete the temp script on a background thread.
            thread::spawn(move || {
                let _ = child.wait();
                let _ = std::fs::remove_file(&temp_script);
                debug!("Terminal child process reaped");
            });
        }
    }
}

/// Returns the best available PowerShell executable on this machine.
/// Prefers pwsh (PowerShell 7+) over the legacy Windows PowerShell.
fn find_powershell() -> String {
    for candidate in ["pwsh", "pwsh.exe", "powershell", "powershell.exe"] {
        if Command::new(candidate)
            .arg("-Version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW: suppress console flash
            .status()
            .is_ok()
        {
            return candidate.to_string();
        }
    }
    // Fallback: will produce a descriptive error when spawned.
    "powershell.exe".to_string()
}
