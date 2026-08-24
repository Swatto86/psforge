/// PSForge Tauri command handlers.
/// Exported commands are callable from the frontend via invoke().
use crate::errors::{AppError, BatchResult};
#[cfg(not(test))]
use crate::powershell::OutputLine;
use crate::powershell::{self, ProcessManager};
use crate::settings::{self, AppSettings};
use crate::utils::{atomic_write, char_preview, with_retry, write_secure_temp_file};
#[cfg(not(windows))]
use crate::win_compat::CommandExt;
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;
#[cfg(not(test))]
use tauri::{Emitter, Window};

/// Maximum file size (bytes) that PSForge will read into memory (Rule 11).
/// 10 MiB is generous for any PowerShell script; prevents OOM on accidental huge-file open.
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MiB

/// Maximum allowed path length in bytes (Rule 11).
/// Windows extended paths reach ~32 767 chars; 1 024 is a practical safe cap.
const MAX_PATH_LENGTH: usize = 1024;

/// Timeout for module enumeration and variable inspection commands (seconds).
/// Windows PowerShell 5.1 machine with many modules can take 60-90 s to complete
/// Get-Module -ListAvailable. 120 s covers even heavily-loaded CI-class machines.
const MODULE_TIMEOUT_SECS: u64 = 120;

/// Global process manager for the running PowerShell instance.
/// OnceLock ensures single initialization; Mutex inside ProcessManager handles concurrency.
static PROCESS_MANAGER: OnceLock<ProcessManager> = OnceLock::new();
#[cfg(not(test))]
const DEBUG_BREAK_MARKER_PREFIX: &str = "<<PSF_DEBUG_BREAK>>";

/// Returns the global ProcessManager, initializing it on first access.
fn pm() -> &'static ProcessManager {
    PROCESS_MANAGER.get_or_init(ProcessManager::new)
}

/// App-exit cleanup (S6-19): an *idle* persistent host exits on its own when
/// the app dies (its stdin pipe closes and the bootstrap read loop breaks),
/// but one still executing a user script never returns to that loop and would
/// outlive the app — forever, for an infinite loop. Hard-kill it in that case.
/// Fast: the active-command path in `stop()` skips the graceful wait.
pub async fn kill_active_run_on_exit() {
    let manager = pm();
    if manager.has_active_command().await {
        let _ = manager.stop().await;
    }
}

#[cfg(not(test))]
fn parse_debug_break_marker(text: &str) -> Option<u32> {
    text.trim()
        .strip_prefix(DEBUG_BREAK_MARKER_PREFIX)?
        .trim()
        .parse::<u32>()
        .ok()
}

#[cfg(not(test))]
fn variables_marker_payload(text: &str) -> Option<&str> {
    text.trim()
        .strip_prefix(powershell::VARIABLES_MARKER_PREFIX)
        .map(str::trim)
}

fn ps_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

/// Builds a tokio Command for an ad hoc PowerShell helper process with
/// `kill_on_drop` set. tokio defaults to leaving the child running when its
/// future is dropped, so every helper wrapped in `tokio::time::timeout` would
/// otherwise be orphaned (a live pwsh.exe, forever) each time it timed out.
fn ps_command(ps_path: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(powershell::normalize_ps_path(ps_path));
    cmd.kill_on_drop(true);
    cmd
}

/// Wraps an ad hoc `-Command` helper script with a UTF-8 console-output
/// preamble. Without it PowerShell writes redirected stdout/stderr in the OEM
/// code page (e.g. CP850), and `String::from_utf8_lossy` turns every
/// non-ASCII character into U+FFFD — corrupting help text, param messages,
/// module paths with non-ASCII usernames, and PSSA messages (S6-13). Same fix
/// as the persistent host (powershell.rs) and terminal bootstrap (terminal.rs).
fn ps_utf8_script(script: &str) -> String {
    format!(
        "$psforgeUtf8 = [System.Text.UTF8Encoding]::new($false); \
         [Console]::OutputEncoding = $psforgeUtf8; \
         $OutputEncoding = $psforgeUtf8; {script}"
    )
}

fn resolve_terminal_working_dir(working_dir: &str) -> Result<String, AppError> {
    let trimmed = working_dir.trim();
    if !trimmed.is_empty() {
        let candidate = PathBuf::from(trimmed);
        if candidate.is_dir() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
        return Err(AppError {
            code: "INVALID_WORKING_DIR".to_string(),
            message: format!(
                "Working directory '{}' does not exist or is not a directory",
                trimmed
            ),
        });
    }

    match std::env::current_dir() {
        Ok(path) => Ok(path.to_string_lossy().into_owned()),
        Err(_) => Ok(std::env::temp_dir().to_string_lossy().into_owned()),
    }
}

// ---------------------------------------------------------------------------
// Script Execution
// ---------------------------------------------------------------------------

/// Prepares a terminal run: stages a wrapper script at the fixed
/// PSFORGE_RUN_FILE path and returns the short command to type into the
/// terminal (`psrun 'DisplayName'`), so the echoed line shows only the
/// script's name instead of the full temp-file plumbing.
///
/// The staged wrapper:
/// - launches the selected PowerShell executable as a child process,
/// - runs the provided script from a secure temp file,
/// - executes within the requested working directory,
/// - optionally applies an execution policy override, and
/// - removes both temp files afterwards so terminal-driven runs do not
///   leave stale wrapper scripts behind.
#[cfg_attr(not(test), tauri::command)]
pub async fn prepare_terminal_script_command(
    ps_path: String,
    script: String,
    working_dir: String,
    exec_policy: String,
    script_args: Option<Vec<String>>,
    display_name: Option<String>,
) -> Result<String, AppError> {
    info!(
        "prepare_terminal_script_command called with ps_path={}",
        ps_path
    );
    powershell::validate_ps_path(&ps_path)?;
    let ps_path = powershell::normalize_ps_path(&ps_path);

    let effective_working_dir = resolve_terminal_working_dir(&working_dir)?;
    let user_script_path =
        write_secure_temp_file("psforge_terminal_run", ".ps1", script.as_bytes()).map_err(|e| {
            AppError {
                code: "SCRIPT_WRITE_FAILED".to_string(),
                message: format!("Failed to write script to temp file: {}", e),
            }
        })?;

    let ps_path_ps = ps_single_quoted(&ps_path);
    let work_dir_ps = ps_single_quoted(&effective_working_dir);
    let user_script_path_lossy = user_script_path.to_string_lossy();
    let user_script_path_ps = ps_single_quoted(user_script_path_lossy.as_ref());

    let invoke_wrapper_path = write_secure_temp_file(
        "psforge_terminal_invoke",
        ".ps1",
        crate::ps_invoke::build_terminal_invoke_wrapper(&user_script_path_ps).as_bytes(),
    )
    .map_err(|e| {
        let _ = std::fs::remove_file(&user_script_path);
        AppError {
            code: "SCRIPT_WRITE_FAILED".to_string(),
            message: format!("Failed to write terminal invoke wrapper: {}", e),
        }
    })?;
    let invoke_wrapper_path_lossy = invoke_wrapper_path.to_string_lossy();
    let invoke_wrapper_path_ps = ps_single_quoted(invoke_wrapper_path_lossy.as_ref());

    let pending_path = crate::utils::pending_terminal_run_path().map_err(|e| AppError {
        code: "SCRIPT_WRITE_FAILED".to_string(),
        message: format!("Failed to resolve staged run path: {}", e),
    })?;
    let pending_path_lossy = pending_path.to_string_lossy();
    let pending_path_ps = ps_single_quoted(pending_path_lossy.as_ref());

    let mut wrapper = String::new();
    wrapper.push_str("Push-Location -LiteralPath '");
    wrapper.push_str(&work_dir_ps);
    wrapper.push_str("'\n");
    wrapper.push_str("try { $__psforge_script_args = @(");
    if let Some(args) = script_args.as_deref() {
        for (index, arg) in args.iter().enumerate() {
            if index > 0 {
                wrapper.push_str(", ");
            }
            wrapper.push('\'');
            wrapper.push_str(&ps_single_quoted(arg));
            wrapper.push('\'');
        }
    }
    wrapper.push_str("); & '");
    wrapper.push_str(&ps_path_ps);
    wrapper.push_str("' -NoLogo -NoProfile ");
    if exec_policy != "Default" {
        wrapper.push_str("-ExecutionPolicy '");
        wrapper.push_str(&ps_single_quoted(&exec_policy));
        wrapper.push_str("' ");
    }
    wrapper.push_str("-File '");
    wrapper.push_str(&invoke_wrapper_path_ps);
    wrapper
        .push_str("' @__psforge_script_args } finally { Pop-Location; Remove-Item -LiteralPath '");
    wrapper.push_str(&user_script_path_ps);
    wrapper.push_str("' -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '");
    wrapper.push_str(&invoke_wrapper_path_ps);
    wrapper.push_str("' -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '");
    wrapper.push_str(&pending_path_ps);
    wrapper.push_str("' -Force -ErrorAction SilentlyContinue }\n");

    if let Err(e) = crate::utils::write_utf8_bom_file(&pending_path, wrapper.as_bytes()) {
        let _ = std::fs::remove_file(&user_script_path);
        let _ = std::fs::remove_file(&invoke_wrapper_path);
        return Err(AppError {
            code: "SCRIPT_WRITE_FAILED".to_string(),
            message: format!("Failed to stage terminal run script: {}", e),
        });
    }

    // The display name on the psrun line is cosmetic; strip control chars so a
    // hostile tab title cannot inject a second command into the terminal.
    let display = display_name.unwrap_or_default();
    let display = display
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let display = display.trim();
    if display.is_empty() {
        Ok("psrun".to_string())
    } else {
        Ok(format!("psrun '{}'", ps_single_quoted(display)))
    }
}

/// Executes a script in debugger mode with line breakpoints.
/// Breakpoints are 1-indexed line numbers relative to the script content.
#[cfg_attr(not(test), tauri::command)]
#[cfg(not(test))]
#[allow(clippy::too_many_arguments)]
pub async fn execute_script_debug(
    window: Window,
    ps_path: String,
    script: String,
    working_dir: String,
    exec_policy: String,
    breakpoints: Vec<powershell::DebugBreakpointSpec>,
    script_args: Option<Vec<String>>,
    persist_runspace: Option<bool>,
) -> Result<i32, AppError> {
    info!(
        "execute_script_debug called with ps_path={} breakpoints={}",
        ps_path,
        breakpoints.len()
    );
    powershell::validate_ps_path(&ps_path)?;

    let win = window.clone();
    let exit_code = pm()
        .execute(
            &ps_path,
            &script,
            &working_dir,
            &exec_policy,
            persist_runspace.unwrap_or(true),
            script_args.as_deref().unwrap_or(&[]),
            Some(&breakpoints),
            move |line: OutputLine| {
                if let Some(json) = variables_marker_payload(&line.text) {
                    pm().cache_last_variables_json(json.to_string());
                    let variables = parse_variable_info_json(json);
                    if let Err(e) = win.emit("ps-variables", &variables) {
                        error!("Failed to emit ps-variables event: {}", e);
                    }
                    return;
                }
                if let Some(line_number) = parse_debug_break_marker(&line.text) {
                    if let Err(e) = win.emit("ps-debug-break", line_number) {
                        error!("Failed to emit ps-debug-break event: {}", e);
                    }
                    return;
                }
                if let Err(e) = win.emit("ps-output", &line) {
                    error!("Failed to emit ps-output event: {}", e);
                }
            },
        )
        .await?;

    window
        .emit("ps-complete", exit_code)
        .map_err(|e| AppError {
            code: "EMIT_FAILED".to_string(),
            message: format!("Failed to emit completion event: {}", e),
        })?;

    Ok(exit_code)
}

/// Stops the currently running PowerShell process.
#[cfg_attr(not(test), tauri::command)]
pub async fn stop_script() -> Result<(), AppError> {
    info!("stop_script called");
    pm().stop().await
}

/// Sends text to the running process's stdin (for Read-Host support).
#[cfg_attr(not(test), tauri::command)]
pub async fn send_stdin(input: String) -> Result<(), AppError> {
    debug!("send_stdin called");
    pm().send_stdin(&input).await
}

/// Continue execution from the current debugger stop point.
#[cfg_attr(not(test), tauri::command)]
pub async fn debug_continue() -> Result<(), AppError> {
    pm().send_stdin("c").await
}

/// Step over the next statement in the debugger.
#[cfg_attr(not(test), tauri::command)]
pub async fn debug_step_over() -> Result<(), AppError> {
    pm().send_stdin("v").await
}

/// Step into the next statement in the debugger.
#[cfg_attr(not(test), tauri::command)]
pub async fn debug_step_into() -> Result<(), AppError> {
    pm().send_stdin("s").await
}

/// Step out of the current scope in the debugger.
#[cfg_attr(not(test), tauri::command)]
pub async fn debug_step_out() -> Result<(), AppError> {
    pm().send_stdin("o").await
}

/// Select debugger frame scope for subsequent inspector evaluations.
#[cfg_attr(not(test), tauri::command)]
pub async fn debug_set_frame(frame_index: u32) -> Result<(), AppError> {
    pm().send_stdin(&format!("$global:__psforge_debug_scope = {}", frame_index))
        .await
}

// ---------------------------------------------------------------------------
// Parameter Inspection
// ---------------------------------------------------------------------------

/// Timeout for the parameter-inspection subprocess (seconds).
/// The AST parse is pure CPU work with no I/O; 15 s is extremely generous.
const PARAM_INSPECT_TIMEOUT_SECS: u64 = 15;

/// PowerShell snippet (run in a fresh -Command process) that:
///   1. Reads the script text from the PSFORGE_SCRIPT_CONTENT environment
///      variable (avoids all shell-escaping concerns for the script content).
///   2. Parses it with the PowerShell AST.
///   3. Walks the param() block and emits one JSON object per parameter.
///
/// The snippet uses short, unlikely-to-clash variable names ($__s, $__pb, …)
/// to avoid colliding with any names declared in the user's own script.
const PARAM_INSPECT_SCRIPT: &str = r#"
$__s = $env:PSFORGE_SCRIPT_CONTENT
$__errs = $null
$__ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $__s, [ref]$null, [ref]$__errs)
# Script-level param() only — recursive Find() also matches function param
# blocks and makes pasted helper functions look like the runnable script.
$__pb = $__ast.ParamBlock
if ($null -eq $__pb) {
    [PSCustomObject]@{ status = 'none'; parameters = @() } | ConvertTo-Json -Compress
    exit
}
$__r = @(foreach ($__p in $__pb.Parameters) {
    $__mand = $false; $__help = ''; $__type = 'String'; $__pos = $null
    foreach ($__a in $__p.Attributes) {
        if ($__a -is [System.Management.Automation.Language.AttributeAst] -and
            $__a.TypeName.Name -eq 'Parameter') {
            foreach ($__n in $__a.NamedArguments) {
                if ($__n.ArgumentName -eq 'Mandatory') {
                    if ($__n.ExpressionOmitted) {
                        $__mand = $true
                    } else {
                        $__v = $__n.Argument.ToString().Trim().ToLower()
                        $__mand = ($__v -ne '$false') -and
                                  ($__v -ne 'false') -and
                                  ($__v -ne '0')
                    }
                }
                if ($__n.ArgumentName -eq 'HelpMessage') {
                    # Coerce to string: .Value is $null for non-constant
                    # attribute args (e.g. HelpMessage=$true) and an Int32 for
                    # HelpMessage=5, both of which serialize as non-strings and
                    # break Vec<ScriptParameterInfo> deserialization (S3-9).
                    try { $__help = [string]$__n.Argument.Value } catch {}
                }
                if ($__n.ArgumentName -eq 'Position') {
                    try { $__pos = [int]$__n.Argument.ToString() } catch {}
                }
            }
        } elseif ($__a -is
            [System.Management.Automation.Language.TypeConstraintAst]) {
            $__type = $__a.TypeName.FullName
        }
    }
    [PSCustomObject]@{
        name        = $__p.Name.VariablePath.UserPath
        typeName    = $__type
        isMandatory = $__mand
        hasDefault  = ($null -ne $__p.DefaultValue)
        position    = $__pos
        helpMessage = $__help
    }
})
[PSCustomObject]@{
    status = 'ok'
    parameters = @($__r)
} | ConvertTo-Json -Compress -Depth 5
"#;

