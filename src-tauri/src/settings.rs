/// PSForge settings management.
/// Handles loading, saving, and validating user settings from %APPDATA%/PSForge/settings.json.
use crate::errors::AppError;
use crate::utils::with_retry;
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Maximum number of recent files to track.
#[allow(dead_code)]
const MAX_RECENT_FILES: usize = 20;

/// All user-persisted settings for PSForge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Path to the default PowerShell binary.
    #[serde(default = "default_ps_version")]
    pub default_ps_version: String,

    /// Active theme name or path to custom theme JSON.
    #[serde(default = "default_theme")]
    pub theme: String,

    /// Editor font size in pixels.
    #[serde(default = "default_font_size")]
    pub font_size: u32,

    /// Editor font family CSS value.
    #[serde(default = "default_font_family")]
    pub font_family: String,

    /// Whether word wrap is enabled in the editor.
    #[serde(default)]
    pub word_wrap: bool,

    /// Number of spaces per tab stop in the editor.
    #[serde(default = "default_tab_size")]
    pub tab_size: u32,

    /// When true the editor inserts spaces instead of tab characters.
    #[serde(default = "default_true")]
    pub insert_spaces: bool,

    /// Whether to show the Monaco minimap on the right edge.
    #[serde(default)]
    pub show_minimap: bool,

    /// Line number display style: "on", "off", or "relative".
    #[serde(default = "default_line_numbers")]
    pub line_numbers: String,

    /// Which whitespace characters to render: "none", "selection", "boundary", "all".
    #[serde(default = "default_render_whitespace")]
    pub render_whitespace: String,

    /// Show indent guides in the gutter.
    #[serde(default = "default_true")]
    pub show_indent_guides: bool,

    /// Sticky scroll: pin active scope headers while scrolling.
    #[serde(default)]
    pub sticky_scroll: bool,

    /// Whether PSScriptAnalyzer squiggles are enabled.
    #[serde(default = "default_true")]
    pub enable_pssa: bool,

    /// Whether PowerShell IntelliSense (TabExpansion2) is enabled.
    #[serde(default = "default_true")]
    pub enable_intelli_sense: bool,

    /// Save the active file automatically before running (F5).
    #[serde(default)]
    pub auto_save_on_run: bool,

    /// Clear the output pane before each run.
    #[serde(default = "default_true")]
    pub clear_output_on_run: bool,

    /// PowerShell execution policy override ("Default" means no override).
    #[serde(default = "default_execution_policy")]
    pub execution_policy: String,

    /// Working directory mode: "file" = use file's folder, "custom" = use custom_working_dir.
    #[serde(default = "default_working_dir_mode")]
    pub working_dir_mode: String,

    /// Custom working directory path when working_dir_mode is "custom".
    #[serde(default)]
    pub custom_working_dir: String,

    /// Whether timestamps are shown in the output pane.
    #[serde(default)]
    pub show_timestamps: bool,

    /// Font size for the output/terminal pane.
    #[serde(default = "default_output_font_size")]
    pub output_font_size: u32,

    /// Font family for the output/terminal pane.
    #[serde(default = "default_output_font_family")]
    pub output_font_family: String,

    /// Font family for the UI chrome (buttons, labels, status bar, etc.).
    #[serde(default = "default_ui_font_family")]
    pub ui_font_family: String,

    /// Font size for the UI chrome in pixels.
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: u32,

    /// Font family for the sidebar modules list.
    #[serde(default = "default_sidebar_font_family")]
    pub sidebar_font_family: String,

    /// Font size for the sidebar modules list in pixels.
    #[serde(default = "default_sidebar_font_size")]
    pub sidebar_font_size: u32,

    /// Wrap long lines in the output pane.
    #[serde(default)]
    pub output_word_wrap: bool,

    /// Maximum number of files in the recent files dropdown.
    #[serde(default = "default_max_recent_files")]
    pub max_recent_files: usize,

    /// Editor/output split position as a percentage (0-100).
    #[serde(default = "default_split_position")]
    pub split_position: f64,

    /// List of recently opened file paths.
    #[serde(default)]
    pub recent_files: Vec<String>,

    /// File association registration state per extension.
    #[serde(default)]
    pub file_associations: HashMap<String, bool>,

    /// Whether the module browser sidebar is visible.
    #[serde(default = "default_true")]
    pub sidebar_visible: bool,

    /// Which side the module browser is docked to: "left" or "right".
    #[serde(default = "default_sidebar_position")]
    pub sidebar_position: String,
}

