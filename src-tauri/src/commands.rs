/// PSForge Tauri command handlers.
/// Each function annotated with #[tauri::command] is callable from the frontend via invoke().
use crate::errors::{AppError, BatchResult};
use crate::powershell::{self, OutputLine, ProcessManager};
use crate::settings::{self, AppSettings};
use crate::utils::{with_retry, write_secure_temp_file};
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
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

/// Returns the global ProcessManager, initializing it on first access.
fn pm() -> &'static ProcessManager {
    PROCESS_MANAGER.get_or_init(ProcessManager::new)
}

// ---------------------------------------------------------------------------
// Script Execution
// ---------------------------------------------------------------------------

/// Executes a complete PowerShell script. Output is streamed via Tauri events.
#[tauri::command]
pub async fn execute_script(
    window: Window,
    ps_path: String,
    script: String,
    working_dir: String,
    exec_policy: String,
    script_args: Option<Vec<String>>,
) -> Result<i32, AppError> {
    info!("execute_script called with ps_path={}", ps_path);
    powershell::validate_ps_path(&ps_path)?;

    let win = window.clone();
    let exit_code = pm()
        .execute(
            &ps_path,
            &script,
            &working_dir,
            &exec_policy,
            script_args.as_deref().unwrap_or(&[]),
            move |line: OutputLine| {
                if let Err(e) = win.emit("ps-output", &line) {
                    error!("Failed to emit ps-output event: {}", e);
                }
            },
        )
        .await?;

    // Emit completion event
    window
        .emit("ps-complete", exit_code)
        .map_err(|e| AppError {
            code: "EMIT_FAILED".to_string(),
            message: format!("Failed to emit completion event: {}", e),
        })?;

    Ok(exit_code)
}

/// Executes a selection of PowerShell code. Same as execute_script but semantically
/// indicates it was a partial selection (F8 behaviour).
#[tauri::command]
pub async fn execute_selection(
    window: Window,
    ps_path: String,
    selection: String,
    working_dir: String,
    exec_policy: String,
) -> Result<i32, AppError> {
    info!("execute_selection called");
    execute_script(window, ps_path, selection, working_dir, exec_policy, None).await
}

/// Stops the currently running PowerShell process.
#[tauri::command]
pub async fn stop_script() -> Result<(), AppError> {
    info!("stop_script called");
    pm().stop().await
}

/// Sends text to the running process's stdin (for Read-Host support).
#[tauri::command]
pub async fn send_stdin(input: String) -> Result<(), AppError> {
    debug!("send_stdin called");
    pm().send_stdin(&input).await
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
$__ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $__s, [ref]$null, [ref]$null)
$__pb = $__ast.Find(
    { param($a) $a -is [System.Management.Automation.Language.ParamBlockAst] },
    $true)
if ($null -eq $__pb) { '[]'; exit }
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
                    try { $__help = $__n.Argument.Value } catch {}
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
if ($__r.Count -eq 0) { '[]' } else { $__r | ConvertTo-Json -Compress }
"#;

/// Metadata for a single parameter in a script's param() block.
/// Mirrors the `ScriptParameter` TypeScript type in src/types.ts.
#[derive(Debug, Serialize, Deserialize)]
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

