//! Detect and install PSScriptAnalyzer for a given PowerShell host
//! (Windows PowerShell 5.1 and PowerShell 7+), CurrentUser scope only.

use crate::errors::AppError;
use crate::powershell;
#[cfg(not(windows))]
use crate::win_compat::CommandExt;
use log::debug;
use serde::{Deserialize, Serialize};

const CHECK_TIMEOUT_SECS: u64 = 20;
const INSTALL_TIMEOUT_SECS: u64 = 180;

/// Status of PSScriptAnalyzer for one PowerShell executable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PssaModuleStatus {
    pub installed: bool,
    pub version: String,
    /// Short host label (e.g. "7.4.5" or "5.1").
    pub host_version: String,
    pub message: String,
}

/// Result of an install attempt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PssaInstallResult {
    /// "present" | "installed" | "failed"
    pub status: String,
    pub version: String,
    pub message: String,
}

const CHECK_PSSA_PS: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$hv = $PSVersionTable.PSVersion.ToString()
$mod = Get-Module -ListAvailable -Name PSScriptAnalyzer |
    Sort-Object Version -Descending |
    Select-Object -First 1
if ($mod) {
    [pscustomobject]@{
        installed   = $true
        version     = [string]$mod.Version
        hostVersion = $hv
        message     = 'PSScriptAnalyzer is installed'
    } | ConvertTo-Json -Compress
} else {
    [pscustomobject]@{
        installed   = $false
        version     = ''
        hostVersion = $hv
        message     = 'PSScriptAnalyzer is not installed'
    } | ConvertTo-Json -Compress
}
"#;