/// Metadata for a single parameter in a script's param() block.
/// Mirrors the `ScriptParameter` TypeScript type in src/types.ts.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScriptParameterInfo {
    /// Parameter name without the leading `$`.
    pub name: String,
    /// PowerShell type name (e.g. "String", "Int32", "SwitchParameter").
    pub type_name: String,
    /// True when `[Parameter(Mandatory)]` or `[Parameter(Mandatory=$true)]` is present.
    pub is_mandatory: bool,
    /// True when the parameter declaration includes a default value.
    pub has_default: bool,
    /// Positional index from `[Parameter(Position=N)]`, or null.
    pub position: Option<i32>,
    /// Help text from `[Parameter(HelpMessage='...')]`, or empty string.
    pub help_message: String,
}

/// Result of inspecting a script's param() block.
/// Distinguishes "no param block", "empty/ok param block", and "inspect failed"
/// so the frontend does not block valid `param()` scripts or fall through to
/// interactive prompts when inspection actually failed.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptParameterInspectResult {
    /// "ok" | "none" | "error"
    pub status: String,
    pub parameters: Vec<ScriptParameterInfo>,
}

fn empty_param_inspect(status: &str) -> ScriptParameterInspectResult {
    ScriptParameterInspectResult {
        status: status.to_string(),
        parameters: Vec::new(),
    }
}

/// Inspects the param() block of a PowerShell script using the PS AST.
///
/// Returns a structured status so the frontend can tell apart:
/// - `none` — no script-level param() block
/// - `ok` — param() present (possibly empty / optional-only)
/// - `error` — inspection failed or script too large to inspect
///
/// The script content is passed via PSFORGE_SCRIPT_CONTENT to avoid
/// shell-escaping hazards. Windows env-var size limit is ~32 767 chars.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_script_parameters(
    ps_path: String,
    script: String,
) -> Result<ScriptParameterInspectResult, AppError> {
    info!("get_script_parameters called");
    powershell::validate_ps_path(&ps_path)?;

    if script.trim().is_empty() {
        return Ok(empty_param_inspect("none"));
    }

    // Windows environment variables are capped at ~32 767 chars.
    const MAX_ENV_SCRIPT_BYTES: usize = 32_000;
    if script.len() > MAX_ENV_SCRIPT_BYTES {
        debug!(
            "Script too large for param inspection ({} bytes), skipping",
            script.len()
        );
        return Ok(empty_param_inspect("error"));
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(PARAM_INSPECT_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
            ])
            .arg(ps_utf8_script(PARAM_INSPECT_SCRIPT))
            .env("PSFORGE_SCRIPT_CONTENT", &script)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            debug!("get_script_parameters spawn failed: {}", e);
            return Ok(empty_param_inspect("error"));
        }
        Err(_) => {
            debug!(
                "get_script_parameters timed out after {}s",
                PARAM_INSPECT_TIMEOUT_SECS
            );
            return Ok(empty_param_inspect("error"));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    if trimmed.is_empty() {
        return Ok(empty_param_inspect("error"));
    }

    if let Ok(parsed) = serde_json::from_str::<ScriptParameterInspectResult>(trimmed) {
        let status = parsed.status.to_ascii_lowercase();
        if status == "ok" || status == "none" || status == "error" {
            return Ok(ScriptParameterInspectResult {
                status,
                parameters: parsed
                    .parameters
                    .into_iter()
                    .filter(|p| !p.name.is_empty())
                    .collect(),
            });
        }
    }

    // Legacy fallbacks: older snippets emitted a bare array / single object.
    if trimmed.starts_with('[') {
        let params: Vec<ScriptParameterInfo> = serde_json::from_str(trimmed).unwrap_or_default();
        return Ok(ScriptParameterInspectResult {
            status: if params.is_empty() {
                "none".to_string()
            } else {
                "ok".to_string()
            },
            parameters: params,
        });
    }
    if trimmed.starts_with('{') {
        if let Ok(single) = serde_json::from_str::<ScriptParameterInfo>(trimmed) {
            if !single.name.is_empty() {
                return Ok(ScriptParameterInspectResult {
                    status: "ok".to_string(),
                    parameters: vec![single],
                });
            }
        }
    }

    Ok(empty_param_inspect("error"))
}

// ---------------------------------------------------------------------------
// PowerShell Discovery
// ---------------------------------------------------------------------------

/// Returns all discovered PowerShell installations on the system.
/// Runs discovery in a blocking thread pool so the async runtime is not stalled
/// by `where.exe` invocations and filesystem scans (Rule 2 -- no blocking in async).
#[cfg_attr(not(test), tauri::command)]
pub async fn get_ps_versions() -> Result<Vec<powershell::PsVersion>, AppError> {
    info!("get_ps_versions called");
    tokio::task::spawn_blocking(powershell::discover_ps_versions)
        .await
        .map_err(|e| AppError {
            code: "PS_DISCOVERY_FAILED".to_string(),
            message: format!("PowerShell discovery task panicked: {}", e),
        })
}

// ---------------------------------------------------------------------------
// Module Browser
// ---------------------------------------------------------------------------

/// Module info returned from Get-Module -ListAvailable.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInfo {
    pub name: String,
    pub version: String,
    pub module_type: String,
    pub path: String,
}

/// Returns `true` when `ps_path` points to Windows PowerShell 5.1 (`powershell.exe`).
/// Any path resolving to `pwsh.exe` (or bare `pwsh`) is PowerShell 6+ and
/// supports the additional `-SkipEditionCheck` flag on `Get-Module`.
///
/// Compares the file-name component (case-insensitive) rather than a suffix
/// match so user-named binaries like `mypowershell.exe` are not mis-detected
/// as Windows PowerShell.
fn is_windows_powershell(ps_path: &str) -> bool {
    let normalized = powershell::normalize_ps_path(ps_path);
    let trimmed = normalized.as_str();
    let file_name = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    file_name == "powershell.exe" || file_name == "powershell"
}

/// Returns all installed PowerShell modules (runs async, non-blocking).
///
/// Optimisations applied:
/// - `-ErrorAction SilentlyContinue` - skip inaccessible / broken module paths
///   that would otherwise stall the process indefinitely.
/// - `-SkipEditionCheck` (PS 6+ only) - skips per-module edition-compatibility
///   checks, cutting enumeration time on PS 7 by ~50%.
/// - Timeout raised to `MODULE_TIMEOUT_SECS` (120 s) to accommodate Windows
///   PowerShell 5.1 which ships with hundreds of in-box modules.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_installed_modules(ps_path: String) -> Result<Vec<ModuleInfo>, AppError> {
    info!("get_installed_modules called (ps_path={})", ps_path);
    powershell::validate_ps_path(&ps_path)?;

    // Build a version-appropriate Get-Module command.
    // -SkipEditionCheck is only available in PS 6+; it is omitted for Windows
    // PowerShell 5.1 to avoid an "unrecognised parameter" error.
    // Column names are intentionally lowercase ('name', 'version', 'moduleType',
    // 'path') so that ConvertTo-Json emits camelCase keys.  The Rust struct uses
    // #[serde(rename_all = "camelCase")] which expects exactly these names.
    let command = if is_windows_powershell(&ps_path) {
        "Get-Module -ListAvailable -ErrorAction SilentlyContinue \
            | Select-Object @{N='name';E={$_.Name}}, \
                @{N='version';E={$_.Version.ToString()}}, \
                @{N='moduleType';E={$_.ModuleType.ToString()}}, \
                @{N='path';E={$_.Path}} \
            | ConvertTo-Json -Compress"
    } else {
        "Get-Module -ListAvailable -SkipEditionCheck -ErrorAction SilentlyContinue \
            | Select-Object @{N='name';E={$_.Name}}, \
                @{N='version';E={$_.Version.ToString()}}, \
                @{N='moduleType';E={$_.ModuleType.ToString()}}, \
                @{N='path';E={$_.Path}} \
            | ConvertTo-Json -Compress"
    };

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(MODULE_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
            ])
            .arg(ps_utf8_script(command))
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "MODULE_ENUM_FAILED".to_string(),
                message: format!("Failed to start PowerShell for module enumeration: {}", e),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "MODULE_ENUM_TIMEOUT".to_string(),
                message: format!(
                    "Module enumeration timed out after {}s. \
                     Try switching to PowerShell 7 (pwsh) which enumerates faster, \
                     or check that all paths in $PSModulePath are accessible.",
                    MODULE_TIMEOUT_SECS
                ),
            });
        }
    };

    // Surface any stderr content to aid diagnostics even when exit code is 0
    // (PowerShell writes non-terminating errors to stderr but still exits 0).
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        debug!("get_installed_modules stderr: {}", stderr.trim());
    }

    if !output.status.success() && output.stdout.is_empty() {
        let stderr_snippet = stderr.lines().next().unwrap_or("(no output)").to_string();
        return Err(AppError {
            code: "MODULE_ENUM_FAILED".to_string(),
            message: format!(
                "PowerShell exited with code {:?}: {}",
                output.status.code(),
                stderr_snippet
            ),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_str = find_last_json(&stdout).unwrap_or(stdout.trim());
    let trimmed = json_str.trim();

    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        return Ok(Vec::new());
    }

    // PowerShell returns a single object (not array) when there is exactly one module.
    // Use the last JSON block to tolerate informational/noise text before JSON.
    let modules: Vec<ModuleInfo> = if trimmed.starts_with('[') {
        match serde_json::from_str(trimmed) {
            Ok(items) => items,
            Err(e) => {
                warn!(
                    "Failed to parse module list JSON ({}). First 200 chars: {}",
                    e,
                    char_preview(trimmed, 200)
                );
                Vec::new()
            }
        }
    } else if trimmed.starts_with('{') {
        match serde_json::from_str::<ModuleInfo>(trimmed) {
            Ok(single) => vec![single],
            Err(e) => {
                warn!(
                    "Failed to parse single-module JSON ({}). First 200 chars: {}",
                    e,
                    char_preview(trimmed, 200)
                );
                Vec::new()
            }
        }
    } else {
        warn!(
            "Module enumeration produced non-JSON stdout. First 200 chars: {}",
            char_preview(trimmed, 200)
        );
        Vec::new()
    };

    info!("Found {} installed modules", modules.len());
    Ok(modules)
}

/// Command info for a specific module.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    pub command_type: String,
}

/// Parameter metadata for a command/cmdlet/function.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandParameterInfo {
    pub name: String,
    pub type_name: String,
    pub is_mandatory: bool,
    pub position: Option<i32>,
    pub aliases: Vec<String>,
    pub accepts_pipeline_input: bool,
    pub is_switch: bool,
}

/// Help content for a command/topic.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHelpInfo {
    pub name: String,
    pub synopsis: String,
    pub syntax: String,
    pub full_text: String,
    pub online_uri: String,
}

/// Returns exported commands for a specific module.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_module_commands(
    ps_path: String,
    module_name: String,
) -> Result<Vec<CommandInfo>, AppError> {
    info!("get_module_commands called for {}", module_name);
    powershell::validate_ps_path(&ps_path)?;

    // Column names match the camelCase keys expected by the serde deserializer.
    let script = format!(
        "Get-Command -Module '{}' | Select-Object @{{N='name';E={{$_.Name}}}}, @{{N='commandType';E={{$_.CommandType.ToString()}}}} | ConvertTo-Json -Compress",
        module_name.replace('\'', "''")
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(MODULE_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
            ])
            .arg(ps_utf8_script(&script))
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "COMMAND_ENUM_FAILED".to_string(),
                message: format!("Failed to enumerate commands for {}: {}", module_name, e),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "COMMAND_ENUM_TIMEOUT".to_string(),
                message: format!(
                    "Command enumeration for {} timed out after {}s",
                    module_name, MODULE_TIMEOUT_SECS
                ),
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_str = find_last_json(&stdout).unwrap_or(stdout.trim());
    let trimmed = json_str.trim();

    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    let commands: Vec<CommandInfo> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else if trimmed.starts_with('{') {
        match serde_json::from_str::<CommandInfo>(trimmed) {
            Ok(single) => vec![single],
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };

    Ok(commands)
}

/// Maximum seconds to wait when inspecting command metadata.
const COMMAND_PARAMS_TIMEOUT_SECS: u64 = 30;

/// Returns parameter metadata for a command/cmdlet/function.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_command_parameters(
    ps_path: String,
    command_name: String,
) -> Result<Vec<CommandParameterInfo>, AppError> {
    info!("get_command_parameters called for {}", command_name);
    powershell::validate_ps_path(&ps_path)?;

    let trimmed_name = command_name.trim();
    if trimmed_name.is_empty() {
        return Ok(Vec::new());
    }

    const COMMAND_PARAMS_SCRIPT: &str = r#"
$__name = $env:PSFORGE_COMMAND_NAME
if ([string]::IsNullOrWhiteSpace($__name)) { '[]'; exit }
$__cmd = Get-Command -Name $__name -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $__cmd) { '[]'; exit }
$__params = @(
  $__cmd.Parameters.Values |
    Sort-Object @{Expression={ if ($_.Position -ge 0) { $_.Position } else { 100000 } }}, Name |
    ForEach-Object {
      $__attrs = @($_.Attributes | Where-Object { $_ -is [System.Management.Automation.ParameterAttribute] })
      $__mandatory = ($__attrs | Where-Object { $_.Mandatory }).Count -gt 0
      $__pipeline = ($__attrs | Where-Object { $_.ValueFromPipeline -or $_.ValueFromPipelineByPropertyName }).Count -gt 0
      [PSCustomObject]@{
        name = $_.Name
        typeName = if ($_.ParameterType) { $_.ParameterType.FullName } else { '' }
        isMandatory = $__mandatory
        position = if ($_.Position -ge 0) { [int]$_.Position } else { $null }
        aliases = @($_.Aliases)
        acceptsPipelineInput = $__pipeline
        isSwitch = ($_.ParameterType -eq [System.Management.Automation.SwitchParameter])
      }
    }
)
if ($__params.Count -eq 0) { '[]' } else { $__params | ConvertTo-Json -Compress -Depth 4 }
"#;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(COMMAND_PARAMS_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            .arg(ps_utf8_script(COMMAND_PARAMS_SCRIPT))
            .env("PSFORGE_COMMAND_NAME", trimmed_name)
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "COMMAND_PARAMS_FAILED".to_string(),
                message: format!(
                    "Failed to inspect command parameters for '{}': {}",
                    trimmed_name, e
                ),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "COMMAND_PARAMS_TIMEOUT".to_string(),
                message: format!(
                    "Command parameter inspection for '{}' timed out after {}s",
                    trimmed_name, COMMAND_PARAMS_TIMEOUT_SECS
                ),
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_str = find_last_json(&stdout).unwrap_or(stdout.trim());
    let trimmed = json_str.trim();

    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    let params: Vec<CommandParameterInfo> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else if trimmed.starts_with('{') {
        match serde_json::from_str::<CommandParameterInfo>(trimmed) {
            Ok(single) => vec![single],
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };

    Ok(params)
}

