//! Editor diagnostics: built-in PowerShell AST parse errors, plus optional
//! PSScriptAnalyzer when the module is installed (no Install-Module required
//! for red squiggles on syntax/parse failures).

use crate::errors::AppError;
use crate::powershell;
use crate::utils::write_secure_temp_file;
#[cfg(not(windows))]
use crate::win_compat::CommandExt;
use log::debug;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const ANALYSIS_TIMEOUT_SECS: u64 = 12;

/// Diagnostic for Monaco Problems / squiggles. Line/column are 1-indexed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PssaDiagnostic {
    pub message: String,
    /// "Error", "Warning", "Information", or "ParseError".
    pub severity: String,
    /// "Parser" for built-in AST errors, or a PSSA rule name.
    pub rule_name: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// Combined analyzer: always `Parser::ParseInput`, then PSSA if available.
const ANALYZE_SCRIPT_PS: &str = r#"
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
$path = $env:PSFORGE_ANALYZE_PATH
if (-not $path -or -not (Test-Path -LiteralPath $path)) { '[]'; exit 0 }
$__s = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
$__tokens = $null
$__errs = $null
$__ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $__s, [ref]$__tokens, [ref]$__errs)
$__out = New-Object System.Collections.ArrayList
foreach ($e in @($__errs)) {
    if ($null -eq $e) { continue }
    $ext = $e.Extent
    [void]$__out.Add([pscustomobject]@{
        message   = [string]$e.Message
        severity  = 'ParseError'
        ruleName  = 'Parser'
        line      = [int]$ext.StartLineNumber
        column    = [int]$ext.StartColumnNumber
        endLine   = [int]$ext.EndLineNumber
        endColumn = [int]$ext.EndColumnNumber
    })
}
if ($__ast) {
    $typeAsts = $null
    try {
        $typeAsts = @($__ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.TypeDefinitionAst]
        }, $true))
    } catch {
        $typeAsts = @()
    }
    if ($typeAsts.Count -gt 0) {
        $classInfo = @{}
        foreach ($t in $typeAsts) {
            $ctors = @($t.Members | Where-Object {
                $_ -is [System.Management.Automation.Language.FunctionMemberAst] -and
                $_.Name -eq $t.Name
            })
            $hasParamless = @($ctors | Where-Object { $_.Parameters.Count -eq 0 }).Count -gt 0
            $classInfo[[string]$t.Name] = @{ HasParamlessCtor = $hasParamless }
        }
        foreach ($t in $typeAsts) {
            if ($t.BaseTypes.Count -eq 0) { continue }
            $baseName = [string]$t.BaseTypes[0].TypeName.FullName
            if (-not $classInfo.ContainsKey($baseName)) { continue }
            if ($classInfo[$baseName].HasParamlessCtor) { continue }
            $derivedCtors = @($t.Members | Where-Object {
                $_ -is [System.Management.Automation.Language.FunctionMemberAst] -and
                $_.Name -eq $t.Name
            })
            if ($derivedCtors.Count -gt 0) { continue }
            $ext = $t.Extent
            [void]$__out.Add([pscustomobject]@{
                message   = "Base class '$baseName' does not contain a parameterless constructor."
                severity  = 'ParseError'
                ruleName  = 'Parser'
                line      = [int]$ext.StartLineNumber
                column    = [int]$ext.StartColumnNumber
                endLine   = [int]$ext.EndLineNumber
                endColumn = [int]$ext.EndColumnNumber
            })
        }
    }
}
if (Get-Module -ListAvailable -Name PSScriptAnalyzer) {
    Import-Module PSScriptAnalyzer -ErrorAction SilentlyContinue
    $d = Invoke-ScriptAnalyzer -Path $path -ErrorAction SilentlyContinue
    foreach ($x in @($d)) {
        if ($null -eq $x) { continue }
        [void]$__out.Add([pscustomobject]@{
            message   = [string]$x.Message
            severity  = [string]$x.Severity
            ruleName  = [string]$x.RuleName
            line      = [int]$x.Extent.StartLineNumber
            column    = [int]$x.Extent.StartColumnNumber
            endLine   = [int]$x.Extent.EndLineNumber
            endColumn = [int]$x.Extent.EndColumnNumber
        })
    }
}
if ($__out.Count -eq 0) { '[]'; exit 0 }
@($__out.ToArray()) | ConvertTo-Json -Compress
"#;

