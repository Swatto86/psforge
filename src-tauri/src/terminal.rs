/// PSForge integrated terminal module.
/// Hosts PowerShell inside a real PTY (ConPTY on Windows) and streams raw bytes
/// to xterm.js. Frontend no longer emulates prompts or line editing.
use crate::errors::AppError;
use crate::powershell::validate_ps_path;
use crate::utils::write_secure_temp_file;
use log::{debug, error, info};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
// CREATE_NO_WINDOW (0x08000000): prevents a console window from flashing when
// probing PowerShell candidates during auto-discovery.
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use tauri::{Emitter, Window};

/// Startup script loaded once per terminal process.
///
/// Responsibilities:
/// 1) Keep the existing Exchange/WAM fallback behavior for non-windowed hosts.
/// 2) Emit VS Code-style shell integration markers (OSC 633) for prompt/cwd/
///    exit-status/command metadata without using fake command sentinels.
const TERMINAL_BOOTSTRAP_SCRIPT: &str = r#"
$ErrorActionPreference = 'Continue'

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# Ensure this process has a real (hidden) Win32 console window handle.
# Some auth stacks (WAM/MSAL) call GetConsoleWindow() and fail when the
# PowerShell host is attached only to a pseudoconsole/no windowed console.
$script:PSForgeHasAuthWindowHandle = $false
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

    $script:PSForgeHasAuthWindowHandle = (
        [PSForgeNativeConsole]::GetConsoleWindow() -ne [IntPtr]::Zero
    )
} catch {
    $script:PSForgeHasAuthWindowHandle = $false
}

# Work around ExchangeOnlineManagement WAM failures when no parent window
# handle is available (for example if console allocation failed).
# Automatically add -DisableWAM unless the user already supplied it.
function global:Connect-ExchangeOnline {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [object[]]$RemainingArgs
    )

    if (-not (Microsoft.PowerShell.Core\Get-Module -Name ExchangeOnlineManagement)) {
        Microsoft.PowerShell.Core\Import-Module `
            -Name ExchangeOnlineManagement `
            -ErrorAction SilentlyContinue `
            | Out-Null
    }

    $cmdlet = Microsoft.PowerShell.Core\Get-Command `
        -Name ExchangeOnlineManagement\Connect-ExchangeOnline `
        -ErrorAction SilentlyContinue

    if (-not $cmdlet) {
        throw [System.Management.Automation.CommandNotFoundException]::new(
            "The term 'Connect-ExchangeOnline' is not recognized as a cmdlet."
        )
    }

    $hasDisableWAM = $false
    foreach ($arg in $RemainingArgs) {
        if ($arg -is [string] -and $arg.Trim().ToLower().StartsWith('-disablewam')) {
            $hasDisableWAM = $true
            break
        }
    }

    if (
        $cmdlet.Parameters.ContainsKey('DisableWAM') -and
        -not $hasDisableWAM -and
        -not $script:PSForgeHasAuthWindowHandle
    ) {
        if (-not $script:PSForgeExoDisableWamNotified) {
            [Console]::Out.WriteLine(
                "[PSForge] Applying '-DisableWAM' for Connect-ExchangeOnline in non-console host."
            )
            [Console]::Out.Flush()
            $script:PSForgeExoDisableWamNotified = $true
        }
        $RemainingArgs = @($RemainingArgs + '-DisableWAM')
    }

    & $cmdlet @RemainingArgs
}

# VS Code-style shell integration markers for rich terminal UX.
# A = prompt start, B = prompt end, D = command finished with exit code,
# E = command line submitted, P;Cwd=... = current working directory.
$global:PSForgePromptInitialised = $false
try {
    if (Get-Module -ListAvailable -Name PSReadLine) {
        Import-Module PSReadLine -ErrorAction SilentlyContinue | Out-Null
        Set-PSReadLineOption -AddToHistoryHandler {
            param([string]$line)
            $esc = [char]27
            $encodedLine = $line -replace ';', '%3B'
            [Console]::Out.Write("$esc]633;E;$encodedLine`a")
            return $true
        }
    }
} catch {
    # Shell integration is best-effort and must never break the terminal.
}