/// Install script works on Windows PowerShell 5.1 and PowerShell 7+.
/// CurrentUser only; enables TLS 1.2 and NuGet for Gallery on 5.1.
const INSTALL_PSSA_PS: &str = r#"
$ErrorActionPreference = 'Stop'
try {
    try {
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.ServicePointManager]::SecurityProtocol -bor `
            [Net.SecurityProtocolType]::Tls12
    } catch {}

    $existing = Get-Module -ListAvailable -Name PSScriptAnalyzer |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($existing) {
        Import-Module PSScriptAnalyzer -Force -ErrorAction SilentlyContinue
        [pscustomobject]@{
            status  = 'present'
            version = [string]$existing.Version
            message = 'PSScriptAnalyzer already installed'
        } | ConvertTo-Json -Compress
        exit 0
    }

    if ($PSVersionTable.PSVersion.Major -lt 6) {
        $nuget = Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue
        if (-not $nuget -or [version]$nuget.Version -lt [version]'2.8.5.201') {
            Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 `
                -Force -Scope CurrentUser -ErrorAction Stop | Out-Null
        }
    }

    $repo = Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue
    if ($repo -and $repo.InstallationPolicy -ne 'Trusted') {
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
    }

    Install-Module -Name PSScriptAnalyzer -Scope CurrentUser -Force `
        -AllowClobber -Repository PSGallery -ErrorAction Stop
    Import-Module PSScriptAnalyzer -Force -ErrorAction Stop
    $mod = Get-Module -ListAvailable -Name PSScriptAnalyzer |
        Sort-Object Version -Descending |
        Select-Object -First 1
    [pscustomobject]@{
        status  = 'installed'
        version = if ($mod) { [string]$mod.Version } else { '' }
        message = 'PSScriptAnalyzer installed for CurrentUser'
    } | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{
        status  = 'failed'
        version = ''
        message = [string]$_.Exception.Message
    } | ConvertTo-Json -Compress
}
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

async fn run_ps_json(ps_path: &str, script: &str, timeout_secs: u64) -> Result<String, AppError> {
    let ps_path = ps_path.trim();
    if ps_path.is_empty() {
        return Err(AppError {
            code: "INVALID_PS_PATH".to_string(),
            message: "PowerShell path is empty".to_string(),
        });
    }
    powershell::validate_ps_path(ps_path)?;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        ps_command(ps_path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
            ])
            .arg(ps_utf8_script(script))
            .creation_flags(0x0800_0000)
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError {
                code: "PS_SPAWN_FAILED".to_string(),
                message: format!("Failed to start PowerShell: {e}"),
            });
        }
        Err(_) => {
            return Err(AppError {
                code: "PS_TIMEOUT".to_string(),
                message: format!("PowerShell timed out after {timeout_secs}s"),
            });
        }
    };

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn empty_status(message: &str) -> PssaModuleStatus {
    PssaModuleStatus {
        installed: false,
        version: String::new(),
        host_version: String::new(),
        message: message.to_string(),
    }
}

/// Returns whether PSScriptAnalyzer is available for `ps_path`.
#[cfg_attr(not(test), tauri::command)]
pub async fn check_psscriptanalyzer(ps_path: String) -> Result<PssaModuleStatus, AppError> {
    debug!("check_psscriptanalyzer for {}", ps_path);
    let stdout = match run_ps_json(&ps_path, CHECK_PSSA_PS, CHECK_TIMEOUT_SECS).await {
        Ok(s) => s,
        Err(e) => return Ok(empty_status(&e.message)),
    };
    if stdout.is_empty() {
        return Ok(empty_status("No response from PowerShell"));
    }
    match serde_json::from_str::<PssaModuleStatus>(&stdout) {
        Ok(status) => Ok(status),
        Err(e) => {
            debug!("check_psscriptanalyzer JSON error: {} | {}", e, stdout);
            Ok(empty_status("Could not read module status"))
        }
    }
}

/// Installs PSScriptAnalyzer for CurrentUser on the given PowerShell host.
#[cfg_attr(not(test), tauri::command)]
pub async fn install_psscriptanalyzer(ps_path: String) -> Result<PssaInstallResult, AppError> {
    debug!("install_psscriptanalyzer for {}", ps_path);
    let stdout = match run_ps_json(&ps_path, INSTALL_PSSA_PS, INSTALL_TIMEOUT_SECS).await {
        Ok(s) => s,
        Err(e) => {
            return Ok(PssaInstallResult {
                status: "failed".to_string(),
                version: String::new(),
                message: e.message,
            });
        }
    };
    if stdout.is_empty() {
        return Ok(PssaInstallResult {
            status: "failed".to_string(),
            version: String::new(),
            message: "No response from PowerShell during install".to_string(),
        });
    }
    match serde_json::from_str::<PssaInstallResult>(&stdout) {
        Ok(result) => Ok(result),
        Err(e) => {
            debug!("install_psscriptanalyzer JSON error: {} | {}", e, stdout);
            Ok(PssaInstallResult {
                status: "failed".to_string(),
                version: String::new(),
                message: format!(
                    "Unexpected install output: {}",
                    stdout.chars().take(200).collect::<String>()
                ),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_script_targets_gallery_current_user() {
        assert!(INSTALL_PSSA_PS.contains("Install-Module -Name PSScriptAnalyzer"));
        assert!(INSTALL_PSSA_PS.contains("-Scope CurrentUser"));
        assert!(INSTALL_PSSA_PS.contains("Tls12"));
        assert!(INSTALL_PSSA_PS.contains("Install-PackageProvider -Name NuGet"));
        assert!(INSTALL_PSSA_PS.contains("Import-Module PSScriptAnalyzer"));
    }

    #[test]
    fn check_script_reports_host_version() {
        assert!(CHECK_PSSA_PS.contains("hostVersion"));
        assert!(CHECK_PSSA_PS.contains("Get-Module -ListAvailable -Name PSScriptAnalyzer"));
    }

    #[test]
    fn parses_status_and_result_json() {
        let status: PssaModuleStatus = serde_json::from_str(
            r#"{"installed":true,"version":"1.23.0","hostVersion":"7.4.5","message":"ok"}"#,
        )
        .unwrap();
        assert!(status.installed);
        assert_eq!(status.version, "1.23.0");

        let result: PssaInstallResult =
            serde_json::from_str(r#"{"status":"installed","version":"1.23.0","message":"done"}"#)
                .unwrap();
        assert_eq!(result.status, "installed");
    }

    #[tokio::test]
    async fn check_psscriptanalyzer_returns_shape_on_live_pwsh() {
        let Some(pwsh) = find_pwsh() else {
            eprintln!("skip: pwsh not on PATH");
            return;
        };
        let status = check_psscriptanalyzer(pwsh.to_string_lossy().into_owned())
            .await
            .expect("check must not hard-fail");
        assert!(
            !status.host_version.is_empty() || !status.message.is_empty(),
            "expected hostVersion or message, got {status:?}"
        );
        // Known field: message always set by the script or empty_status
        assert!(!status.message.is_empty());
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