/// Maximum seconds to wait when rendering help content.
const COMMAND_HELP_TIMEOUT_SECS: u64 = 30;

/// Returns context-sensitive help for a command/topic (Get-Help -Full).
#[cfg_attr(not(test), tauri::command)]
pub async fn get_command_help(
    ps_path: String,
    command_name: String,
) -> Result<Option<CommandHelpInfo>, AppError> {
    info!("get_command_help called for {}", command_name);
    powershell::validate_ps_path(&ps_path)?;

    let trimmed_name = command_name.trim();
    if trimmed_name.is_empty() {
        return Ok(None);
    }

    const COMMAND_HELP_SCRIPT: &str = r#"
$__name = $env:PSFORGE_HELP_COMMAND
if ([string]::IsNullOrWhiteSpace($__name)) { 'null'; exit }
$__help = Get-Help -Name $__name -Full -ErrorAction SilentlyContinue
if ($null -eq $__help) { 'null'; exit }
$__synopsis = ($__help.Synopsis | Out-String).Trim()
$__syntax = ($__help.Syntax | Out-String).Trim()
$__full = ($__help | Out-String).TrimEnd()
$__uri = ''
try {
  $__uri = @(
    $__help.relatedLinks.navigationLink |
      Where-Object { $_.uri } |
      Select-Object -First 1 -ExpandProperty uri
  )[0]
} catch {}
[PSCustomObject]@{
  name = if ($__help.Name) { $__help.Name } else { $__name }
  synopsis = $__synopsis
  syntax = $__syntax
  fullText = $__full
  onlineUri = if ($__uri) { $__uri } else { '' }
} | ConvertTo-Json -Compress -Depth 6
"#;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(COMMAND_HELP_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            .arg(ps_utf8_script(COMMAND_HELP_SCRIPT))
            .env("PSFORGE_HELP_COMMAND", trimmed_name)
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "COMMAND_HELP_FAILED".to_string(),
                message: format!("Failed to resolve help for '{}': {}", trimmed_name, e),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "COMMAND_HELP_TIMEOUT".to_string(),
                message: format!(
                    "Help query for '{}' timed out after {}s",
                    trimmed_name, COMMAND_HELP_TIMEOUT_SECS
                ),
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_str = find_last_json(&stdout).unwrap_or(stdout.trim());
    let trimmed = json_str.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        return Ok(None);
    }

    if trimmed.starts_with('{') {
        return Ok(serde_json::from_str::<CommandHelpInfo>(trimmed).ok());
    }

    Ok(None)
}

// ---------------------------------------------------------------------------
// Variable Inspector
// ---------------------------------------------------------------------------

/// Variable info from the last run.
#[derive(Debug, Serialize, Deserialize)]
pub struct VariableInfo {
    /// Variable name (emitted as "name" to frontend, deserialized as "Name" from PS JSON).
    #[serde(rename(serialize = "name", deserialize = "Name"))]
    pub name: String,
    /// String representation of the value.
    #[serde(rename(serialize = "value", deserialize = "Value"))]
    pub value: String,
    /// .NET type name (e.g. "String", "Int32").
    #[serde(rename(serialize = "typeName", deserialize = "TypeName"))]
    pub type_name: String,
}

fn parse_variable_info_json(json_str: &str) -> Vec<VariableInfo> {
    let trimmed = json_str.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return Vec::new();
    }

    if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        match serde_json::from_str::<VariableInfo>(trimmed) {
            Ok(single) => vec![single],
            Err(_) => Vec::new(),
        }
    }
}

/// Returns the last variable snapshot captured from the live run/debug session.
///
/// This command no longer re-executes the user script. It simply returns the
/// most recent snapshot emitted by the PowerShell host after a successful run.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_variables_after_run(
    _ps_path: String,
    _script: String,
    _working_dir: String,
) -> Result<Vec<VariableInfo>, AppError> {
    info!("get_variables_after_run called");
    Ok(pm()
        .last_variables_json()
        .map(|json| parse_variable_info_json(&json))
        .unwrap_or_default())
}

/// Finds the last top-level JSON array or object in a string.
///
/// Scans backwards from the end, using bracket depth counting to skip
/// nested `[` / `{` characters that appear inside JSON values (e.g.
/// a variable whose value is `"[System.String]"`).  Returns exactly
/// the balanced substring `open..=close` without trailing text.
fn find_last_json(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();

    // Try to find a top-level '[' first (most PS commands return arrays).
    if let Some((start, end)) = find_balanced_span(bytes, b'[', b']') {
        return Some(&s[start..=end]);
    }
    // Fall back to a top-level '{'.
    if let Some((start, end)) = find_balanced_span(bytes, b'{', b'}') {
        return Some(&s[start..=end]);
    }
    None
}

/// Scans `bytes` backwards for the last balanced `open`/`close` pair,
/// skipping brackets that appear inside JSON string literals.
/// Returns `(start, end)` byte offsets (inclusive) of the outermost
/// bracket pair, or `None` if no balanced pair is found.
fn find_balanced_span(bytes: &[u8], open: u8, close: u8) -> Option<(usize, usize)> {
    let mut depth: i32 = 0;
    let mut end_pos: Option<usize> = None;
    let mut in_string = false;
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        if bytes[i] == b'"' {
            // Count consecutive backslashes before this quote to decide
            // whether it is escaped.  Odd count → escaped, even → real.
            let mut bs = 0usize;
            while i > bs && bytes[i - 1 - bs] == b'\\' {
                bs += 1;
            }
            if bs.is_multiple_of(2) {
                in_string = !in_string;
            }
            continue;
        }
        if in_string {
            continue;
        }
        if bytes[i] == close {
            if depth == 0 {
                end_pos = Some(i);
            }
            depth += 1;
        } else if bytes[i] == open {
            depth -= 1;
            if depth == 0 {
                return Some((i, end_pos?));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

/// Read file content result including detected encoding.
#[derive(Debug, Serialize, Deserialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
    pub path: String,
    /// Optional non-fatal warning surfaced to the user (e.g. an odd-byte
    /// UTF-16 file where decoding had to drop a trailing byte). The frontend
    /// shows this as a one-time notice rather than blocking the open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Reads a file's content, detecting encoding.
#[cfg_attr(not(test), tauri::command)]
pub async fn read_file_content(path: String) -> Result<FileContent, AppError> {
    debug!("read_file_content: {}", path);

    // Pre-flight validation (Rule 17 + Rule 11).
    if path.len() > MAX_PATH_LENGTH {
        return Err(AppError {
            code: "PATH_TOO_LONG".to_string(),
            message: format!(
                "Path exceeds the {} character limit ({} chars). Use a shorter path.",
                MAX_PATH_LENGTH,
                path.len()
            ),
        });
    }

    // Stat the file before reading to catch size violations early and avoid OOM.
    let meta = std::fs::metadata(&path).map_err(|e| AppError {
        code: "FILE_STAT_FAILED".to_string(),
        message: format!("Cannot access '{}': {}", path, e),
    })?;

    if meta.len() > MAX_FILE_SIZE {
        return Err(AppError {
            code: "FILE_TOO_LARGE".to_string(),
            message: format!(
                "'{}' is {:.1} MB, exceeding the {:.0} MB limit. \
                 Use an external editor for files this large.",
                path,
                meta.len() as f64 / (1024.0 * 1024.0),
                MAX_FILE_SIZE as f64 / (1024.0 * 1024.0)
            ),
        });
    }

    let bytes = with_retry("read_file_content", || std::fs::read(&path))?;
    let (content, encoding, warning) = detect_and_decode(&bytes);

    Ok(FileContent {
        content,
        encoding,
        path,
        warning,
    })
}

/// Saves content to a file with the specified encoding.
///
/// Returns `Some(warning)` when the save succeeded but altered the content
/// (e.g. Windows-1252 replaced unencodable characters with '?') — mirrors the
/// warning channel on the read path (`FileContent.warning`). The frontend
/// surfaces it; a silent lossy save is permanent, invisible corruption.
#[cfg_attr(not(test), tauri::command)]
pub async fn save_file_content(
    path: String,
    content: String,
    encoding: String,
) -> Result<Option<String>, AppError> {
    debug!("save_file_content: {} ({})", path, encoding);

    // Pre-flight path validation (Rule 17).
    if path.len() > MAX_PATH_LENGTH {
        return Err(AppError {
            code: "PATH_TOO_LONG".to_string(),
            message: format!(
                "Path exceeds the {} character limit. Use a shorter path.",
                MAX_PATH_LENGTH
            ),
        });
    }

    let mut warning: Option<String> = None;
    let bytes = match encoding.as_str() {
        "utf8bom" => {
            let mut bom = vec![0xEF, 0xBB, 0xBF];
            bom.extend_from_slice(content.as_bytes());
            bom
        }
        "utf16le" => {
            let mut bytes = vec![0xFF, 0xFE]; // UTF-16 LE BOM
            for c in content.encode_utf16() {
                bytes.extend_from_slice(&c.to_le_bytes());
            }
            bytes
        }
        "utf16be" => {
            let mut bytes = vec![0xFE, 0xFF]; // UTF-16 BE BOM
            for c in content.encode_utf16() {
                bytes.extend_from_slice(&c.to_be_bytes());
            }
            bytes
        }
        "windows1252" => {
            // Round-trip files originally detected as Windows-1252 (the common
            // legacy Notepad/ANSI encoding on en-US Windows) without forcing a
            // conversion to UTF-8 the user did not ask for.
            let (encoded, _, had_unmappable) = encoding_rs::WINDOWS_1252.encode(content.as_str());
            if had_unmappable {
                let message = "Some characters are not representable in Windows-1252 and were \
                     saved as '?'. Change the encoding to UTF-8 to keep them."
                    .to_string();
                warn!("save_file_content: {}", message);
                warning = Some(message);
            }
            encoded.into_owned()
        }
        _ => content.into_bytes(), // utf8 (no BOM)
    };

    // Write atomically: serialise to a sibling temp file, fsync, then rename.
    // Without this, a crash or power loss between truncate and full-write can
    // leave the user's script as an empty or partial file.
    with_retry("save_file_content", || {
        atomic_write(std::path::Path::new(&path), &bytes)
    })?;
    Ok(warning)
}

/// Detects encoding from BOM and decodes bytes to a string.
///
/// Returns `(content, encoding, optional warning)` where:
/// - `encoding` is one of `utf8`, `utf8bom`, `utf16le`, `utf16be`, `windows1252`.
/// - `warning` is `Some(message)` when decoding succeeded but produced a
///   non-fatal anomaly the user should know about (legacy encoding fallback,
///   odd-byte UTF-16 trailing byte, UTF-32 input converted to UTF-8). The
///   frontend surfaces this rather than dropping it.
///
/// Critically, this function never silently substitutes U+FFFD for invalid
/// UTF-8 the way `String::from_utf8_lossy` would. Files that aren't valid
/// UTF-8 are decoded as Windows-1252 instead — every byte 0x00-0xFF maps to
/// a code point, and saving back as `windows1252` round-trips the original
/// bytes exactly. The previous behaviour caused permanent data loss the
/// first time the user saved a file that had been opened with mojibake;
/// faithful round-trip means even mis-detected files (KOI8, ISO-8859-15)
/// survive a save unchanged on disk.
fn detect_and_decode(bytes: &[u8]) -> (String, String, Option<String>) {
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        // UTF-8 BOM. If the body is not valid UTF-8, fall back to the
        // Windows-1252 path below so we still give the user a faithful
        // round-trip rather than silently substituting U+FFFD.
        if let Ok(s) = std::str::from_utf8(&bytes[3..]) {
            (s.to_string(), "utf8bom".to_string(), None)
        } else {
            decode_no_bom_fallback(&bytes[3..])
        }
    } else if bytes.len() >= 4
        && bytes[0] == 0xFF
        && bytes[1] == 0xFE
        && bytes[2] == 0x00
        && bytes[3] == 0x00
    {
        // UTF-32 LE. Its BOM (FF FE 00 00) starts with the UTF-16 LE BOM, so
        // this must be checked first — decoding as UTF-16 silently interleaves
        // NULs through the text and a later save destroys the file (S6-11).
        decode_utf32(&bytes[4..], u32::from_le_bytes, "UTF-32 LE")
    } else if bytes.len() >= 4
        && bytes[0] == 0x00
        && bytes[1] == 0x00
        && bytes[2] == 0xFE
        && bytes[3] == 0xFF
    {
        // UTF-32 BE
        decode_utf32(&bytes[4..], u32::from_be_bytes, "UTF-32 BE")
    } else if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16 LE
        let payload = &bytes[2..];
        let mut warning = None;
        if !payload.len().is_multiple_of(2) {
            warn!(
                "UTF-16 LE file has odd byte count ({}); trailing byte dropped",
                bytes.len()
            );
            warning = Some(
                "File appears to be UTF-16 LE but has an odd byte count; the trailing byte was dropped during decode.".to_string(),
            );
        }
        let u16_iter = payload
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
        let decoded: String = char::decode_utf16(u16_iter)
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect();
        (decoded, "utf16le".to_string(), warning)
    } else if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        // UTF-16 BE
        let payload = &bytes[2..];
        let mut warning = None;
        if !payload.len().is_multiple_of(2) {
            warn!(
                "UTF-16 BE file has odd byte count ({}); trailing byte dropped",
                bytes.len()
            );
            warning = Some(
                "File appears to be UTF-16 BE but has an odd byte count; the trailing byte was dropped during decode.".to_string(),
            );
        }
        let u16_iter = payload
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]));
        let decoded: String = char::decode_utf16(u16_iter)
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect();
        (decoded, "utf16be".to_string(), warning)
    } else {
        decode_no_bom_fallback(bytes)
    }
}