/// Inspects the param() block of a PowerShell script using the PS AST and
/// returns metadata for each declared parameter.
///
/// Implemented as a fire-and-forget subprocess so:
///  - The caller can detect mandatory params before committing to a run.
///  - Failures degrade gracefully (returns empty vec, caller runs as-is).
///
/// The script content is passed via a dedicated environment variable
/// (PSFORGE_SCRIPT_CONTENT) to avoid all shell-escaping hazards.
/// Windows env-var size limit is ~32 767 chars; scripts larger than that
/// will be skipped (the command will return an empty list and the frontend
/// will fall through to a normal run).
#[tauri::command]
pub async fn get_script_parameters(
    ps_path: String,
    script: String,
) -> Result<Vec<ScriptParameterInfo>, AppError> {
    info!("get_script_parameters called");
    powershell::validate_ps_path(&ps_path)?;

    if script.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Windows environment variables are capped at ~32 767 chars.
    // Silently skip inspection for extremely large scripts rather than failing.
    const MAX_ENV_SCRIPT_BYTES: usize = 32_000;
    if script.len() > MAX_ENV_SCRIPT_BYTES {
        debug!(
            "Script too large for param inspection ({} bytes), skipping",
            script.len()
        );
        return Ok(Vec::new());
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(PARAM_INSPECT_TIMEOUT_SECS),
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
                PARAM_INSPECT_SCRIPT,
            ])
            .env("PSFORGE_SCRIPT_CONTENT", &script)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            // Log and gracefully degrade: caller will run the script as-is.
            debug!("get_script_parameters spawn failed: {}", e);
            return Ok(Vec::new());
        }
        Err(_) => {
            debug!(
                "get_script_parameters timed out after {}s",
                PARAM_INSPECT_TIMEOUT_SECS
            );
            return Ok(Vec::new());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    if trimmed.starts_with('[') {
        Ok(serde_json::from_str(trimmed).unwrap_or_default())
    } else if trimmed.starts_with('{') {
        // Single parameter: PS emits an object, not an array, for exactly one item.
        let single: ScriptParameterInfo =
            serde_json::from_str(trimmed).unwrap_or_else(|_| ScriptParameterInfo {
                name: String::new(),
                type_name: "String".to_string(),
                is_mandatory: false,
                has_default: false,
                position: None,
                help_message: String::new(),
            });
        if single.name.is_empty() {
            Ok(Vec::new())
        } else {
            Ok(vec![single])
        }
    } else {
        Ok(Vec::new())
    }
}

// ---------------------------------------------------------------------------
// PowerShell Discovery
// ---------------------------------------------------------------------------

/// Returns all discovered PowerShell installations on the system.
/// Runs discovery in a blocking thread pool so the async runtime is not stalled
/// by `where.exe` invocations and filesystem scans (Rule 2 -- no blocking in async).
#[tauri::command]
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
/// Any path ending with `pwsh.exe` (or `pwsh`) is PowerShell 6+ and supports
/// the additional `-SkipEditionCheck` flag on `Get-Module`.
fn is_windows_powershell(ps_path: &str) -> bool {
    let normalized = ps_path.to_lowercase().trim_end_matches('"').to_string();
    normalized.ends_with("powershell.exe") || normalized == "powershell"
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
#[tauri::command]
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
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
                command,
            ])
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

    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    // PowerShell returns a single object (not array) when there is exactly one module.
    let modules: Vec<ModuleInfo> = if stdout.trim().starts_with('[') {
        serde_json::from_str(&stdout).map_err(|e| AppError {
            code: "MODULE_PARSE_FAILED".to_string(),
            message: format!(
                "Failed to parse module list JSON ({}). First 200 chars: {}",
                e,
                &stdout[..stdout.len().min(200)]
            ),
        })?
    } else {
        let single: ModuleInfo = serde_json::from_str(&stdout).map_err(|e| AppError {
            code: "MODULE_PARSE_FAILED".to_string(),
            message: format!(
                "Failed to parse single-module JSON ({}). First 200 chars: {}",
                e,
                &stdout[..stdout.len().min(200)]
            ),
        })?;
        vec![single]
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

/// Returns exported commands for a specific module.
#[tauri::command]
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
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
                &script,
            ])
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

    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    let commands: Vec<CommandInfo> = if stdout.trim().starts_with('[') {
        serde_json::from_str(&stdout)?
    } else {
        let single: CommandInfo = serde_json::from_str(&stdout)?;
        vec![single]
    };

    Ok(commands)
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

