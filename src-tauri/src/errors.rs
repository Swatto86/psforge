/// PSForge error types.
/// Provides a unified error type that serializes cleanly for the Tauri IPC boundary.
/// Also provides `BatchResult` for operations that process multiple items and must
/// accumulate per-item errors rather than aborting on the first failure (Rule 11).
use serde::Serialize;
use std::fmt;

/// Application-wide error type returned from all Tauri commands.
#[derive(Debug, Serialize)]
pub struct AppError {
    /// Machine-readable error code for frontend matching.
    pub code: String,
    /// Human-readable error message.
    pub message: String,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError {
            code: "IO_ERROR".to_string(),
            message: e.to_string(),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError {
            code: "JSON_ERROR".to_string(),
            message: e.to_string(),
        }
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError {
            code: "GENERAL_ERROR".to_string(),
            message: s,
        }
    }
}

// ---------------------------------------------------------------------------
// Batch error accumulation (Rule 11)
// ---------------------------------------------------------------------------

/// Maximum number of per-item errors retained during a batch operation.
/// Prevents unbounded memory growth when many items fail.
pub const MAX_BATCH_ERRORS: usize = 100;

/// Records a single item-level error within a batch operation.
/// `item` identifies which input caused the failure (path, extension name, etc.).
#[derive(Debug, Clone, Serialize)]
pub struct BatchError {
    /// Identifies the input item that failed (e.g. the file extension ".ps1").
    pub item: String,
    /// Machine-readable error code matching the `AppError.code` convention.
    pub code: String,
    /// Human-readable explanation of why this item failed.
    pub message: String,
}

/// Result of a batch operation: a list of successfully processed items plus any
/// per-item errors that were accumulated rather than propagated.
///
/// The operation continues even when individual items fail, so callers always
/// receive the maximum useful output rather than an all-or-nothing response.
/// Errors are capped at `MAX_BATCH_ERRORS` to bound memory usage (Rule 11).
#[derive(Debug, Serialize)]
pub struct BatchResult<T: Serialize> {
    /// Items that were processed successfully.
    pub items: Vec<T>,
    /// Per-item errors, capped at `MAX_BATCH_ERRORS`.
    pub errors: Vec<BatchError>,
}

impl<T: Serialize> BatchResult<T> {
    /// Creates an empty result ready for accumulation.
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            errors: Vec::new(),
        }
    }

    /// Records a successful item.
    pub fn push_item(&mut self, item: T) {
        self.items.push(item);
    }

    /// Records a per-item error, ignoring it silently once `MAX_BATCH_ERRORS` is reached.
    /// This prevents unbounded growth while still surfacing the most important failures.
    pub fn push_error(
        &mut self,
        item: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) {
        if self.errors.len() < MAX_BATCH_ERRORS {
            self.errors.push(BatchError {
                item: item.into(),
                code: code.into(),
                message: message.into(),
            });
        }
    }

    /// Returns `true` if every item succeeded and no errors were accumulated.
    #[allow(dead_code)]
    pub fn is_clean(&self) -> bool {
        self.errors.is_empty()
    }
}

impl<T: Serialize> Default for BatchResult<T> {
    fn default() -> Self {
        Self::new()
    }
}