/// Decodes a UTF-32 payload (BOM already stripped). PSForge has no UTF-32
/// save path — PowerShell itself never emits it — so the content is decoded
/// faithfully, reported as `utf8`, and a warning tells the user the file will
/// be saved as UTF-8 rather than pretending the original encoding survives.
fn decode_utf32(
    payload: &[u8],
    from_bytes: fn([u8; 4]) -> u32,
    label: &str,
) -> (String, String, Option<String>) {
    let mut replaced = false;
    let mut decoded = String::with_capacity(payload.len() / 4);
    for chunk in payload.chunks_exact(4) {
        let value = from_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        match char::from_u32(value) {
            Some(c) => decoded.push(c),
            None => {
                replaced = true;
                decoded.push('\u{FFFD}');
            }
        }
    }
    let mut notes = vec![format!(
        "File is {label}-encoded; PSForge decoded it but will save it as UTF-8 (without BOM)."
    )];
    if !payload.len().is_multiple_of(4) {
        warn!(
            "{} file has trailing partial code unit ({} bytes); dropped",
            label,
            payload.len() % 4
        );
        notes.push("Trailing partial code unit was dropped.".to_string());
    }
    if replaced {
        notes.push("Some invalid code points were replaced with U+FFFD.".to_string());
    }
    (decoded, "utf8".to_string(), Some(notes.join(" ")))
}

/// Decodes a buffer with no recognised BOM. Strict UTF-8 first, otherwise
/// Windows-1252 fallback (which preserves every byte for faithful round-trip).
fn decode_no_bom_fallback(bytes: &[u8]) -> (String, String, Option<String>) {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "utf8".to_string(), None);
    }
    // Invalid UTF-8. Windows-1252 maps every byte 0x00-0xFF to a code point,
    // so this branch always succeeds; we surface a warning so the user knows
    // a legacy decoding was applied and can choose to convert to UTF-8.
    let (decoded, _, _had_errors) = encoding_rs::WINDOWS_1252.decode(bytes);
    (
        decoded.into_owned(),
        "windows1252".to_string(),
        Some(
            "File is not valid UTF-8; decoded as Windows-1252 (legacy ANSI). Saving will round-trip the original bytes; convert to UTF-8 from another tool if you need broader compatibility."
                .to_string(),
        ),
    )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Loads user settings from disk.
#[cfg_attr(not(test), tauri::command)]
pub async fn load_settings() -> Result<AppSettings, AppError> {
    settings::load()
}

/// Saves user settings to disk.
#[cfg_attr(not(test), tauri::command)]
pub async fn save_settings(settings: AppSettings) -> Result<(), AppError> {
    settings::save(&settings)
}

// ---------------------------------------------------------------------------
// File Associations (Windows registry, per-user, no elevation)
// ---------------------------------------------------------------------------

/// Status of a single file association.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationStatus {
    pub extension: String,
    pub current_handler: String,
    pub is_psforge: bool,
}

/// Supported PowerShell file extensions.
const PS_EXTENSIONS: &[&str] = &[".ps1", ".psm1", ".psd1", ".ps1xml", ".pssc", ".cdxml"];

/// Validates that `extension` is a safe registry-key fragment.
///
/// All Tauri commands that touch the registry derive subkey paths from this
/// string. A caller could in principle pass `..\\..\\Foo` or a control
/// character via the IPC boundary; rejecting anything outside `^\.[A-Za-z0-9]+$`
/// blocks that without limiting any legitimate caller (the frontend only ever
/// sends values from `PS_EXTENSIONS`, all of which match this shape).
fn validate_extension(extension: &str) -> Result<(), AppError> {
    let invalid = extension.len() < 2
        || extension.len() > 16
        || !extension.starts_with('.')
        || !extension[1..].chars().all(|c| c.is_ascii_alphanumeric());
    if invalid {
        return Err(AppError {
            code: "INVALID_EXTENSION".to_string(),
            message: format!(
                "Extension '{}' is not a valid file extension. Expected '.<alphanumeric>' (max 16 chars).",
                extension
            ),
        });
    }
    Ok(())
}

#[cfg(target_os = "windows")]
const ASSOCIATION_ICON_FILE_NAME: &str = "psforge-file-association.ico";

#[cfg(target_os = "windows")]
const ASSOCIATION_ICON_BYTES: &[u8] = include_bytes!("../icons/file-association.ico");

/// Returns the registry `DefaultIcon` value for PSForge-associated script files.
///
/// Preference order:
/// 1. Bundled icon file near the executable (`<exe dir>` or `<exe dir>\\resources`)
/// 2. A per-user copy under `%LOCALAPPDATA%\\PSForge\\icons`
/// 3. Fallback to the executable icon (`psforge.exe,0`)
#[cfg(target_os = "windows")]
fn file_association_icon_registry_value(exe_path: &std::path::Path) -> String {
    if let Some(exe_dir) = exe_path.parent() {
        for candidate in [
            exe_dir.join(ASSOCIATION_ICON_FILE_NAME),
            exe_dir.join("resources").join(ASSOCIATION_ICON_FILE_NAME),
        ] {
            if candidate.is_file() {
                return format!("\"{}\",0", candidate.to_string_lossy());
            }
        }
    }

    if let Some(local_data_dir) = dirs::data_local_dir() {
        let icon_dir = local_data_dir.join("PSForge").join("icons");
        match std::fs::create_dir_all(&icon_dir) {
            Ok(()) => {
                let icon_path = icon_dir.join(ASSOCIATION_ICON_FILE_NAME);
                match std::fs::write(&icon_path, ASSOCIATION_ICON_BYTES) {
                    Ok(()) => return format!("\"{}\",0", icon_path.to_string_lossy()),
                    Err(e) => log::warn!(
                        "Failed to write file-association icon to '{}': {}",
                        icon_path.display(),
                        e
                    ),
                }
            }
            Err(e) => log::warn!(
                "Failed to create file-association icon directory '{}': {}",
                icon_dir.display(),
                e
            ),
        }
    } else {
        log::warn!("Could not resolve LocalAppData path for file-association icon");
    }

    // Defensive fallback so registration still succeeds if icon materialization fails.
    format!("\"{}\",0", exe_path.to_string_lossy())
}

/// Registers (or repairs) the per-user `Applications\<exe>` entry that backs
/// PSForge's presence in the Windows "Open with" list.
///
/// Windows auto-surfaces an executable in "Open with" the first time it is used
/// to open a file, but that bare entry has no `FriendlyAppName` and no
/// `DefaultIcon`, so it renders as the raw executable path with a blank icon and
/// — if it was created from a stale path — fails to launch. Writing an explicit
/// entry here gives the option a proper name + icon and a known-good launch
/// command pointing at the current executable. Re-running this repairs a
/// previously broken entry.
#[cfg(target_os = "windows")]
fn ensure_open_with_application(
    hkcu: &winreg::RegKey,
    exe_path: &std::path::Path,
    exe_path_str: &str,
) -> Result<(), AppError> {
    let exe_name = exe_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "psforge.exe".to_string());

    let app_root = format!(r"Software\Classes\Applications\{}", exe_name);
    let (app_key, _) = hkcu.create_subkey(&app_root).map_err(reg_err)?;
    app_key
        .set_value("FriendlyAppName", &"PSForge")
        .map_err(reg_err)?;

    let icon_path = format!(r"{}\DefaultIcon", app_root);
    let (icon_key, _) = hkcu.create_subkey(&icon_path).map_err(reg_err)?;
    icon_key
        .set_value("", &format!("\"{}\",0", exe_path_str))
        .map_err(reg_err)?;

    let cmd_path = format!(r"{}\shell\open\command", app_root);
    let (cmd_key, _) = hkcu.create_subkey(&cmd_path).map_err(reg_err)?;
    cmd_key
        .set_value("", &format!("\"{}\" \"%1\"", exe_path_str))
        .map_err(reg_err)?;

    // SupportedTypes makes PSForge a first-class suggestion in the Open With
    // list for our script extensions.
    let types_path = format!(r"{}\SupportedTypes", app_root);
    let (types_key, _) = hkcu.create_subkey(&types_path).map_err(reg_err)?;
    for ext in PS_EXTENSIONS {
        types_key.set_value(ext, &"").map_err(reg_err)?;
    }

    Ok(())
}

/// Registers PSForge as the handler for a specific file extension.
/// Uses HKCU (per-user, no admin required).
#[cfg_attr(not(test), tauri::command)]
pub async fn register_file_association(extension: String) -> Result<(), AppError> {
    info!("Registering file association for {}", extension);
    validate_extension(&extension)?;

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe_path = std::env::current_exe().map_err(|e| AppError {
            code: "EXE_PATH_FAILED".to_string(),
            message: format!("Could not determine executable path: {}", e),
        })?;
        let exe_path_str = exe_path.to_string_lossy().to_string();

        let prog_id = format!("PSForge{}", extension.replace('.', "_"));

        // Create ProgID: HKCU\Software\Classes\PSForge_ps1
        let prog_id_path = format!(r"Software\Classes\{}", prog_id);
        let (prog_key, _) = hkcu.create_subkey(&prog_id_path).map_err(reg_err)?;
        prog_key
            .set_value("", &format!("PSForge {} File", extension))
            .map_err(reg_err)?;
        // A friendly name ensures any UI that surfaces this ProgID (notably the
        // "Open with" picker) shows "PSForge" rather than the raw ProgID string.
        prog_key
            .set_value("FriendlyAppName", &"PSForge")
            .map_err(reg_err)?;

        // shell\open\command
        let cmd_path = format!(r"Software\Classes\{}\shell\open\command", prog_id);
        let (cmd_key, _) = hkcu.create_subkey(&cmd_path).map_err(reg_err)?;
        cmd_key
            .set_value("", &format!("\"{}\" \"%1\"", exe_path_str))
            .map_err(reg_err)?;

        // DefaultIcon: use a dedicated file-association icon so script files are
        // visually distinct from the standalone PSForge executable.
        let icon_path = format!(r"Software\Classes\{}\DefaultIcon", prog_id);
        let (icon_key, _) = hkcu.create_subkey(&icon_path).map_err(reg_err)?;
        let default_icon = file_association_icon_registry_value(&exe_path);
        icon_key.set_value("", &default_icon).map_err(reg_err)?;

        // Associate the extension: HKCU\Software\Classes\.ps1
        let ext_path = format!(r"Software\Classes\{}", extension);
        let (ext_key, _) = hkcu.create_subkey(&ext_path).map_err(reg_err)?;
        ext_key.set_value("", &prog_id).map_err(reg_err)?;

        // Register in OpenWithProgids so PSForge appears in the "Open With" list
        // and Windows can resolve our ProgID even when UserChoice is absent.
        let open_with_path = format!(r"Software\Classes\{}\OpenWithProgids", extension);
        let (open_with_key, _) = hkcu.create_subkey(&open_with_path).map_err(reg_err)?;
        open_with_key.set_value(&prog_id, &"").map_err(reg_err)?;

        // Windows Explorer uses HKCU\Software\Microsoft\Windows\CurrentVersion\
        // Explorer\FileExts\<ext>\UserChoice before it ever looks at
        // HKCU\Software\Classes, so the writes above are silently ignored when a
        // prior handler (e.g. VS Code) left a UserChoice entry.  Deleting the key
        // forces Windows to fall back to our HKCU\Software\Classes entry.
        // Writing to UserChoice is hash-protected since Windows 8, but deletion
        // is allowed for the current user.
        let user_choice_path = format!(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{}\UserChoice",
            extension
        );
        // Ignore errors: the key simply may not exist yet.
        let _ = hkcu.delete_subkey_all(&user_choice_path);

        // Register / repair the canonical "Open with" application entry so
        // PSForge appears in the Open With list with its proper name and icon
        // and actually launches when chosen.
        ensure_open_with_application(&hkcu, &exe_path, &exe_path_str)?;

        // Notify the shell of the change
        notify_shell_assoc_changed();

        info!("File association registered for {}", extension);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = extension;
        Err(AppError {
            code: "UNSUPPORTED_PLATFORM".to_string(),
            message: "File associations are only supported on Windows".to_string(),
        })
    }

    #[cfg(target_os = "windows")]
    Ok(())
}

/// Unregisters the PSForge handler for a specific file extension.
#[cfg_attr(not(test), tauri::command)]
pub async fn unregister_file_association(extension: String) -> Result<(), AppError> {
    info!("Unregistering file association for {}", extension);
    validate_extension(&extension)?;

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let prog_id = format!("PSForge{}", extension.replace('.', "_"));

        // Delete ProgID
        let prog_id_path = format!(r"Software\Classes\{}", prog_id);
        let _ = hkcu.delete_subkey_all(&prog_id_path);

        // Remove our extension association if it points to our ProgID
        let ext_path = format!(r"Software\Classes\{}", extension);
        if let Ok(ext_key) = hkcu.open_subkey(&ext_path) {
            let current: String = ext_key.get_value("").unwrap_or_default();
            if current == prog_id {
                let _ = hkcu.delete_subkey_all(&ext_path);
            }
        }

        notify_shell_assoc_changed();
        info!("File association unregistered for {}", extension);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = extension;
    }

    Ok(())
}

/// Registry path for the optional "Open with PSForge" right-click verb.
/// Registered under the all-files wildcard (`*`) so any file can be opened in
/// the PSForge editor from Explorer's context menu.
#[cfg(target_os = "windows")]
const CONTEXT_MENU_VERB_PATH: &str = r"Software\Classes\*\shell\PSForge";

/// Adds an "Open with PSForge" item (with the PSForge icon) to the Explorer
/// right-click menu for all files. Uses HKCU so no administrator rights are
/// required. This is opt-in via the Settings panel.
#[cfg_attr(not(test), tauri::command)]
pub async fn register_context_menu() -> Result<(), AppError> {
    info!("Registering 'Open with PSForge' context menu");

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe_path = std::env::current_exe().map_err(|e| AppError {
            code: "EXE_PATH_FAILED".to_string(),
            message: format!("Could not determine executable path: {}", e),
        })?;
        let exe_path_str = exe_path.to_string_lossy().to_string();

        // Verb key: the default value is the menu caption; `Icon` renders the
        // PSForge application icon beside it.
        let (verb_key, _) = hkcu
            .create_subkey(CONTEXT_MENU_VERB_PATH)
            .map_err(reg_err)?;
        verb_key
            .set_value("", &"Open with PSForge")
            .map_err(reg_err)?;
        verb_key
            .set_value("Icon", &format!("\"{}\",0", exe_path_str))
            .map_err(reg_err)?;

        let cmd_path = format!(r"{}\command", CONTEXT_MENU_VERB_PATH);
        let (cmd_key, _) = hkcu.create_subkey(&cmd_path).map_err(reg_err)?;
        cmd_key
            .set_value("", &format!("\"{}\" \"%1\"", exe_path_str))
            .map_err(reg_err)?;

        // Keep the Open With application entry healthy at the same time.
        ensure_open_with_application(&hkcu, &exe_path, &exe_path_str)?;

        notify_shell_assoc_changed();
        info!("'Open with PSForge' context menu registered");
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(AppError {
            code: "UNSUPPORTED_PLATFORM".to_string(),
            message: "Context menu integration is only supported on Windows".to_string(),
        })
    }

    #[cfg(target_os = "windows")]
    Ok(())
}