/// Runs Get-Variable in a new PS process to capture variable state.
/// In practice, this is run after script completion and returns built-in + user variables.
#[tauri::command]
pub async fn get_variables_after_run(
    ps_path: String,
    script: String,
    working_dir: String,
) -> Result<Vec<VariableInfo>, AppError> {
    info!("get_variables_after_run called");
    powershell::validate_ps_path(&ps_path)?;

    let combined_script = format!(
        "{}\nGet-Variable | Where-Object {{ $_.Name -notmatch '^(\\?|args|input|MyInvocation|PSBoundParameters|PSCommandPath|PSScriptRoot)$' }} | Select-Object Name, @{{N='Value';E={{if ($_.Value -ne $null) {{ $_.Value.ToString() }} else {{ '<null>' }}}}}}, @{{N='TypeName';E={{if ($_.Value -ne $null) {{ $_.Value.GetType().Name }} else {{ 'Null' }}}}}} | ConvertTo-Json -Compress",
        script
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(MODULE_TIMEOUT_SECS),
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
                &combined_script,
            ])
            .current_dir(&working_dir)
            .creation_flags(0x08000000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "VARIABLE_ENUM_FAILED".to_string(),
                message: format!("Failed to retrieve variables: {}", e),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "VARIABLE_ENUM_TIMEOUT".to_string(),
                message: format!(
                    "Variable retrieval timed out after {}s",
                    MODULE_TIMEOUT_SECS
                ),
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Find the last JSON array or object in stdout (script output may precede it)
    let json_str = find_last_json(&stdout).unwrap_or(&stdout);

    let variables: Vec<VariableInfo> = if json_str.trim().starts_with('[') {
        serde_json::from_str(json_str).unwrap_or_default()
    } else {
        match serde_json::from_str::<VariableInfo>(json_str) {
            Ok(single) => vec![single],
            Err(_) => Vec::new(),
        }
    };

    Ok(variables)
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
            while i >= 1 + bs && bytes[i - 1 - bs] == b'\\' {
                bs += 1;
            }
            if bs % 2 == 0 {
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
}

/// Reads a file's content, detecting encoding.
#[tauri::command]
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
    let (content, encoding) = detect_and_decode(&bytes);

    Ok(FileContent {
        content,
        encoding,
        path,
    })
}

/// Saves content to a file with the specified encoding.
#[tauri::command]
pub async fn save_file_content(
    path: String,
    content: String,
    encoding: String,
) -> Result<(), AppError> {
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
        _ => content.into_bytes(), // utf8 (no BOM)
    };

    with_retry("save_file_content", || std::fs::write(&path, &bytes))?;
    Ok(())
}

/// Detects encoding from BOM and decodes bytes to a string.
fn detect_and_decode(bytes: &[u8]) -> (String, String) {
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        // UTF-8 BOM
        (
            String::from_utf8_lossy(&bytes[3..]).to_string(),
            "utf8bom".to_string(),
        )
    } else if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16 LE
        let payload = &bytes[2..];
        if payload.len() % 2 != 0 {
            warn!(
                "UTF-16 LE file has odd byte count ({}); trailing byte dropped",
                bytes.len()
            );
        }
        let u16_iter = payload
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
        let decoded: String = char::decode_utf16(u16_iter)
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect();
        (decoded, "utf16le".to_string())
    } else if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        // UTF-16 BE
        let payload = &bytes[2..];
        if payload.len() % 2 != 0 {
            warn!(
                "UTF-16 BE file has odd byte count ({}); trailing byte dropped",
                bytes.len()
            );
        }
        let u16_iter = payload
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]));
        let decoded: String = char::decode_utf16(u16_iter)
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect();
        (decoded, "utf16be".to_string())
    } else {
        // Assume UTF-8 without BOM
        (
            String::from_utf8_lossy(bytes).to_string(),
            "utf8".to_string(),
        )
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Loads user settings from disk.
#[tauri::command]
pub async fn load_settings() -> Result<AppSettings, AppError> {
    settings::load()
}

/// Saves user settings to disk.
#[tauri::command]
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

/// Registers PSForge as the handler for a specific file extension.
/// Uses HKCU (per-user, no admin required).
#[tauri::command]
pub async fn register_file_association(extension: String) -> Result<(), AppError> {
    info!("Registering file association for {}", extension);

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

        // Notify the shell of the change
        notify_shell_assoc_changed();

        info!("File association registered for {}", extension);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = extension;
        return Err(AppError {
            code: "UNSUPPORTED_PLATFORM".to_string(),
            message: "File associations are only supported on Windows".to_string(),
        });
    }

    Ok(())
}