fn default_ps_version() -> String {
    "auto".to_string()
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_font_size() -> u32 {
    14
}

fn default_font_family() -> String {
    "Cascadia Code, Consolas, monospace".to_string()
}

fn default_tab_size() -> u32 {
    4
}

fn default_true() -> bool {
    true
}

fn default_line_numbers() -> String {
    "on".to_string()
}

fn default_render_whitespace() -> String {
    "selection".to_string()
}

fn default_execution_policy() -> String {
    "Default".to_string()
}

fn default_working_dir_mode() -> String {
    "file".to_string()
}

fn default_output_font_size() -> u32 {
    13
}

fn default_output_font_family() -> String {
    "Cascadia Code, Consolas, monospace".to_string()
}

fn default_ui_font_size() -> u32 {
    14
}

fn default_ui_font_family() -> String {
    "Segoe UI, sans-serif".to_string()
}

fn default_sidebar_position() -> String {
    "left".to_string()
}

fn default_sidebar_font_size() -> u32 {
    13
}

fn default_sidebar_font_family() -> String {
    "Segoe UI, sans-serif".to_string()
}

fn default_max_recent_files() -> usize {
    20
}

fn default_split_position() -> f64 {
    65.0
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_ps_version: default_ps_version(),
            theme: default_theme(),
            font_size: default_font_size(),
            font_family: default_font_family(),
            word_wrap: false,
            tab_size: default_tab_size(),
            insert_spaces: true,
            show_minimap: false,
            line_numbers: default_line_numbers(),
            render_whitespace: default_render_whitespace(),
            show_indent_guides: true,
            sticky_scroll: false,
            enable_pssa: true,
            enable_intelli_sense: true,
            auto_save_on_run: false,
            clear_output_on_run: true,
            execution_policy: default_execution_policy(),
            working_dir_mode: default_working_dir_mode(),
            custom_working_dir: String::new(),
            show_timestamps: false,
            output_font_size: default_output_font_size(),
            output_font_family: default_output_font_family(),
            ui_font_family: default_ui_font_family(),
            ui_font_size: default_ui_font_size(),
            sidebar_font_family: default_sidebar_font_family(),
            sidebar_font_size: default_sidebar_font_size(),
            output_word_wrap: false,
            max_recent_files: default_max_recent_files(),
            split_position: default_split_position(),
            recent_files: Vec::new(),
            file_associations: HashMap::new(),
            sidebar_visible: true,
            sidebar_position: default_sidebar_position(),
        }
    }
}

impl AppSettings {
    /// Adds a file path to the recent files list, deduplicating and enforcing the max size.
    #[allow(dead_code)]
    pub fn add_recent_file(&mut self, path: &str) {
        // Remove if already present
        self.recent_files.retain(|p| p != path);
        // Insert at front
        self.recent_files.insert(0, path.to_string());
        // Enforce max size
        self.recent_files.truncate(MAX_RECENT_FILES);
    }
}

/// Returns the path to the PSForge settings directory (%APPDATA%/PSForge/).
pub fn settings_dir() -> Result<PathBuf, AppError> {
    let app_data = dirs::config_dir().ok_or_else(|| AppError {
        code: "NO_APPDATA".to_string(),
        message: "Could not determine APPDATA directory".to_string(),
    })?;
    Ok(app_data.join("PSForge"))
}