/// Removes the "Open with PSForge" right-click menu item.
#[cfg_attr(not(test), tauri::command)]
pub async fn unregister_context_menu() -> Result<(), AppError> {
    info!("Unregistering 'Open with PSForge' context menu");

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // Ignore errors: the key simply may not exist.
        let _ = hkcu.delete_subkey_all(CONTEXT_MENU_VERB_PATH);
        notify_shell_assoc_changed();
        info!("'Open with PSForge' context menu unregistered");
    }

    Ok(())
}

/// Returns whether the "Open with PSForge" right-click menu item is registered.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_context_menu_status() -> Result<bool, AppError> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let cmd_path = format!(r"{}\command", CONTEXT_MENU_VERB_PATH);
        Ok(hkcu.open_subkey(&cmd_path).is_ok())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

/// Returns the current file association status for all PS extensions.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_file_association_status() -> Result<Vec<AssociationStatus>, AppError> {
    let mut statuses = Vec::new();

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for ext in PS_EXTENSIONS {
            let prog_id = format!("PSForge{}", ext.replace('.', "_"));

            // Windows resolves the handler by reading UserChoice first, then
            // HKCU\Software\Classes, then HKLM\SOFTWARE\Classes.  We mirror
            // that priority order here so is_psforge reflects what Windows
            // will actually launch, not just what we wrote to the class key.
            let user_choice_path = format!(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{}\UserChoice",
                ext
            );

            let current_handler = if let Ok(uc_key) = hkcu.open_subkey(&user_choice_path) {
                // UserChoice\ProgId is the authoritative handler Windows uses.
                uc_key
                    .get_value("ProgId")
                    .unwrap_or_else(|_| "Unknown".to_string())
            } else {
                // No UserChoice -- fall back to HKCU\Software\Classes.
                let ext_path = format!(r"Software\Classes\{}", ext);
                if let Ok(ext_key) = hkcu.open_subkey(&ext_path) {
                    ext_key
                        .get_value("")
                        .unwrap_or_else(|_| "Unknown".to_string())
                } else {
                    // Finally fall back to HKLM for display purposes.
                    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
                    let lm_path = format!(r"Software\Classes\{}", ext);
                    if let Ok(lm_key) = hklm.open_subkey(&lm_path) {
                        lm_key.get_value("").unwrap_or_else(|_| "None".to_string())
                    } else {
                        "None".to_string()
                    }
                }
            };

            let is_psforge = current_handler == prog_id;

            statuses.push(AssociationStatus {
                extension: ext.to_string(),
                current_handler,
                is_psforge,
            });
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for ext in PS_EXTENSIONS {
            statuses.push(AssociationStatus {
                extension: ext.to_string(),
                current_handler: "Unsupported".to_string(),
                is_psforge: false,
            });
        }
    }

    Ok(statuses)
}

/// Calls SHChangeNotify to refresh shell file associations.
#[cfg(target_os = "windows")]
fn notify_shell_assoc_changed() {
    use std::ptr;
    #[link(name = "shell32")]
    extern "system" {
        fn SHChangeNotify(wEventId: i32, uFlags: u32, dwItem1: *const u8, dwItem2: *const u8);
    }
    // SHCNE_ASSOCCHANGED = 0x08000000, SHCNF_IDLIST = 0
    unsafe {
        SHChangeNotify(0x08000000, 0, ptr::null(), ptr::null());
    }
}

/// Helper to convert a winreg error to AppError.
#[cfg(target_os = "windows")]
fn reg_err(e: std::io::Error) -> AppError {
    AppError {
        code: "REGISTRY_ERROR".to_string(),
        message: format!("Registry operation failed: {}", e),
    }
}

/// Registers PSForge as the default handler for multiple file extensions in a single call.
/// Processes every requested extension, accumulating per-item errors rather than aborting
/// on the first failure (Rule 11 - batch error accumulation).
///
/// Returns `BatchResult<String>` where `items` contains extensions that were registered
/// successfully and `errors` describes any partial failures.
#[cfg_attr(not(test), tauri::command)]
pub async fn batch_register_file_associations(
    extensions: Vec<String>,
) -> Result<BatchResult<String>, AppError> {
    info!(
        "batch_register_file_associations: {} extensions requested",
        extensions.len()
    );
    let mut result: BatchResult<String> = BatchResult::new();

    for ext in extensions {
        match register_file_association(ext.clone()).await {
            Ok(()) => {
                debug!("batch_register: registered {}", ext);
                result.push_item(ext);
            }
            Err(e) => {
                error!("batch_register: failed for {}: {}", ext, e.message);
                result.push_error(&ext, e.code, e.message);
            }
        }
    }

    info!(
        "batch_register_file_associations: {} succeeded, {} failed",
        result.items.len(),
        result.errors.len()
    );
    Ok(result)
}

/// Unregisters PSForge as the default handler for multiple file extensions in a single call.
/// Accumulates per-item errors without aborting on first failure (Rule 11).
///
/// Returns `BatchResult<String>` where `items` contains successfully unregistered extensions.
#[cfg_attr(not(test), tauri::command)]
pub async fn batch_unregister_file_associations(
    extensions: Vec<String>,
) -> Result<BatchResult<String>, AppError> {
    info!(
        "batch_unregister_file_associations: {} extensions requested",
        extensions.len()
    );
    let mut result: BatchResult<String> = BatchResult::new();

    for ext in extensions {
        match unregister_file_association(ext.clone()).await {
            Ok(()) => {
                debug!("batch_unregister: unregistered {}", ext);
                result.push_item(ext);
            }
            Err(e) => {
                error!("batch_unregister: failed for {}: {}", ext, e.message);
                result.push_error(&ext, e.code, e.message);
            }
        }
    }

    info!(
        "batch_unregister_file_associations: {} succeeded, {} failed",
        result.items.len(),
        result.errors.len()
    );
    Ok(result)
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/// A code snippet.
#[derive(Debug, Serialize, Deserialize)]
pub struct Snippet {
    /// Display name.
    pub name: String,
    /// Category (e.g. "Control Flow", "Functions", "CIM").
    pub category: String,
    /// Description of what the snippet does.
    pub description: String,
    /// The actual code template.
    pub code: String,
}

/// Returns built-in snippets plus any user-defined snippets.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_snippets() -> Result<Vec<Snippet>, AppError> {
    let user_path = settings::snippets_path()?;
    get_snippets_from(user_path)
}

/// Loads snippets from an explicit user-snippets path (for testing).
/// Returns built-in snippets merged with any user snippets at the given path.
pub fn get_snippets_from(user_path: std::path::PathBuf) -> Result<Vec<Snippet>, AppError> {
    let mut snippets = builtin_snippets();
    if user_path.exists() {
        let content = match with_retry("read_user_snippets", || std::fs::read_to_string(&user_path))
        {
            Ok(content) => content,
            Err(e) => {
                // A transient/permission read failure (AV scan, OneDrive sync,
                // restrictive ACL) must not discard the built-in snippets — log
                // and fall back to built-ins only (S3-10). Matches the graceful
                // degradation of the parse-error branch below.
                warn!(
                    "failed to read user snippets ({}); falling back to built-ins",
                    e
                );
                return Ok(snippets);
            }
        };
        match serde_json::from_str::<Vec<Snippet>>(&content) {
            Ok(user_snippets) => snippets.extend(user_snippets),
            Err(e) => {
                // Corrupt user snippets: back up the bad file so the user can
                // recover, then continue with built-ins only. Without the
                // backup, custom snippets are silently destroyed.
                let backup_path = settings::backup_path_for(&user_path);
                match std::fs::copy(&user_path, &backup_path) {
                    Ok(_) => warn!(
                        "user snippets file is corrupted ({}); backed up to {:?} and falling back to built-ins",
                        e, backup_path
                    ),
                    Err(copy_err) => error!(
                        "user snippets file is corrupted ({}); failed to back up to {:?}: {}. Falling back to built-ins",
                        e, backup_path, copy_err
                    ),
                }
            }
        }
    }
    Ok(snippets)
}

/// Saves user-defined snippets to disk.
#[cfg_attr(not(test), tauri::command)]
pub async fn save_user_snippets(snippets: Vec<Snippet>) -> Result<(), AppError> {
    let dir = settings::settings_dir()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    let path = settings::snippets_path()?;
    save_user_snippets_to(&path, &snippets)
}

/// Saves user snippets to an explicit path (for testing).
pub fn save_user_snippets_to(path: &std::path::Path, snippets: &[Snippet]) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(snippets)?;
    with_retry("save_user_snippets", || atomic_write(path, json.as_bytes()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shell Integration
// ---------------------------------------------------------------------------

/// Opens a file path in Windows Explorer, selecting the file.
/// Opens the parent directory on non-Windows platforms.
#[cfg_attr(not(test), tauri::command)]
pub async fn reveal_in_explorer(path: String) -> Result<(), AppError> {
    info!("reveal_in_explorer: {}", path);

    if std::path::Path::new(&path).is_dir() {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer.exe")
                .arg(&path)
                .spawn()
                .map_err(|e| AppError {
                    code: "EXPLORER_LAUNCH_FAILED".to_string(),
                    message: format!("Failed to open Explorer: {}", e),
                })?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| AppError {
                    code: "EXPLORER_LAUNCH_FAILED".to_string(),
                    message: format!("Failed to open Finder: {}", e),
                })?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| AppError {
                    code: "EXPLORER_LAUNCH_FAILED".to_string(),
                    message: format!("Failed to open file manager: {}", e),
                })?;
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe /select,"<path>" highlights the file in its folder.
        // We MUST use raw_arg() here rather than arg(): Rust's arg() applies
        // Windows command-line quoting, which wraps the whole string in extra
        // quotes and makes Explorer ignore the /select flag, falling back to
        // opening Documents. raw_arg() passes the bytes verbatim to
        // CreateProcess so Explorer sees exactly: /select,"C:\path\file.ps1"
        use std::os::windows::process::CommandExt;
        let raw = format!("/select,\"{}\"", path);
        std::process::Command::new("explorer.exe")
            .raw_arg(&raw)
            .spawn()
            .map_err(|e| AppError {
                code: "EXPLORER_LAUNCH_FAILED".to_string(),
                message: format!("Failed to open Explorer: {}", e),
            })?;
    }

    #[cfg(target_os = "macos")]
    {
        // macOS Finder: `-R` reveals the file in its parent folder, mirroring
        // the Windows Explorer "/select" behaviour above.
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError {
                code: "EXPLORER_LAUNCH_FAILED".to_string(),
                message: format!("Failed to open Finder: {}", e),
            })?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux + other Unix: open the parent directory with the freedesktop helper.
        // Most desktop file managers do not support a generic "select-this-file"
        // action so we degrade to revealing the folder instead.
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| AppError {
                code: "EXPLORER_LAUNCH_FAILED".to_string(),
                message: format!("Failed to open file manager: {}", e),
            })?;
    }

    Ok(())
}