fn ps_command(ps_path: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(powershell::normalize_ps_path(ps_path));
    cmd.kill_on_drop(true);
    cmd
}

fn ps_utf8_script(script: &str) -> String {
    format!(
        "$psforgeUtf8 = [System.Text.UTF8Encoding]::new($false); \
         [Console]::OutputEncoding = $psforgeUtf8; \
         $OutputEncoding = $psforgeUtf8; {script}"
    )
}

fn extract_json_payload(raw: &str) -> &str {
    let trimmed = raw.trim();
    // Windows PowerShell may append CLIXML progress after JSON; take the
    // outermost JSON array/object so serde_json does not fail on junk.
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            if end >= start {
                return &trimmed[start..=end];
            }
        }
    }
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if end >= start {
                return &trimmed[start..=end];
            }
        }
    }
    trimmed
}

fn parse_diagnostics_json(trimmed: &str) -> Vec<PssaDiagnostic> {
    let payload = extract_json_payload(trimmed);
    if payload.is_empty() || payload == "[]" {
        return Vec::new();
    }
    if payload.starts_with('[') {
        serde_json::from_str(payload).unwrap_or_default()
    } else {
        match serde_json::from_str::<PssaDiagnostic>(payload) {
            Ok(single) => vec![single],
            Err(e) => {
                debug!("analyze_script: JSON parse error: {} | raw: {}", e, trimmed);
                Vec::new()
            }
        }
    }
}

fn dedupe_diagnostics(diags: Vec<PssaDiagnostic>) -> Vec<PssaDiagnostic> {
    let mut seen = HashSet::new();
    diags
        .into_iter()
        .filter(|d| {
            seen.insert((
                d.line,
                d.column,
                d.end_line,
                d.end_column,
                d.message.clone(),
            ))
        })
        .collect()
}