/// Returns the full path to settings.json.
pub fn settings_path() -> Result<PathBuf, AppError> {
    Ok(settings_dir()?.join("settings.json"))
}

/// Returns the full path to the user snippets file.
pub fn snippets_path() -> Result<PathBuf, AppError> {
    Ok(settings_dir()?.join("snippets.json"))
}

/// Loads settings from disk, returning defaults if the file does not exist.
pub fn load() -> Result<AppSettings, AppError> {
    let path = settings_path()?;
    load_from(&path)
}

/// Loads settings from an explicit path.
/// Useful for tests that inject a temp directory instead of the real AppData path.
/// Returns defaults if the file does not exist; falls back to defaults on corrupt JSON.
pub fn load_from(path: &std::path::PathBuf) -> Result<AppSettings, AppError> {
    if !path.exists() {
        info!("No settings file found at {:?}, using defaults", path);
        return Ok(AppSettings::default());
    }

    debug!("Loading settings from {:?}", path);
    // Use retry for transient I/O failures (e.g. file lock during concurrent write) (Rule 11).
    let content = with_retry("settings::load_from", || std::fs::read_to_string(path))?;
    // Corrupted JSON is a permanent error; fall back to defaults and log (Rule 11).
    let settings = match serde_json::from_str::<AppSettings>(&content) {
        Ok(s) => s,
        Err(e) => {
            warn!(
                "settings file is corrupted ({}); resetting to defaults. Backup path: {:?}",
                e, path
            );
            AppSettings::default()
        }
    };
    Ok(settings)
}

/// Saves settings to disk, creating the directory if needed.
pub fn save(settings: &AppSettings) -> Result<(), AppError> {
    let path = settings_path()?;
    let dir = path.parent().ok_or_else(|| AppError {
        code: "INVALID_PATH".to_string(),
        message: "Settings path has no parent directory".to_string(),
    })?;
    if !dir.exists() {
        std::fs::create_dir_all(dir)?;
        info!("Created settings directory: {:?}", dir);
    }
    save_to(&path, settings)
}

/// Saves settings to an explicit path.
/// Useful for tests that inject a temp directory instead of the real AppData path.
/// The parent directory must already exist; `save()` creates it automatically.
pub fn save_to(path: &std::path::PathBuf, settings: &AppSettings) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(settings)?;
    // Write UTF-8 without BOM, retrying on transient I/O failures (Rule 11).
    with_retry("settings::save_to", || {
        std::fs::write(path, json.as_bytes())
    })?;
    debug!("Settings saved to {:?}", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_recent_file_prepends_and_deduplicates() {
        let mut settings = AppSettings::default();
        settings.add_recent_file("a.ps1");
        settings.add_recent_file("b.ps1");
        // Re-adding "a.ps1" should move it to the front, not duplicate it.
        settings.add_recent_file("a.ps1");
        assert_eq!(settings.recent_files.len(), 2, "Expected 2 unique entries");
        assert_eq!(settings.recent_files[0], "a.ps1");
        assert_eq!(settings.recent_files[1], "b.ps1");
    }

    #[test]
    fn add_recent_file_enforces_max_size() {
        let mut settings = AppSettings::default();
        for i in 0..25 {
            settings.add_recent_file(&format!("file{}.ps1", i));
        }
        assert_eq!(
            settings.recent_files.len(),
            MAX_RECENT_FILES,
            "list must be capped at MAX_RECENT_FILES"
        );
        // Most recently added file must be at front.
        assert_eq!(settings.recent_files[0], "file24.ps1");
    }

    #[test]
    fn default_settings_are_sane() {
        let s = AppSettings::default();
        assert!(!s.default_ps_version.is_empty());
        assert!(!s.theme.is_empty());
        assert!(s.font_size >= 8);
        assert!(!s.font_family.is_empty());
        assert!(s.split_position > 0.0 && s.split_position < 100.0);
    }
}