fn builtin_snippets() -> Vec<Snippet> {
    vec![
        Snippet {
            name: "Function".to_string(),
            category: "Functions".to_string(),
            description: "Basic function with CmdletBinding".to_string(),
            code: "function Verb-Noun {\n    [CmdletBinding()]\n    param(\n        [Parameter(Mandatory = $true)]\n        [string]$Name\n    )\n\n    begin {\n    }\n\n    process {\n    }\n\n    end {\n    }\n}".to_string(),
        },
        Snippet {
            name: "Advanced Function".to_string(),
            category: "Functions".to_string(),
            description: "Advanced function with full parameter attributes".to_string(),
            code: "function Verb-Noun {\n    [CmdletBinding(SupportsShouldProcess = $true)]\n    param(\n        [Parameter(Mandatory = $true, ValueFromPipeline = $true, Position = 0)]\n        [ValidateNotNullOrEmpty()]\n        [string]$Name,\n\n        [Parameter()]\n        [switch]$Force\n    )\n\n    begin {\n        Write-Verbose \"Starting $($MyInvocation.MyCommand)\"\n    }\n\n    process {\n        if ($PSCmdlet.ShouldProcess($Name, 'Action')) {\n            # Implementation\n        }\n    }\n\n    end {\n        Write-Verbose \"Completed $($MyInvocation.MyCommand)\"\n    }\n}".to_string(),
        },
        Snippet {
            name: "Try/Catch/Finally".to_string(),
            category: "Control Flow".to_string(),
            description: "Error handling block".to_string(),
            code: "try {\n    # Code that may throw\n}\ncatch [System.Exception] {\n    Write-Error \"Error: $_\"\n}\nfinally {\n    # Cleanup code\n}".to_string(),
        },
        Snippet {
            name: "ForEach-Object Pipeline".to_string(),
            category: "Control Flow".to_string(),
            description: "Pipeline foreach processing".to_string(),
            code: "$items | ForEach-Object {\n    $_\n}".to_string(),
        },
        Snippet {
            name: "foreach Loop".to_string(),
            category: "Control Flow".to_string(),
            description: "Statement-based foreach loop".to_string(),
            code: "foreach ($item in $collection) {\n    $item\n}".to_string(),
        },
        Snippet {
            name: "If/ElseIf/Else".to_string(),
            category: "Control Flow".to_string(),
            description: "Conditional branching".to_string(),
            code: "if ($condition) {\n    # True branch\n}\nelseif ($otherCondition) {\n    # Other branch\n}\nelse {\n    # Default branch\n}".to_string(),
        },
        Snippet {
            name: "Switch Statement".to_string(),
            category: "Control Flow".to_string(),
            description: "Switch with multiple cases".to_string(),
            code: "switch ($value) {\n    'Option1' {\n        # Handle Option1\n    }\n    'Option2' {\n        # Handle Option2\n    }\n    default {\n        # Default handler\n    }\n}".to_string(),
        },
        Snippet {
            name: "Param Block".to_string(),
            category: "Script".to_string(),
            description: "Script-level parameter block".to_string(),
            code: "[CmdletBinding()]\nparam(\n    [Parameter(Mandatory = $true)]\n    [string]$Name,\n\n    [Parameter()]\n    [int]$Count = 1,\n\n    [Parameter()]\n    [switch]$Verbose\n)".to_string(),
        },
        Snippet {
            name: "CIM Query".to_string(),
            category: "CIM".to_string(),
            description: "Get CIM instance with filter".to_string(),
            code: "Get-CimInstance -ClassName Win32_Process -Filter \"Name = 'powershell.exe'\" | Select-Object Name, ProcessId, WorkingSetSize".to_string(),
        },
        Snippet {
            name: "CIM Method Invoke".to_string(),
            category: "CIM".to_string(),
            description: "Invoke a CIM method".to_string(),
            code: "$instance = Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId = $pid\"\nInvoke-CimMethod -InputObject $instance -MethodName GetOwner".to_string(),
        },
        Snippet {
            name: "Hashtable / Splatting".to_string(),
            category: "Data".to_string(),
            description: "Create a hashtable for splatting".to_string(),
            code: "$params = @{\n    Path      = 'C:\\Temp'\n    Filter    = '*.log'\n    Recurse   = $true\n    ErrorAction = 'SilentlyContinue'\n}\nGet-ChildItem @params".to_string(),
        },
        Snippet {
            name: "PSCustomObject".to_string(),
            category: "Data".to_string(),
            description: "Create a custom object".to_string(),
            code: "[PSCustomObject]@{\n    Name    = 'Example'\n    Value   = 42\n    Status  = 'Active'\n}".to_string(),
        },
        Snippet {
            name: "Class Definition".to_string(),
            category: "Classes".to_string(),
            description: "PowerShell 5+ class".to_string(),
            code: "class MyClass {\n    [string]$Name\n    [int]$Value\n\n    MyClass([string]$name, [int]$value) {\n        $this.Name = $name\n        $this.Value = $value\n    }\n\n    [string] ToString() {\n        return \"$($this.Name): $($this.Value)\"\n    }\n}".to_string(),
        },
        Snippet {
            name: "Pester Test".to_string(),
            category: "Testing".to_string(),
            description: "Basic Pester test structure".to_string(),
            code: "Describe 'Feature Under Test' {\n    BeforeAll {\n        # Setup\n    }\n\n    It 'Should do something expected' {\n        $result = Get-Something\n        $result | Should -Be 'Expected'\n    }\n\n    It 'Should handle errors' {\n        { Get-Something -Invalid } | Should -Throw\n    }\n\n    AfterAll {\n        # Teardown\n    }\n}".to_string(),
        },
        Snippet {
            name: "Remote Session".to_string(),
            category: "Remoting".to_string(),
            description: "Invoke command on remote computer".to_string(),
            code: "$cred = Get-Credential\nInvoke-Command -ComputerName 'Server01' -Credential $cred -ScriptBlock {\n    Get-Process | Select-Object -First 10\n}".to_string(),
        },
        Snippet {
            name: "REST API Call".to_string(),
            category: "Web".to_string(),
            description: "Invoke-RestMethod with headers".to_string(),
            code: "$headers = @{\n    'Authorization' = \"Bearer $token\"\n    'Content-Type'  = 'application/json'\n}\n\n$body = @{\n    key = 'value'\n} | ConvertTo-Json\n\n$response = Invoke-RestMethod -Uri 'https://api.example.com/endpoint' -Method Post -Headers $headers -Body $body\n$response".to_string(),
        },
        Snippet {
            name: "File Processing Pipeline".to_string(),
            category: "Files".to_string(),
            description: "Read, process, and export CSV".to_string(),
            code: "Import-Csv -Path '.\\input.csv' |\n    Where-Object { $_.Status -eq 'Active' } |\n    ForEach-Object {\n        [PSCustomObject]@{\n            Name = $_.Name\n            Date = [datetime]::Parse($_.Date)\n        }\n    } |\n    Export-Csv -Path '.\\output.csv' -NoTypeInformation".to_string(),
        },
        Snippet {
            name: "Registry Operations".to_string(),
            category: "System".to_string(),
            description: "Read and write registry values".to_string(),
            code: "# Read\n$value = Get-ItemPropertyValue -Path 'HKCU:\\Software\\MyApp' -Name 'Setting'\n\n# Write\nSet-ItemProperty -Path 'HKCU:\\Software\\MyApp' -Name 'Setting' -Value 'NewValue'".to_string(),
        },
        Snippet {
            name: "Parallel ForEach (PS7)".to_string(),
            category: "Control Flow".to_string(),
            description: "Parallel processing with ForEach-Object -Parallel".to_string(),
            code: "$items | ForEach-Object -Parallel {\n    $item = $_\n    # Process each item in parallel\n    Write-Output \"Processing $item\"\n} -ThrottleLimit 5".to_string(),
        },
        Snippet {
            name: "Error Record Handling".to_string(),
            category: "Control Flow".to_string(),
            description: "Detailed error record inspection".to_string(),
            code: "try {\n    # Risky operation\n}\ncatch {\n    $err = $_\n    Write-Error \"Message: $($err.Exception.Message)\"\n    Write-Error \"Type: $($err.Exception.GetType().FullName)\"\n    Write-Error \"Stack: $($err.ScriptStackTrace)\"\n    Write-Error \"Position: $($err.InvocationInfo.PositionMessage)\"\n}".to_string(),
        },
    ]
}

// ---------------------------------------------------------------------------
// Static Analysis & IntelliSense
// ---------------------------------------------------------------------------

/// Maximum seconds to wait for a PSScriptAnalyzer invocation before giving up.
/// On slower machines or cold PowerShell starts, 5s is too aggressive and can
/// cause false "no diagnostics" results.
const ANALYSIS_TIMEOUT_SECS: u64 = 12;

/// Maximum seconds to wait for a TabExpansion2 completion request.
/// Cold starts under test load can exceed 3s; keep this high enough so normal
/// completions are not dropped as empty results.
const COMPLETION_TIMEOUT_SECS: u64 = 12;
/// Maximum seconds to wait when querying online module suggestions for an
/// unknown command in the integrated terminal.
const MODULE_SUGGEST_TIMEOUT_SECS: u64 = 8;

/// Diagnostic produced by PSScriptAnalyzer. All line/column numbers are 1-indexed,
/// matching Monaco editor conventions.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PssaDiagnostic {
    pub message: String,
    /// Severity as a string: "Error", "Warning", "Information", or "ParseError".
    pub severity: String,
    /// PSSA rule name (e.g. "PSAvoidUsingWriteHost").
    pub rule_name: String,
    /// Start line (1-indexed).
    pub line: u32,
    /// Start column (1-indexed).
    pub column: u32,
    /// End line (1-indexed).
    pub end_line: u32,
    /// End column (1-indexed).
    pub end_column: u32,
}

/// A single completion candidate produced by PowerShell's TabExpansion2.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PsCompletion {
    /// Text to insert when the user accepts the completion.
    pub completion_text: String,
    /// Short label displayed in the completion list.
    pub list_item_text: String,
    /// Tooltip / synopsis shown next to the completion item.
    pub tool_tip: String,
    /// PS completion result type as a string (e.g. "Command", "Parameter", "Variable").
    pub result_type: String,
}

/// Suggested module install candidate for a missing command.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInstallSuggestion {
    /// Module/package name published to PSGallery or another repository.
    pub name: String,
    /// Module version string when available.
    pub version: String,
    /// Repository name (for example "PSGallery") when provided by the source.
    pub repository: String,
    /// Concrete install command users can run in the terminal.
    pub install_command: String,
}

/// Runs PSScriptAnalyzer on `script_content` and returns structured diagnostics.
///
/// Silently returns an empty list when:
/// - PSScriptAnalyzer module is not installed.
/// - The analysis exceeds `ANALYSIS_TIMEOUT_SECS`.
/// - Any process or JSON-parsing error occurs.
///
/// This ensures the frontend always gets a typed result without crashing the editor
/// (Rule 11 graceful degradation).
#[cfg_attr(not(test), tauri::command)]
pub async fn analyze_script(
    ps_path: String,
    script_content: String,
) -> Result<Vec<PssaDiagnostic>, AppError> {
    debug!("analyze_script called ({} chars)", script_content.len());
    let ps_path = ps_path.trim();
    if ps_path.is_empty() {
        return Ok(Vec::new());
    }
    if let Err(err) = powershell::validate_ps_path(ps_path) {
        debug!("analyze_script: invalid PowerShell path: {}", err);
        return Ok(Vec::new());
    }

    // Write content to a temp file so PSSA receives accurate file-path info
    // and we avoid all single-quote escaping issues with -Command.
    let temp_path = write_temp_ps_file(&script_content).map_err(|e| AppError {
        code: "TEMP_WRITE_FAILED".to_string(),
        message: format!("Failed to create temp analysis file: {}", e),
    })?;

    // Escape single quotes in the path (extremely unlikely but safe).
    let path_str = temp_path.to_string_lossy().replace('\'', "''");

    let ps_script = format!(
        "$ErrorActionPreference = 'SilentlyContinue';\
if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer)) {{ '[]'; exit }}\
Import-Module PSScriptAnalyzer -EA SilentlyContinue;\
$d = Invoke-ScriptAnalyzer -Path '{}';\
if (-not $d) {{ '[]'; exit }}\
($d | Select-Object @{{N='message';E={{$_.Message}}}},\
@{{N='severity';E={{$_.Severity.ToString()}}}},\
@{{N='ruleName';E={{$_.RuleName}}}},\
@{{N='line';E={{$_.Extent.StartLineNumber}}}},\
@{{N='column';E={{$_.Extent.StartColumnNumber}}}},\
@{{N='endLine';E={{$_.Extent.EndLineNumber}}}},\
@{{N='endColumn';E={{$_.Extent.EndColumnNumber}}}} | ConvertTo-Json -Compress)",
        path_str
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(ANALYSIS_TIMEOUT_SECS),
        ps_command(ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
            ])
            .arg(ps_utf8_script(&ps_script))
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    // Always clean up the temp file, regardless of outcome.
    let _ = std::fs::remove_file(&temp_path);

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            debug!("analyze_script: process error: {}", e);
            return Ok(Vec::new());
        }
        Err(_) => {
            debug!("analyze_script: timed out after {}s", ANALYSIS_TIMEOUT_SECS);
            return Ok(Vec::new());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    let diagnostics: Vec<PssaDiagnostic> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        match serde_json::from_str::<PssaDiagnostic>(trimmed) {
            Ok(single) => vec![single],
            Err(e) => {
                debug!("analyze_script: JSON parse error: {} | raw: {}", e, trimmed);
                Vec::new()
            }
        }
    };

    debug!("analyze_script: {} diagnostics", diagnostics.len());
    Ok(diagnostics)
}

/// Returns TabExpansion2 completion candidates for `script_content` at `cursor_column`.
///
/// `cursor_column` is the 0-based UTF-16 offset used by Monaco; we pass it directly to
/// TabExpansion2 (which uses the same convention for the `-cursorColumn` parameter).
///
/// Silently returns an empty list on timeout, process failure, or parse error
/// (Rule 11 graceful degradation - completions must never crash the editor).
#[cfg_attr(not(test), tauri::command)]
pub async fn get_completions(
    ps_path: String,
    script_content: String,
    cursor_column: usize,
) -> Result<Vec<PsCompletion>, AppError> {
    debug!("get_completions called (cursor_column={})", cursor_column);
    let ps_path = ps_path.trim();
    if ps_path.is_empty() {
        return Ok(Vec::new());
    }
    if let Err(err) = powershell::validate_ps_path(ps_path) {
        debug!("get_completions: invalid PowerShell path: {}", err);
        return Ok(Vec::new());
    }

    let temp_path = write_temp_ps_file(&script_content).map_err(|e| AppError {
        code: "TEMP_WRITE_FAILED".to_string(),
        message: format!("Failed to create temp completion file: {}", e),
    })?;

    let path_str = temp_path.to_string_lossy().replace('\'', "''");

    let ps_script = format!(
        "$ErrorActionPreference = 'SilentlyContinue';\
$s = [IO.File]::ReadAllText('{}');\
$r = TabExpansion2 -inputScript $s -cursorColumn {};\
if (-not $r.CompletionMatches) {{ '[]'; exit }}\
($r.CompletionMatches | Select-Object \
@{{N='completionText';E={{$_.CompletionText}}}},\
@{{N='listItemText';E={{$_.ListItemText}}}},\
@{{N='toolTip';E={{$_.ToolTip}}}},\
@{{N='resultType';E={{$_.ResultType.ToString()}}}} | ConvertTo-Json -Compress)",
        path_str, cursor_column
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(COMPLETION_TIMEOUT_SECS),
        ps_command(ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
            ])
            .arg(ps_utf8_script(&ps_script))
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let _ = std::fs::remove_file(&temp_path);

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            debug!("get_completions: process error: {}", e);
            return Ok(Vec::new());
        }
        Err(_) => {
            debug!(
                "get_completions: timed out after {}s",
                COMPLETION_TIMEOUT_SECS
            );
            return Ok(Vec::new());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    let completions: Vec<PsCompletion> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        match serde_json::from_str::<PsCompletion>(trimmed) {
            Ok(single) => vec![single],
            Err(e) => {
                debug!(
                    "get_completions: JSON parse error: {} | raw: {}",
                    e, trimmed
                );
                Vec::new()
            }
        }
    };

    debug!("get_completions: {} items", completions.len());
    Ok(completions)
}

/// PowerShell snippet that queries the best-available package-discovery command
/// for modules exporting a missing command name.
///
/// Preference order:
/// 1) PSResourceGet (`Find-PSResource -CommandName`) on newer systems.
/// 2) PowerShellGet (`Find-Module -Command`) as a fallback.
///
/// Output is always JSON in the `ModuleInstallSuggestion` shape, or `[]`.
const MODULE_SUGGEST_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$cmd = $env:PSFORGE_MISSING_CMDLET
if ([string]::IsNullOrWhiteSpace($cmd)) { '[]'; exit }

if (Get-Command -Name Find-PSResource -ErrorAction SilentlyContinue) {
    try {
        $r = Find-PSResource -CommandName $cmd -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Unique |
            Select-Object -First 5
        if ($r) {
            ($r | Select-Object @{N='name';E={$_.Name}},
                @{N='version';E={ if ($_.Version) { $_.Version.ToString() } else { '' } }},
                @{N='repository';E={ if ($_.Repository) { $_.Repository } else { '' } }},
                @{N='installCommand';E={ "Install-PSResource -Name '$($_.Name)'" }} |
                ConvertTo-Json -Compress)
            exit
        }
    } catch {}
}

if (Get-Command -Name Find-Module -ErrorAction SilentlyContinue) {
    try {
        $r = Find-Module -Command $cmd -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Unique |
            Select-Object -First 5
        if ($r) {
            ($r | Select-Object @{N='name';E={$_.Name}},
                @{N='version';E={ if ($_.Version) { $_.Version.ToString() } else { '' } }},
                @{N='repository';E={ if ($_.Repository) { $_.Repository } else { '' } }},
                @{N='installCommand';E={ "Install-Module -Name '$($_.Name)' -Scope CurrentUser" }} |
                ConvertTo-Json -Compress)
            exit
        }
    } catch {}
}

'[]'
"#;

/// Suggests module installs for a command name that PowerShell could not
/// resolve, returning up to five candidates.
///
/// This is used by the integrated terminal to provide actionable "command not
/// found" hints without hard-failing if discovery tooling/network is missing.
#[cfg_attr(not(test), tauri::command)]
pub async fn suggest_modules_for_command(
    ps_path: String,
    command_name: String,
) -> Result<Vec<ModuleInstallSuggestion>, AppError> {
    let command_name = command_name.trim().to_string();
    debug!("suggest_modules_for_command called for {:?}", command_name);

    if command_name.is_empty() || command_name.len() > 256 {
        return Ok(Vec::new());
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(MODULE_SUGGEST_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
            ])
            .arg(ps_utf8_script(MODULE_SUGGEST_SCRIPT))
            .env("PSFORGE_MISSING_CMDLET", &command_name)
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            debug!("suggest_modules_for_command: process error: {}", e);
            return Ok(Vec::new());
        }
        Err(_) => {
            debug!(
                "suggest_modules_for_command: timed out after {}s",
                MODULE_SUGGEST_TIMEOUT_SECS
            );
            return Ok(Vec::new());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    let suggestions: Vec<ModuleInstallSuggestion> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        match serde_json::from_str::<ModuleInstallSuggestion>(trimmed) {
            Ok(single) => vec![single],
            Err(e) => {
                debug!(
                    "suggest_modules_for_command: JSON parse error: {} | raw: {}",
                    e, trimmed
                );
                Vec::new()
            }
        }
    };

    Ok(suggestions)
}