/// Unregisters the PSForge handler for a specific file extension.
#[tauri::command]
pub async fn unregister_file_association(extension: String) -> Result<(), AppError> {
    info!("Unregistering file association for {}", extension);

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

/// Returns the current file association status for all PS extensions.
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
pub async fn get_snippets() -> Result<Vec<Snippet>, AppError> {
    let user_path = settings::snippets_path()?;
    get_snippets_from(user_path)
}

/// Loads snippets from an explicit user-snippets path (for testing).
/// Returns built-in snippets merged with any user snippets at the given path.
pub fn get_snippets_from(user_path: std::path::PathBuf) -> Result<Vec<Snippet>, AppError> {
    let mut snippets = builtin_snippets();
    if user_path.exists() {
        let content = with_retry("read_user_snippets", || std::fs::read_to_string(&user_path))?;
        if let Ok(user_snippets) = serde_json::from_str::<Vec<Snippet>>(&content) {
            snippets.extend(user_snippets);
        }
    }
    Ok(snippets)
}

/// Saves user-defined snippets to disk.
#[tauri::command]
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
    with_retry("save_user_snippets", || {
        std::fs::write(path, json.as_bytes())
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shell Integration
// ---------------------------------------------------------------------------

/// Opens a file path in Windows Explorer, selecting the file.
/// Opens the parent directory on non-Windows platforms.
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), AppError> {
    info!("reveal_in_explorer: {}", path);

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

    #[cfg(not(target_os = "windows"))]
    {
        // Open the parent directory with the platform file manager.
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
const ANALYSIS_TIMEOUT_SECS: u64 = 5;

/// Maximum seconds to wait for a TabExpansion2 completion request.
const COMPLETION_TIMEOUT_SECS: u64 = 3;

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

/// Runs PSScriptAnalyzer on `script_content` and returns structured diagnostics.
///
/// Silently returns an empty list when:
/// - PSScriptAnalyzer module is not installed.
/// - The analysis exceeds `ANALYSIS_TIMEOUT_SECS`.
/// - Any process or JSON-parsing error occurs.
///
/// This ensures the frontend always gets a typed result without crashing the editor
/// (Rule 11 graceful degradation).
#[tauri::command]
pub async fn analyze_script(
    ps_path: String,
    script_content: String,
) -> Result<Vec<PssaDiagnostic>, AppError> {
    debug!("analyze_script called ({} chars)", script_content.len());
    powershell::validate_ps_path(&ps_path)?;

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
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
                &ps_script,
            ])
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
#[tauri::command]
pub async fn get_completions(
    ps_path: String,
    script_content: String,
    cursor_column: usize,
) -> Result<Vec<PsCompletion>, AppError> {
    debug!("get_completions called (cursor_column={})", cursor_column);
    powershell::validate_ps_path(&ps_path)?;

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
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
                &ps_script,
            ])
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
#[tauri::command]
pub async fn get_execution_policy(ps_path: String) -> Result<String, AppError> {
    info!("get_execution_policy called");
    powershell::validate_ps_path(&ps_path)?;

    let output = tokio::process::Command::new(&ps_path)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Get-ExecutionPolicy -Scope CurrentUser",
        ])
        .creation_flags(0x08000000)
        .output()
        .await
        .map_err(|e| AppError {
            code: "EXEC_POLICY_QUERY_FAILED".to_string(),
            message: format!("Failed to query execution policy: {}", e),
        })?;

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
#[tauri::command]
pub async fn set_execution_policy(ps_path: String, policy: String) -> Result<(), AppError> {
    info!("set_execution_policy called with policy={}", policy);
    powershell::validate_ps_path(&ps_path)?;

    // Validate against the allow-list before passing to PowerShell.
    if !ALLOWED_POLICIES
        .iter()
        .any(|p| p.eq_ignore_ascii_case(&policy))
    {
        return Err(AppError {
            code: "INVALID_POLICY".to_string(),
            message: format!(
                "Invalid execution policy '{}'. Allowed: {}",
                policy,
                ALLOWED_POLICIES.join(", ")
            ),
        });
    }

    // Skip the Set-ExecutionPolicy call when the requested value is "Default" --
    // that sentinel means "leave whatever the user has set alone".
    if policy.eq_ignore_ascii_case("Default") {
        return Ok(());
    }

    let script = format!(
        "Set-ExecutionPolicy -ExecutionPolicy {} -Scope CurrentUser -Force",
        policy
    );

    let output = tokio::process::Command::new(&ps_path)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
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

/// Returns the file path passed as the first command-line argument when the
/// application was launched by Windows Explorer via a file-type association
/// (e.g. double-click on a .ps1 file).  Returns `None` when the app was
/// launched normally (no arguments, or the argument is not an existing file).
///
/// The frontend calls this once on mount and, if a path is returned, opens
/// the file immediately so the user sees the file they clicked on.
#[tauri::command]
pub fn get_launch_path() -> Option<String> {
    // Skip argv[0] (the executable path).  The first real argument is the
    // file path passed by Windows when the app is the registered handler.
    // Filter out common Tauri/WebView2 internal flags that start with '--'
    // so they are never mistaken for file paths.
    let path = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;

    // Validate it is an existing file before returning it to the frontend.
    if std::path::Path::new(&path).is_file() {
        info!("Launch path detected: {}", path);
        Some(path)
    } else {
        None
    }
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
#[tauri::command]
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
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                FORMAT_SNIPPET,
            ])
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
#[tauri::command]
pub async fn get_ps_profile_path(ps_path: String) -> Result<String, AppError> {
    info!("get_ps_profile_path called");
    powershell::validate_ps_path(&ps_path)?;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(PROFILE_TIMEOUT_SECS),
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                // CurrentUserCurrentHost is the profile most users customise
                // (loaded for interactive sessions).  AllUsersAllHosts requires admin.
                "$PROFILE.CurrentUserCurrentHost",
            ])
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
#[tauri::command]
pub async fn get_signing_certificates(ps_path: String) -> Result<Vec<CertInfo>, AppError> {
    info!("get_signing_certificates called");
    powershell::validate_ps_path(&ps_path)?;

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
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                CERT_SCRIPT,
            ])
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
#[tauri::command]
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
        tokio::process::Command::new(&ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps_script,
            ])
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

    // ----- detect_and_decode tests -----

    #[test]
    fn detect_utf8_no_bom() {
        let (content, enc) = detect_and_decode(b"Hello, World!");
        assert_eq!(enc, "utf8");
        assert_eq!(content, "Hello, World!");
    }

    #[test]
    fn detect_utf8_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"Hello");
        let (content, enc) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf8bom");
        assert_eq!(content, "Hello");
    }

    #[test]
    fn detect_utf8_bom_empty_payload() {
        let bytes = vec![0xEF, 0xBB, 0xBF];
        let (content, enc) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf8bom");
        assert_eq!(content, "");
    }

    #[test]
    fn detect_utf16_le_signature() {
        // ASCII 'A' and 'B' as UTF-16 LE with BOM.
        let bytes = vec![0xFF, 0xFE, b'A', 0x00, b'B', 0x00];
        let (content, enc) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf16le");
        assert_eq!(content, "AB");
    }

    #[test]
    fn detect_utf16_be_signature() {
        // ASCII 'A' and 'B' as UTF-16 BE with BOM.
        let bytes = vec![0xFE, 0xFF, 0x00, b'A', 0x00, b'B'];
        let (content, enc) = detect_and_decode(&bytes);
        assert_eq!(enc, "utf16be");
        assert_eq!(content, "AB");
    }

    #[test]
    fn detect_empty_file_returns_utf8() {
        let (content, enc) = detect_and_decode(b"");
        assert_eq!(enc, "utf8");
        assert!(content.is_empty());
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

    // ----- validation constant sanity checks -----

    #[test]
    fn file_size_constant_is_ten_mib() {
        assert_eq!(MAX_FILE_SIZE, 10 * 1024 * 1024);
    }

    #[test]
    fn path_length_constant_covers_windows_max_path() {
        // Windows MAX_PATH is 260; our constant must be at least that.
        assert!(MAX_PATH_LENGTH >= 260);
    }
}
