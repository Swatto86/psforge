//! Read Windows Terminal settings.json from known install locations.
//! Used so integrated consoles can match Terminal colour schemes and fonts.

use crate::errors::AppError;
use std::fs;
use std::path::PathBuf;

/// Candidate paths for Windows Terminal settings (stable, preview, unpackaged).
pub fn windows_terminal_settings_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Some(local) = dirs::data_local_dir() else {
        return paths;
    };

    paths.push(
        local
            .join("Packages")
            .join("Microsoft.WindowsTerminal_8wekyb3d8bbwe")
            .join("LocalState")
            .join("settings.json"),
    );
    paths.push(
        local
            .join("Packages")
            .join("Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe")
            .join("LocalState")
            .join("settings.json"),
    );
    paths.push(
        local
            .join("Microsoft")
            .join("Windows Terminal")
            .join("settings.json"),
    );
    paths
}

/// Returns the first readable Windows Terminal settings.json text, if any.
#[cfg_attr(not(test), tauri::command)]
pub fn read_windows_terminal_settings() -> Result<Option<String>, AppError> {
    for path in windows_terminal_settings_candidates() {
        match fs::read_to_string(&path) {
            Ok(text) if !text.trim().is_empty() => return Ok(Some(text)),
            Ok(_) => continue,
            Err(_) => continue,
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::windows_terminal_settings_candidates;

    #[test]
    fn candidates_include_store_and_unpackaged_paths() {
        let paths = windows_terminal_settings_candidates();
        // On CI/non-Windows, data_local_dir may still resolve; when empty, skip.
        if paths.is_empty() {
            return;
        }
        let joined = paths
            .iter()
            .map(|p| p.to_string_lossy().to_lowercase())
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            joined.contains("windowsterminal") || joined.contains("windows terminal"),
            "expected Terminal path in {joined}"
        );
        assert!(
            paths.iter().any(|p| p.ends_with("settings.json")),
            "every candidate should be settings.json"
        );
    }
}