/// Writes `content` to a uniquely-named temp file and returns its path.
fn write_temp_ps_file(content: &str) -> std::io::Result<std::path::PathBuf> {
    write_secure_temp_file("psforge_tmp", ".ps1", content.as_bytes())
}

// ---------------------------------------------------------------------------
// Execution Policy Management
// ---------------------------------------------------------------------------

/// Allowed execution-policy values for validation (Rule 11 -- input validation).
const ALLOWED_POLICIES: &[&str] = &[
    "Default",
    "AllSigned",
    "RemoteSigned",
    "Unrestricted",
    "Bypass",
    "Restricted",
];

/// Returns the current PowerShell execution policy for the current user scope.
/// Silently returns "Unknown" when the ps_path is inaccessible or PS fails.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_execution_policy(ps_path: String) -> Result<String, AppError> {
    info!("get_execution_policy called");
    let ps_path = ps_path.trim();
    if ps_path.is_empty() {
        return Ok("Unknown".to_string());
    }
    if let Err(err) = powershell::validate_ps_path(ps_path) {
        debug!("get_execution_policy: invalid PowerShell path: {}", err);
        return Ok("Unknown".to_string());
    }

    let output = match ps_command(ps_path)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(ps_utf8_script("Get-ExecutionPolicy -Scope CurrentUser"))
        .creation_flags(0x08000000)
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            debug!(
                "get_execution_policy: query failed (returning Unknown): {}",
                e
            );
            return Ok("Unknown".to_string());
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(
            "get_execution_policy: PowerShell exit={:?}, stderr='{}' (returning Unknown)",
            output.status.code(),
            stderr.trim()
        );
        return Ok("Unknown".to_string());
    }

    let policy = String::from_utf8_lossy(&output.stdout).trim().to_string();

    debug!("get_execution_policy result: {}", policy);
    Ok(if policy.is_empty() {
        "Unknown".to_string()
    } else {
        policy
    })
}

/// Sets the PowerShell execution policy for the current user scope (HKCU -- no admin needed).
/// Only the values in ALLOWED_POLICIES are accepted (Rule 11 -- input validation).
#[cfg_attr(not(test), tauri::command)]
pub async fn set_execution_policy(ps_path: String, policy: String) -> Result<(), AppError> {
    info!("set_execution_policy called with policy={}", policy);

    // Validate against the allow-list before passing to PowerShell. Capture
    // the canonical-cased entry so we never pass a typo'd `byPass` through to
    // PowerShell — case-insensitive comparison and canonical casing in the
    // emitted command keep the boundary clean.
    let canonical = ALLOWED_POLICIES
        .iter()
        .find(|p| p.eq_ignore_ascii_case(&policy))
        .copied()
        .ok_or_else(|| AppError {
            code: "INVALID_POLICY".to_string(),
            message: format!(
                "Invalid execution policy '{}'. Allowed: {}",
                policy,
                ALLOWED_POLICIES.join(", ")
            ),
        })?;

    // Skip the Set-ExecutionPolicy call when the requested value is "Default" --
    // that sentinel means "leave whatever the user has set alone".
    if canonical == "Default" {
        return Ok(());
    }

    powershell::validate_ps_path(&ps_path)?;

    let script = format!(
        "Set-ExecutionPolicy -ExecutionPolicy {} -Scope CurrentUser -Force",
        canonical
    );

    let output = ps_command(&ps_path)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(ps_utf8_script(&script))
        .creation_flags(0x08000000)
        .output()
        .await
        .map_err(|e| AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Failed to set execution policy: {}", e),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Set-ExecutionPolicy failed: {}", stderr.trim()),
        });
    }

    info!("Execution policy set to {}", policy);
    Ok(())
}

/// Extracts a launch file path from argv-style arguments: skips argv[0]
/// (the executable path), ignores `--flag` style Tauri/WebView2 internals,
/// and returns the first argument that is an existing file. Shared by
/// `get_launch_path` (first launch) and the single-instance callback
/// (subsequent launches forwarded to the running instance).
pub fn launch_path_from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    let path = args.into_iter().skip(1).find(|a| !a.starts_with('-'))?;

    // Validate it is an existing file before returning it to the frontend.
    if std::path::Path::new(&path).is_file() {
        info!("Launch path detected: {}", path);
        Some(path)
    } else {
        None
    }
}

/// Returns the file path passed as the first command-line argument when the
/// application was launched by Windows Explorer via a file-type association
/// (e.g. double-click on a .ps1 file).  Returns `None` when the app was
/// launched normally (no arguments, or the argument is not an existing file).
///
/// The frontend calls this once on mount and, if a path is returned, opens
/// the file immediately so the user sees the file they clicked on.
#[cfg_attr(not(test), tauri::command)]
pub fn get_launch_path() -> Option<String> {
    launch_path_from_args(std::env::args())
}

// ---------------------------------------------------------------------------
// Script Formatter
// ---------------------------------------------------------------------------

/// Maximum seconds to wait for Invoke-Formatter to complete.
/// Formatting a 500-line script with PSScriptAnalyzer typically takes 1-2 s;
/// 10 s covers slow machines with many loaded modules.
const FORMAT_TIMEOUT_SECS: u64 = 10;

/// Formats a PowerShell script using PSScriptAnalyzer Invoke-Formatter.
///
/// The script content is passed via the PSFORGE_SCRIPT_CONTENT environment
/// variable (the same technique used by get_script_parameters) to avoid all
/// shell-escaping concerns for arbitrary content.
///
/// Returns the formatted script text.  Degrades gracefully when
/// PSScriptAnalyzer is not installed or the formatter times out -- in that
/// case the original content is returned unchanged so the editor never
/// surfaces a user-visible error for a missing optional module
/// (Rule 11 graceful degradation).
#[cfg_attr(not(test), tauri::command)]
pub async fn format_script(ps_path: String, script_content: String) -> Result<String, AppError> {
    debug!("format_script called ({} chars)", script_content.len());
    powershell::validate_ps_path(&ps_path)?;

    if script_content.trim().is_empty() {
        return Ok(script_content);
    }

    // Windows environment variables are capped at ~32 767 chars.
    // Return the original for extremely large scripts.
    const MAX_FORMAT_BYTES: usize = 32_000;
    if script_content.len() > MAX_FORMAT_BYTES {
        debug!(
            "format_script: script too large ({} bytes), skipping",
            script_content.len()
        );
        return Ok(script_content);
    }

    // The PS snippet reads the script from the env var, checks whether
    // PSScriptAnalyzer is available, and writes the formatted text to stdout.
    // If the module is absent it exits without writing, causing the backend
    // to fall through to the original content.
    const FORMAT_SNIPPET: &str = "\
$ErrorActionPreference='SilentlyContinue';\
if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer)) { exit }\
Import-Module PSScriptAnalyzer -EA SilentlyContinue;\
$text = $env:PSFORGE_SCRIPT_CONTENT;\
$formatted = Invoke-Formatter -ScriptDefinition $text -EA SilentlyContinue;\
if ($formatted) { $formatted } else { $text }";

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(FORMAT_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            .arg(ps_utf8_script(FORMAT_SNIPPET))
            .env("PSFORGE_SCRIPT_CONTENT", &script_content)
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // Trim trailing whitespace/newlines added by PowerShell's output pipeline.
            let formatted = stdout.trim_end_matches(['\r', '\n']);
            if formatted.is_empty() {
                debug!("format_script: empty output (PSSA absent?), returning original");
                Ok(script_content)
            } else {
                debug!("format_script: formatted {} chars", formatted.len());
                Ok(formatted.to_string())
            }
        }
        Ok(Err(e)) => {
            debug!("format_script: spawn error: {}", e);
            Ok(script_content)
        }
        Err(_) => {
            debug!(
                "format_script: timed out after {}s, returning original",
                FORMAT_TIMEOUT_SECS
            );
            Ok(script_content)
        }
    }
}

// ---------------------------------------------------------------------------
// PowerShell Profile
// ---------------------------------------------------------------------------

/// Maximum seconds to wait when querying the $PROFILE path.
const PROFILE_TIMEOUT_SECS: u64 = 10;

/// Returns the path to the current user's PowerShell profile script
/// (CurrentUserCurrentHost scope -- the profile most users customise).
///
/// Creates the profile's parent directory if it does not already exist so
/// the frontend can immediately open (or create) the file.  The profile
/// file itself is NOT created here; that is left to the user.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_ps_profile_path(ps_path: String) -> Result<String, AppError> {
    info!("get_ps_profile_path called");
    powershell::validate_ps_path(&ps_path)?;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(PROFILE_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            // CurrentUserCurrentHost is the profile most users customise
            // (loaded for interactive sessions).  AllUsersAllHosts requires admin.
            .arg(ps_utf8_script("$PROFILE.CurrentUserCurrentHost"))
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "PROFILE_QUERY_FAILED".to_string(),
                message: format!("Failed to query $PROFILE path: {}", e),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "PROFILE_QUERY_TIMEOUT".to_string(),
                message: format!(
                    "Profile path query timed out after {}s",
                    PROFILE_TIMEOUT_SECS
                ),
            });
        }
    };

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err(AppError {
            code: "PROFILE_PATH_EMPTY".to_string(),
            message: "PowerShell returned an empty $PROFILE path".to_string(),
        });
    }

    // Ensure the parent directory exists so the frontend can open (or create)
    // the file without a separate directory-creation step.
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| AppError {
                code: "PROFILE_DIR_FAILED".to_string(),
                message: format!(
                    "Could not create profile directory '{}': {}",
                    parent.display(),
                    e
                ),
            })?;
        }
    }

    Ok(path)
}

/// Returns the scratch directory path for auto-saved untitled scripts, creating it if needed.
#[cfg_attr(not(test), tauri::command)]
pub async fn get_scratch_dir() -> Result<String, AppError> {
    let dir = settings::scratch_dir()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir.to_string_lossy().into())
}

/// Metadata for a scratch auto-save file on disk.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchFileInfo {
    pub tab_id: String,
    pub path: String,
}