/// Runs built-in PowerShell parse diagnostics (and optional PSSA) on `script_content`.
///
/// Always reports AST/`Parser::ParseInput` errors when PowerShell is available.
/// When PSScriptAnalyzer is installed, its findings are merged in. Failures and
/// timeouts return an empty list (editor must not crash).
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

    let temp_path = write_secure_temp_file("psforge_analyze", ".ps1", script_content.as_bytes())
        .map_err(|e| AppError {
            code: "TEMP_WRITE_FAILED".to_string(),
            message: format!("Failed to create temp analysis file: {}", e),
        })?;

    let path_env = temp_path.to_string_lossy().into_owned();

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
            .arg(ps_utf8_script(ANALYZE_SCRIPT_PS))
            .env("PSFORGE_ANALYZE_PATH", &path_env)
            .creation_flags(0x0800_0000)
            .output(),
    )
    .await;

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
    let diagnostics = dedupe_diagnostics(parse_diagnostics_json(stdout.trim()));
    debug!("analyze_script: {} diagnostics", diagnostics.len());
    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_diagnostics_json_handles_array_and_single() {
        let one = r#"{"message":"Unexpected token","severity":"ParseError","ruleName":"Parser","line":1,"column":1,"endLine":1,"endColumn":2}"#;
        let diags = parse_diagnostics_json(one);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].rule_name, "Parser");
        assert!(diags[0].message.contains("Unexpected"));

        let empty = parse_diagnostics_json("[]");
        assert!(empty.is_empty());
    }

    #[test]
    fn parse_diagnostics_json_strips_trailing_clixml() {
        let polluted = r#"[{"message":"Unexpected token '(' in expression or statement.","severity":"ParseError","ruleName":"Parser","line":126,"column":40,"endLine":126,"endColumn":41}]
#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN></Obj></Objs>"#;
        let diags = parse_diagnostics_json(polluted);
        assert_eq!(
            diags.len(),
            1,
            "CLIXML after JSON must not wipe diagnostics"
        );
        assert_eq!(diags[0].line, 126);
        assert!(diags[0].message.contains("Unexpected token"));
    }

    #[test]
    fn dedupe_diagnostics_drops_identical_rows() {
        let d = PssaDiagnostic {
            message: "x".into(),
            severity: "ParseError".into(),
            rule_name: "Parser".into(),
            line: 2,
            column: 5,
            end_line: 2,
            end_column: 6,
        };
        let out = dedupe_diagnostics(vec![d.clone(), d]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn analyze_snippet_contains_builtin_parser() {
        assert!(
            ANALYZE_SCRIPT_PS.contains("Parser]::ParseInput"),
            "analyze path must use the built-in AST parser"
        );
        assert!(
            ANALYZE_SCRIPT_PS.contains("ruleName  = 'Parser'"),
            "parse errors must be tagged ruleName Parser"
        );
        assert!(
            ANALYZE_SCRIPT_PS.contains("TypeDefinitionAst"),
            "analyze path must validate class inheritance"
        );
    }

    /// Live gate: implicit derived ctor with non-parameterless base is reported.
    #[tokio::test]
    async fn analyze_script_reports_class_inheritance_errors() {
        let Some(pwsh) = find_pwsh() else {
            eprintln!("skip: pwsh not on PATH");
            return;
        };

        let broken = "class Pet { Pet([string]$n) { } }\nclass Dog : Pet { [string] Speak() { 'x' } }\n";
        let diags = analyze_script(pwsh.to_string_lossy().into_owned(), broken.to_string())
            .await
            .expect("analyze_script must not error");

        assert!(
            diags.iter().any(|d| {
                d.rule_name == "Parser"
                    && d.line == 2
                    && d.message.contains("parameterless constructor")
            }),
            "expected class inheritance diagnostic, got: {diags:?}"
        );
    }

    /// Live gate: syntax errors must surface without PSScriptAnalyzer installed.
    #[tokio::test]
    async fn analyze_script_reports_parser_errors_without_pssa() {
        let Some(pwsh) = find_pwsh() else {
            eprintln!("skip: pwsh not on PATH");
            return;
        };

        let broken = "$($$('abc123' -match '\\d{2}'))\nclass Dog : Pet { [string] Speak() { return 'x' } }\n";
        let diags = analyze_script(pwsh.to_string_lossy().into_owned(), broken.to_string())
            .await
            .expect("analyze_script must not error");

        assert!(
            !diags.is_empty(),
            "expected parser diagnostics for broken script, got none"
        );
        assert!(
            diags.iter().any(|d| d.rule_name == "Parser"),
            "expected at least one Parser diagnostic, got: {diags:?}"
        );
        assert!(
            diags.iter().any(|d| d.severity == "ParseError"),
            "expected ParseError severity, got: {diags:?}"
        );
        // Known-present phrasing from PowerShell's parser for $$ (
        assert!(
            diags
                .iter()
                .any(|d| d.message.to_ascii_lowercase().contains("token")
                    || d.message.to_ascii_lowercase().contains("type")),
            "expected a recognizable parser message, got: {diags:?}"
        );

        let clean = analyze_script(
            pwsh.to_string_lossy().into_owned(),
            "$x = 1\nWrite-Output $x\n".to_string(),
        )
        .await
        .expect("clean analyze");
        assert!(
            !clean.iter().any(|d| d.rule_name == "Parser"),
            "clean script must not report Parser errors: {clean:?}"
        );
    }

    fn find_pwsh() -> Option<std::path::PathBuf> {
        let candidates = if cfg!(windows) {
            vec![
                std::path::PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
                std::path::PathBuf::from(r"C:\Program Files\PowerShell\7-preview\pwsh.exe"),
            ]
        } else {
            Vec::new()
        };
        for path in candidates {
            if path.is_file() {
                return Some(path);
            }
        }
        which_pwsh_from_path()
    }

    fn which_pwsh_from_path() -> Option<std::path::PathBuf> {
        let path = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(if cfg!(windows) { "pwsh.exe" } else { "pwsh" });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
}