function global:prompt {
    $esc = [char]27
    $cwd = (Get-Location).Path
    $encodedCwd = $cwd -replace ';', '%3B'

    if ($global:PSForgePromptInitialised) {
        $exitCode = 0
        if ($LASTEXITCODE -is [int]) {
            $exitCode = [int]$LASTEXITCODE
        }
        if (-not $?) {
            if ($exitCode -eq 0) {
                $exitCode = 1
            }
        }
        [Console]::Out.Write("$esc]633;D;$exitCode`a")
    } else {
        $global:PSForgePromptInitialised = $true
    }

    [Console]::Out.Write("$esc]633;A`a")
    [Console]::Out.Write("$esc]633;P;Cwd=$encodedCwd`a")
    [Console]::Out.Write("$esc]633;B`a")

    return "PS $cwd> "
}
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: u64,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    session_id: u64,
    exit_code: Option<i32>,
}

/// Holds an active PTY terminal session.
struct Session {
    id: u64,
    child: Box<dyn portable_pty::Child + Send>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    bootstrap_script: PathBuf,
}

/// Global terminal session (at most one active at a time).
static TERMINAL: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

/// Monotonic id used to correlate async terminal events with the active session.
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// Returns the global terminal session mutex, initializing it on first call.
fn get_terminal() -> &'static Mutex<Option<Session>> {
    TERMINAL.get_or_init(|| Mutex::new(None))
}

/// Starts a new PTY terminal session, stopping any existing one.
///
/// Emits Tauri events:
/// - `terminal-output` with `{ sessionId, data }` UTF-8 chunks
/// - `terminal-exit` with `{ sessionId, exitCode }` when session ends
#[tauri::command]
pub async fn start_terminal(
    window: Window,
    shell_path: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u64, AppError> {
    info!(
        "start_terminal: shell_path={:?}, cols={:?}, rows={:?}",
        shell_path, cols, rows
    );

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
        validate_ps_path(&shell_path)?;
        shell_path
    };

    let pty_system = native_pty_system();
    let size = PtySize {
        rows: rows.unwrap_or(30).max(1),
        cols: cols.unwrap_or(120).max(1),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system.openpty(size).map_err(|e| AppError {
        code: "TERMINAL_PTY_OPEN_FAILED".to_string(),
        message: format!("Failed to open PTY: {}", e),
    })?;

    // Keep bootstrap logic in a temp file for reliable quoting and easier
    // maintenance across pwsh and Windows PowerShell.
    let bootstrap_script =
        write_secure_temp_file("psforge_terminal_bootstrap", ".ps1", TERMINAL_BOOTSTRAP_SCRIPT.as_bytes())
            .map_err(|e| AppError {
                code: "TERMINAL_SCRIPT_WRITE_FAILED".to_string(),
                message: format!("Failed to write terminal bootstrap script: {}", e),
            })?;
    let bootstrap_path = bootstrap_script.to_string_lossy().into_owned();

    let mut cmd = CommandBuilder::new(program.clone());
    cmd.arg("-NoLogo");
    cmd.arg("-NoProfile");
    cmd.arg("-ExecutionPolicy");
    cmd.arg("Bypass");
    cmd.arg("-NoExit");
    cmd.arg("-File");
    cmd.arg(bootstrap_path);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| AppError {
        code: "TERMINAL_SPAWN_FAILED".to_string(),
        message: format!("Failed to start '{}': {}", program, e),
    })?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| AppError {
        code: "TERMINAL_READER_INIT_FAILED".to_string(),
        message: format!("Failed to acquire PTY reader: {}", e),
    })?;

    let writer = pair.master.take_writer().map_err(|e| AppError {
        code: "TERMINAL_WRITER_INIT_FAILED".to_string(),
        message: format!("Failed to acquire PTY writer: {}", e),
    })?;

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);

    // Reader thread: forward raw PTY UTF-8 chunks directly to xterm.js.
    let win_out = window.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if let Err(e) = win_out.emit(
                        "terminal-output",
                        TerminalOutputEvent {
                            session_id,
                            data: text,
                        },
                    ) {
                        error!("Failed to emit terminal-output: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    debug!("Terminal PTY reader I/O error: {}", e);
                    break;
                }
            }
        }

        let _ = win_out.emit(
            "terminal-exit",
            TerminalExitEvent {
                session_id,
                exit_code: None,
            },
        );
        debug!("Terminal PTY reader exited (session_id={})", session_id);
    });

    let mut guard = get_terminal().lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Session {
        id: session_id,
        child,
        writer,
        master: pair.master,
        bootstrap_script,
    });

    info!("Terminal PTY session started (session_id={})", session_id);
    Ok(session_id)
}