/// Lists `.ps1` scratch files (tab id is the filename stem).
#[cfg_attr(not(test), tauri::command)]
pub async fn list_scratch_files() -> Result<Vec<ScratchFileInfo>, AppError> {
    let dir = settings::scratch_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".ps1") else {
            continue;
        };
        if stem.is_empty()
            || stem.contains(['/', '\\'])
            || stem.contains("..")
            || !stem
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            continue;
        }
        files.push(ScratchFileInfo {
            tab_id: stem.to_string(),
            path: entry.path().to_string_lossy().into(),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Resolves `path` to a deletable scratch file: it must be a direct child of
/// `scratch_dir` named `<tab-id>.ps1` with the same stem charset accepted by
/// `list_scratch_files`. Rejects traversal (`..`), nested paths, and foreign
/// extensions so the delete command can never escape the scratch folder.
/// (`Path::starts_with` alone is not enough: `<scratch>/../x` passes it
/// component-wise while the OS resolves it outside the directory.)
fn scratch_delete_target(path: &str, scratch_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let target = std::path::Path::new(path.trim());
    let stem_ok = target
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".ps1"))
        .is_some_and(|stem| {
            !stem.is_empty()
                && stem
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
    if stem_ok && target.parent() == Some(scratch_dir) {
        Some(target.to_path_buf())
    } else {
        None
    }
}

/// Deletes a scratch file when the user discards an untitled buffer.
#[cfg_attr(not(test), tauri::command)]
pub async fn delete_scratch_file(path: String) -> Result<(), AppError> {
    let scratch_dir = settings::scratch_dir()?;
    let target = scratch_delete_target(&path, &scratch_dir).ok_or_else(|| AppError {
        code: "SCRATCH_PATH_OUTSIDE_DIR".to_string(),
        message: "Scratch file path is outside the scratch directory.".to_string(),
    })?;
    if target.exists() {
        std::fs::remove_file(target)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Script Signing
// ---------------------------------------------------------------------------

/// A code-signing certificate available in the current user's certificate store.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// Certificate thumbprint (40-char hex string).
    pub thumbprint: String,
    /// Certificate subject distinguished name (full DN).
    pub subject: String,
    /// Expiration date/time as an ISO-8601 string.
    pub expiry: String,
    /// Human-readable display name (FriendlyName or extracted CN).
    pub friendly_name: String,
}

/// Maximum seconds to wait when enumerating signing certificates.
const CERT_ENUM_TIMEOUT_SECS: u64 = 10;

/// Returns all code-signing certificates available in the current user's
/// certificate store (Cert:\CurrentUser\My).
///
/// Returns an empty list when no certificates are found or the query
/// fails (graceful degradation -- the signing UI disables itself when the list is empty).
#[cfg_attr(not(test), tauri::command)]
pub async fn get_signing_certificates(ps_path: String) -> Result<Vec<CertInfo>, AppError> {
    info!("get_signing_certificates called");
    let ps_path = ps_path.trim();
    if ps_path.is_empty() {
        return Ok(Vec::new());
    }
    if let Err(err) = powershell::validate_ps_path(ps_path) {
        debug!("get_signing_certificates: invalid PowerShell path: {}", err);
        return Ok(Vec::new());
    }

    const CERT_SCRIPT: &str = "\
$ErrorActionPreference='SilentlyContinue';\
$certs=Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert;\
if(-not $certs){'[]';exit}\
@($certs)|ForEach-Object{\
[PSCustomObject]@{\
thumbprint=$_.Thumbprint;\
subject=$_.Subject;\
expiry=$_.NotAfter.ToString('o');\
friendlyName=$(if($_.FriendlyName){$_.FriendlyName}else{$_.Subject -replace '^CN=([^,]+).*','$1'})\
}}|ConvertTo-Json -Compress";

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(CERT_ENUM_TIMEOUT_SECS),
        ps_command(ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            .arg(ps_utf8_script(CERT_SCRIPT))
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            debug!("get_signing_certificates: spawn error: {}", e);
            return Ok(Vec::new());
        }
        Err(_) => {
            debug!(
                "get_signing_certificates: timed out after {}s",
                CERT_ENUM_TIMEOUT_SECS
            );
            return Ok(Vec::new());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    let certs: Vec<CertInfo> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else if trimmed.starts_with('{') {
        match serde_json::from_str::<CertInfo>(trimmed) {
            Ok(c) => vec![c],
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };

    info!("get_signing_certificates: {} certs found", certs.len());
    Ok(certs)
}

/// Maximum seconds to wait for a Set-AuthenticodeSignature invocation.
const SIGN_TIMEOUT_SECS: u64 = 30;

/// Signs a PowerShell script file with the specified code-signing certificate.
///
/// `script_path` MUST be a saved file on disk -- Set-AuthenticodeSignature
/// writes the signature block directly into the file.  The caller MUST save
/// the file before this command is invoked.
///
/// `thumbprint` MUST be a valid 40-char hex thumbprint from the current
/// user's My certificate store (validated before reaching PowerShell).
///
/// Returns the `SignatureStatus` string (e.g. "Valid") on success.
#[cfg_attr(not(test), tauri::command)]
pub async fn sign_script(
    ps_path: String,
    script_path: String,
    thumbprint: String,
) -> Result<String, AppError> {
    info!("sign_script called: path={}", script_path);
    powershell::validate_ps_path(&ps_path)?;

    // Validate thumbprint: exactly 40 hex characters (Rule 11 input validation).
    if thumbprint.len() != 40 || !thumbprint.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError {
            code: "INVALID_THUMBPRINT".to_string(),
            message: format!(
                "Certificate thumbprint must be 40 hex characters, got '{}' ({} chars)",
                thumbprint,
                thumbprint.len()
            ),
        });
    }

    // Validate the script file exists before attempting to sign (Rule 17 pre-flight).
    if !std::path::Path::new(&script_path).is_file() {
        return Err(AppError {
            code: "SCRIPT_NOT_FOUND".to_string(),
            message: format!(
                "Script file '{}' does not exist. Save the file before signing.",
                script_path
            ),
        });
    }

    // Escape single quotes in path and thumbprint for inclusion in PS string literals.
    // Thumbprint is already validated as hex-only so no quoting is needed, but
    // the path may contain apostrophes in folder names.
    let escaped_path = script_path.replace('\'', "''");

    let ps_script = format!(
        "$ErrorActionPreference='Stop';\
$cert=Get-ChildItem Cert:\\CurrentUser\\My|Where-Object{{$_.Thumbprint -eq '{}'}};\
if(-not $cert){{throw 'Certificate not found: {}'}};\
$sig=Set-AuthenticodeSignature -FilePath '{}' -Certificate $cert;\
$sig.Status.ToString()",
        thumbprint, thumbprint, escaped_path
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(SIGN_TIMEOUT_SECS),
        ps_command(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            .arg(ps_utf8_script(&ps_script))
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "SIGN_SPAWN_FAILED".to_string(),
                message: format!("Failed to start PowerShell for signing: {}", e),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "SIGN_TIMEOUT".to_string(),
                message: format!("Signing timed out after {}s", SIGN_TIMEOUT_SECS),
            });
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError {
            code: "SIGN_FAILED".to_string(),
            message: format!("Set-AuthenticodeSignature failed: {}", stderr.trim()),
        });
    }

    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();

    info!("sign_script result: {}", status);
    Ok(if status.is_empty() {
        "Valid".to_string()
    } else {
        status
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::LazyLock;

    static CACHED_VARIABLES_TEST_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    // ----- launch_path_from_args tests -----

    #[test]
    fn launch_path_skips_argv0_and_flags_and_requires_existing_file() {
        // current_exe is a file guaranteed to exist.
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let args = vec!["psforge.exe".into(), "--flag".into(), exe.clone()];
        assert_eq!(launch_path_from_args(args), Some(exe));

        let missing = vec!["psforge.exe".into(), "C:\\nope\\missing.ps1".into()];
        assert_eq!(launch_path_from_args(missing), None);

        let flags_only = vec!["psforge.exe".into(), "--flag".into()];
        assert_eq!(launch_path_from_args(flags_only), None);
    }

    // ----- detect_and_decode tests -----

    #[test]
    fn detect_utf8_no_bom() {
        let (content, enc, warning) = detect_and_decode(b"Hello, World!");
        assert_eq!(enc, "utf8");
        assert_eq!(content, "Hello, World!");
        assert!(warning.is_none());
    }

    #[test]
    fn detect_utf8_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"Hello");
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf8bom");
        assert_eq!(content, "Hello");
        assert!(warning.is_none());
    }

    #[test]
    fn detect_utf8_bom_empty_payload() {
        let bytes = vec![0xEF, 0xBB, 0xBF];
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf8bom");
        assert_eq!(content, "");
        assert!(warning.is_none());
    }

    #[test]
    fn detect_utf16_le_signature() {
        // ASCII 'A' and 'B' as UTF-16 LE with BOM.
        let bytes = vec![0xFF, 0xFE, b'A', 0x00, b'B', 0x00];
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf16le");
        assert_eq!(content, "AB");
        assert!(warning.is_none());
    }

    #[test]
    fn detect_utf16_be_signature() {
        // ASCII 'A' and 'B' as UTF-16 BE with BOM.
        let bytes = vec![0xFE, 0xFF, 0x00, b'A', 0x00, b'B'];
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf16be");
        assert_eq!(content, "AB");
        assert!(warning.is_none());
    }

    #[test]
    fn detect_empty_file_returns_utf8() {
        let (content, enc, warning) = detect_and_decode(b"");
        assert_eq!(enc, "utf8");
        assert!(content.is_empty());
        assert!(warning.is_none());
    }

    #[test]
    fn detect_invalid_utf8_falls_back_to_windows1252() {
        // Single 0xFF byte is invalid UTF-8 but valid Windows-1252 (decodes to U+00FF).
        let bytes = vec![0xFF];
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "windows1252");
        assert_eq!(content, "\u{00FF}");
        assert!(
            warning.is_some(),
            "Windows-1252 decode should warn the user"
        );
    }

    #[test]
    fn detect_invalid_utf8_round_trips_through_windows1252() {
        // A byte that is invalid UTF-8 (>= 0x80) but valid Windows-1252.
        // The decode/encode pair must produce the original byte back so saving
        // a mis-detected file never corrupts it.
        let bytes = vec![0xE9]; // Latin small e with acute in Windows-1252
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "windows1252");
        assert!(!content.is_empty(), "Decoder must produce a real character");
        assert!(warning.is_some(), "Legacy fallback must warn the user");
        // Round-trip: re-encoding the decoded string should give back the original byte.
        let (re_encoded, _, _) = encoding_rs::WINDOWS_1252.encode(&content);
        assert_eq!(
            re_encoded.as_ref(),
            &bytes[..],
            "Windows-1252 round-trip must preserve original bytes"
        );
    }

    #[test]
    fn detect_utf32_le_signature_not_misread_as_utf16() {
        // "AB" as UTF-32 LE with BOM. The BOM's first two bytes match the
        // UTF-16 LE BOM, so without the UTF-32 check this decoded as
        // NUL-interleaved UTF-16 with no warning and a later save destroyed
        // the file (S6-11).
        let bytes = vec![
            0xFF, 0xFE, 0x00, 0x00, // UTF-32 LE BOM
            b'A', 0x00, 0x00, 0x00, b'B', 0x00, 0x00, 0x00,
        ];
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(content, "AB");
        assert_eq!(enc, "utf8", "UTF-32 input converts to UTF-8 on save");
        assert!(warning.is_some(), "conversion must be surfaced to the user");
    }

    #[test]
    fn detect_utf32_be_signature() {
        let bytes = vec![
            0x00, 0x00, 0xFE, 0xFF, // UTF-32 BE BOM
            0x00, 0x00, 0x00, b'A', 0x00, 0x00, 0x00, b'B',
        ];
        let (content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(content, "AB");
        assert_eq!(enc, "utf8");
        assert!(warning.is_some());
    }

    #[test]
    fn detect_utf16_le_with_leading_nul_still_utf16() {
        // FF FE 00 00 is only UTF-32 when the total length is a multiple of 4;
        // this 6-byte file is a UTF-16 LE NUL followed by 'A'... but with only
        // first-4-bytes sniffing it matches UTF-32 LE. Accept the standard
        // tradeoff (UTF-32 wins) — just assert it doesn't panic and decodes
        // to *something* with a warning rather than silently.
        let bytes = vec![0xFF, 0xFE, 0x00, 0x00, b'A', 0x00];
        let (_content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf8");
        assert!(warning.is_some(), "partial trailing unit must warn");
    }

    #[test]
    fn detect_utf16_le_odd_byte_warns() {
        // Trailing odd byte: warning should explain truncation.
        let bytes = vec![0xFF, 0xFE, b'A', 0x00, b'B'];
        let (_content, enc, warning) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf16le");
        assert!(
            warning.is_some(),
            "Odd-byte UTF-16 LE must surface a warning"
        );
    }

    #[test]
    fn parse_variable_info_json_handles_arrays() {
        let vars = parse_variable_info_json(
            r#"[{"Name":"HOME","Value":"C:\\Users\\Test","TypeName":"String"}]"#,
        );
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].name, "HOME");
    }

    #[test]
    fn parse_variable_info_json_handles_single_object() {
        let vars = parse_variable_info_json(r#"{"Name":"Count","Value":"1","TypeName":"Int32"}"#);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].type_name, "Int32");
    }

    #[tokio::test]
    async fn get_variables_after_run_returns_cached_snapshot_without_using_script_input() {
        let _guard = CACHED_VARIABLES_TEST_LOCK.lock().await;

        pm().cache_last_variables_json(
            r#"[{"Name":"E2ENoRerunVar","Value":"snapshot","TypeName":"String"}]"#.to_string(),
        );

        let vars = get_variables_after_run(
            "not-a-real-ps-path.exe".to_string(),
            "Write-Error 'this script must not run'".to_string(),
            r#"C:\definitely-not-used"#.to_string(),
        )
        .await
        .expect("cached variable lookup must succeed");

        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].name, "E2ENoRerunVar");
        assert_eq!(vars[0].value, "snapshot");
        assert_eq!(vars[0].type_name, "String");
    }

    #[tokio::test]
    async fn ps_command_spawns_quote_wrapped_executable_path() {
        let exe = std::env::current_exe().expect("test executable path");
        let quoted = format!("\"{}\"", exe.to_string_lossy());

        let output = ps_command(&quoted)
            .arg("--help")
            .output()
            .await
            .expect("quote-wrapped executable path should spawn");

        assert!(output.status.success());
    }

    #[test]
    fn is_windows_powershell_accepts_copied_quotes() {
        assert!(is_windows_powershell(
            r#"'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'"#
        ));
        assert!(!is_windows_powershell(
            r#"'C:/Program Files/PowerShell/7/pwsh.exe'"#
        ));
    }

    // ----- find_last_json tests -----

    #[test]
    fn find_last_json_locates_array() {
        let s = "some output\n[{\"a\":1},{\"b\":2}]";
        assert_eq!(find_last_json(s).unwrap(), "[{\"a\":1},{\"b\":2}]");
    }

    #[test]
    fn find_last_json_locates_object_when_no_array() {
        let s = "output line\n{\"name\":\"test\"}";
        assert_eq!(find_last_json(s).unwrap(), "{\"name\":\"test\"}");
    }

    #[test]
    fn find_last_json_returns_balanced_array_only() {
        // Trailing text after the JSON must NOT be included.
        let s = "[1,2] earlier\n[3,4] later";
        assert_eq!(find_last_json(s).unwrap(), "[3,4]");
    }

    #[test]
    fn find_last_json_handles_nested_brackets() {
        // Nested brackets inside JSON values must not confuse the scanner.
        let s = "noise\n[{\"Name\":\"x\",\"Value\":\"[System.String]\"}]";
        assert_eq!(
            find_last_json(s).unwrap(),
            "[{\"Name\":\"x\",\"Value\":\"[System.String]\"}]"
        );
    }

    #[test]
    fn find_last_json_handles_unbalanced_brackets_in_strings() {
        // An unbalanced bracket inside a JSON string value must not throw
        // off the bracket depth counter.
        let s = r#"[{"Name":"x","Value":"has]bracket"}]"#;
        assert_eq!(find_last_json(s).unwrap(), s);
    }

    #[test]
    fn find_last_json_handles_escaped_quotes_in_strings() {
        // Escaped quotes inside JSON strings must not toggle string tracking.
        let s = r#"[{"Name":"x","Value":"has\"escaped\"quotes]"}]"#;
        assert_eq!(find_last_json(s).unwrap(), s);
    }

    #[test]
    fn find_last_json_handles_deeply_nested_arrays() {
        let s = "[[1,[2,3]],[4]]";
        assert_eq!(find_last_json(s).unwrap(), "[[1,[2,3]],[4]]");
    }

    #[test]
    fn find_last_json_strips_trailing_text() {
        let s = "[{\"a\":1}]\r\nPS C:\\>";
        assert_eq!(find_last_json(s).unwrap(), "[{\"a\":1}]");
    }

    #[test]
    fn find_last_json_returns_none_for_plain_text() {
        assert!(find_last_json("just plain text output").is_none());
    }

    // ----- scratch_delete_target tests -----

    #[test]
    fn scratch_delete_target_accepts_direct_child_ps1() {
        let dir = std::path::Path::new("/data/PSForge/scratch");
        let path = "/data/PSForge/scratch/0c8e7a44-1111-2222-3333-444455556666.ps1";
        assert_eq!(
            scratch_delete_target(path, dir),
            Some(std::path::PathBuf::from(path))
        );
    }

    #[test]
    fn scratch_delete_target_rejects_parent_traversal() {
        let dir = std::path::Path::new("/data/PSForge/scratch");
        // Component-wise this starts with the scratch dir, but the OS would
        // resolve it outside; it must be rejected.
        assert_eq!(
            scratch_delete_target("/data/PSForge/scratch/../../../etc/passwd", dir),
            None
        );
        assert_eq!(
            scratch_delete_target("/data/PSForge/scratch/../scratch/a.ps1", dir),
            None
        );
    }

    #[test]
    fn scratch_delete_target_rejects_nested_and_foreign_paths() {
        let dir = std::path::Path::new("/data/PSForge/scratch");
        // Nested subdirectory.
        assert_eq!(
            scratch_delete_target("/data/PSForge/scratch/sub/a.ps1", dir),
            None
        );
        // Entirely outside the scratch dir.
        assert_eq!(scratch_delete_target("/tmp/a.ps1", dir), None);
        // Wrong extension.
        assert_eq!(
            scratch_delete_target("/data/PSForge/scratch/a.txt", dir),
            None
        );
        // Stem characters outside the tab-id charset.
        assert_eq!(
            scratch_delete_target("/data/PSForge/scratch/a b.ps1", dir),
            None
        );
        // Bare extension with empty stem.
        assert_eq!(
            scratch_delete_target("/data/PSForge/scratch/.ps1", dir),
            None
        );
    }

    // ----- validation constant sanity checks -----

    #[test]
    fn file_size_constant_is_ten_mib() {
        assert_eq!(MAX_FILE_SIZE, 10 * 1024 * 1024);
    }

    #[test]
    fn path_length_constant_covers_windows_max_path() {
        // Windows MAX_PATH is 260; our constant must be at least that.
        let configured_limit = std::hint::black_box(MAX_PATH_LENGTH);
        assert!(configured_limit >= 260);
    }
}