/// Writes raw input data to the active PTY session.
#[tauri::command]
pub async fn terminal_write(data: String) -> Result<(), AppError> {
    let mut guard = get_terminal().lock().map_err(|_| AppError {
        code: "TERMINAL_LOCK_POISONED".to_string(),
        message: "Terminal session mutex was poisoned by a previous panic".to_string(),
    })?;

    let session = guard.as_mut().ok_or_else(|| AppError {
        code: "TERMINAL_NOT_RUNNING".to_string(),
        message: "No terminal session is active. Open the Terminal tab to start one.".to_string(),
    })?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| AppError {
            code: "TERMINAL_WRITE_FAILED".to_string(),
            message: format!("Failed to write to terminal: {}", e),
        })?;

    session.writer.flush().map_err(|e| AppError {
        code: "TERMINAL_FLUSH_FAILED".to_string(),
        message: format!("Failed to flush terminal input: {}", e),
    })?;

    Ok(())
}

/// Compatibility shim: submits a full command followed by Enter.
#[tauri::command]
pub async fn terminal_exec(command: String) -> Result<(), AppError> {
    terminal_write(format!("{}\r", command)).await
}

/// Resizes the active PTY to match the xterm.js viewport.
#[tauri::command]
pub async fn terminal_resize(cols: u16, rows: u16) -> Result<(), AppError> {
    let mut guard = get_terminal().lock().map_err(|_| AppError {
        code: "TERMINAL_LOCK_POISONED".to_string(),
        message: "Terminal session mutex was poisoned by a previous panic".to_string(),
    })?;

    let session = guard.as_mut().ok_or_else(|| AppError {
        code: "TERMINAL_NOT_RUNNING".to_string(),
        message: "No terminal session is active. Open the Terminal tab to start one.".to_string(),
    })?;

    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError {
            code: "TERMINAL_RESIZE_FAILED".to_string(),
            message: format!("Failed to resize terminal PTY: {}", e),
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

/// Terminates the current session by closing writer and killing the child process.
/// Safe to call when no session is active (no-op).
fn kill_session() {
    let mut guard = match get_terminal().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };

    if let Some(session) = guard.take() {
        let Session {
            id,
            mut child,
            writer,
            master: _,
            bootstrap_script,
        } = session;

        // Drop the PTY writer first so interactive shells see EOF on stdin.
        drop(writer);

        // Kill in case the process ignores EOF or is busy.
        let _ = child.kill();

        // Reap child and clean bootstrap temp file in the background.
        thread::spawn(move || {
            let _ = child.wait();
            let _ = std::fs::remove_file(&bootstrap_script);
            debug!("Terminal child process reaped (session_id={})", id);
        });
    }
}

/// Returns the best available PowerShell executable on this machine.
/// Prefers pwsh (PowerShell 7+) over legacy Windows PowerShell.
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

    // Fallback: spawn will return a descriptive error if this binary is absent.
    "powershell.exe".to_string()
}
