/// Shared I/O utility functions for PSForge.
/// Provides retry logic for transient I/O failures (Rule 11 - Resilience).
use crate::errors::AppError;
use log::warn;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

/// Maximum number of I/O retry attempts for transient failures.
/// Backoff sequence: 50 ms -> 100 ms -> 200 ms, then propagate the error.
pub(crate) const MAX_IO_RETRIES: u32 = 3;

const PSFORGE_TEMP_DIR_NAME: &str = "psforge";
const STALE_TEMP_FILE_MAX_AGE_SECS: u64 = 10 * 60;

/// Base delay in milliseconds for the first retry backoff interval.
const RETRY_BASE_DELAY_MS: u64 = 50;

/// Executes a fallible I/O closure with capped exponential backoff retry (Rule 11).
///
/// Only retries on genuinely transient error kinds (`WouldBlock`, `TimedOut`, `Interrupted`).
/// Permanent errors (`NotFound`, `PermissionDenied`, etc.) are returned immediately
/// without retrying, since retrying would be pointless and could mask bugs.
///
/// # Arguments
/// * `label` - Diagnostic label emitted in log messages on retry.
/// * `op`    - Closure performing the I/O operation. Called up to `MAX_IO_RETRIES` times.
pub(crate) fn with_retry<T, F>(label: &str, op: F) -> std::io::Result<T>
where
    F: Fn() -> std::io::Result<T>,
{
    let mut delay = RETRY_BASE_DELAY_MS;
    for attempt in 0..MAX_IO_RETRIES {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if is_transient(&e) && attempt + 1 < MAX_IO_RETRIES => {
                warn!(
                    "{}: transient I/O error (attempt {}/{}): {}. Retrying in {}ms...",
                    label,
                    attempt + 1,
                    MAX_IO_RETRIES,
                    e,
                    delay
                );
                std::thread::sleep(std::time::Duration::from_millis(delay));
                delay = delay.saturating_mul(2);
            }
            Err(e) => return Err(e),
        }
    }
    // Safety: the loop body always returns on the last iteration because
    // (attempt + 1 < MAX_IO_RETRIES) is false when attempt == MAX_IO_RETRIES - 1,
    // so the Err arm returns unconditionally.
    unreachable!("retry loop exited unexpectedly")
}

/// Runs blocking filesystem work on the blocking thread pool so an async
/// command never parks a runtime worker: disk calls can stall on antivirus
/// scans or network shares, and `with_retry` sleeps between attempts.
pub(crate) async fn run_blocking<T, F>(label: &'static str, op: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(op)
        .await
        .map_err(|e| AppError {
            code: "TASK_FAILED".to_string(),
            message: format!("{} did not complete: {}", label, e),
        })?
}

/// First `max_chars` characters of `value` — safe to call on any UTF-8 string,
/// unlike byte slicing which panics when the cut lands inside a multi-byte char.
pub(crate) fn char_preview(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

/// Returns `true` for error kinds that indicate a transient condition:
/// file lock contention, resource temporarily busy, or interrupted syscall.
/// Permanent errors (file not found, permission denied, invalid path, etc.) return `false`.
fn is_transient(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

fn psforge_temp_dir() -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    let dir = {
        use std::os::unix::fs::MetadataExt;

        let home = dirs::home_dir().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Cannot determine the current user's home directory",
            )
        })?;
        let user_id = std::fs::metadata(home)?.uid();
        std::env::temp_dir().join(format!("{PSFORGE_TEMP_DIR_NAME}-{user_id}"))
    };
    #[cfg(not(unix))]
    let dir = std::env::temp_dir().join(PSFORGE_TEMP_DIR_NAME);

    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        // Also restrict a directory left behind with more permissive modes.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(&dir)?;

    Ok(dir)
}

/// Unique path for one staged terminal run. The prepared command selects this
/// path in the terminal before calling `psrun`, so overlapping runs cannot
/// overwrite or delete each other's wrappers. The `psforge_terminal_run_`
/// prefix keeps it covered by stale-file cleanup.
pub(crate) fn pending_terminal_run_path() -> std::io::Result<PathBuf> {
    Ok(psforge_temp_dir()?.join(format!(
        "psforge_terminal_run_pending_{}_{}.ps1",
        std::process::id(),
        Uuid::new_v4()
    )))
}

/// Writes `content` to a unique file in the system temp directory using
/// create_new(true), preventing accidental overwrite of pre-existing files.
pub(crate) fn write_secure_temp_file(
    prefix: &str,
    suffix: &str,
    content: &[u8],
) -> std::io::Result<PathBuf> {
    let temp_dir = psforge_temp_dir()?;
    for _ in 0..16 {
        let path = temp_dir.join(format!("{prefix}_{}{}", Uuid::new_v4(), suffix));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut f) => {
                // Windows PowerShell 5.1 (powershell.exe) parses a BOM-less file
                // using the system ANSI code page, silently corrupting any
                // non-ASCII source before the script runs. Prepend a UTF-8 BOM
                // for .ps1 temp files so both powershell.exe and pwsh.exe decode
                // them as UTF-8 (S3-6). The BOM is harmless for pure-ASCII
                // bootstrap/wrapper scripts and is stripped by PowerShell's parser.
                // Guard against a double BOM if the content already begins with
                // one (e.g. a Monaco buffer that retained a leading U+FEFF).
                if suffix.eq_ignore_ascii_case(".ps1") && !content.starts_with(&[0xEF, 0xBB, 0xBF])
                {
                    f.write_all(&[0xEF, 0xBB, 0xBF])?;
                }
                f.write_all(content)?;
                f.flush()?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "Failed to allocate unique temp file after 16 attempts",
    ))
}

/// Writes `bytes` to `path` with a UTF-8 BOM when missing. Windows PowerShell
/// 5.1 decodes BOM-less `.ps1` files as the system ANSI code page, so staged
/// run wrappers with non-ASCII paths/args must carry a BOM (same as
/// `write_secure_temp_file` for `.ps1`).
pub(crate) fn write_utf8_bom_file(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(content.len().saturating_add(3));
    if !content.starts_with(&[0xEF, 0xBB, 0xBF]) {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(content);
    atomic_write(path, &out)
}
/// fsyncs, then renames over the destination. Prevents the user-visible
/// "file is empty after a power loss / crash mid-write" failure mode that
/// `std::fs::write` can produce because it truncates first.
///
/// Behaviour:
/// - Creates the parent directory if missing (best-effort).
/// - Uses `create_new(true)` for the temp file so we never clobber an
///   unrelated sibling.
/// - Calls `sync_all` on the temp file before rename (ensures bytes hit disk).
/// - Tries to fsync the parent directory after rename on Unix; ignored on
///   Windows where directory fsync is not exposed and `ReplaceFileW`-style
///   semantics for `rename` are durable enough for our editor-save workload.
/// - On rename failure, removes the temp file so we never leave litter.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("psforge_atomic");

    // Preserve an existing destination's permissions across the rename; new
    // files default to owner-only access on Unix.
    #[cfg(unix)]
    let destination_mode = match std::fs::metadata(path) {
        Ok(metadata) => {
            use std::os::unix::fs::PermissionsExt;
            Some(metadata.permissions().mode() & 0o777)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };

    // Pick a unique sibling temp file. Sibling (not /tmp) so the rename is
    // guaranteed to be on the same filesystem and therefore atomic.
    let mut last_err: Option<std::io::Error> = None;
    for _ in 0..16 {
        let tmp_path = parent.join(format!(".{}.psforge_tmp_{}", file_name, Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(destination_mode.unwrap_or(0o600));
        }
        match options.open(&tmp_path) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(bytes) {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(e);
                }
                if let Err(e) = f.sync_all() {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(e);
                }
                drop(f);

                if let Err(e) = std::fs::rename(&tmp_path, path) {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(e);
                }

                #[cfg(unix)]
                {
                    if let Ok(dir) = std::fs::File::open(parent) {
                        let _ = dir.sync_all();
                    }
                }
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(e);
                continue;
            }
            Err(e) => return Err(e),
        }
    }

    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "Failed to allocate unique atomic-write temp file",
        )
    }))
}

/// Removes stale PSForge-owned temp files left behind by interrupted runs.
///
/// Files newer than STALE_TEMP_FILE_MAX_AGE_SECS are preserved so a second app
/// instance does not interfere with a currently-running execution session.
pub(crate) fn cleanup_psforge_temp_files() -> std::io::Result<usize> {
    const PREFIXES: &[&str] = &[
        "psforge_tmp_",
        "psforge_script_",
        "psforge_wrapper_",
        "psforge_invoke_",
        "psforge_host_bootstrap_",
        "psforge_terminal_bootstrap_",
        "psforge_terminal_run_",
        "psforge_terminal_invoke_",
    ];

    let dir = psforge_temp_dir()?;
    let now = SystemTime::now();
    let max_age = Duration::from_secs(STALE_TEMP_FILE_MAX_AGE_SECS);
    let mut removed = 0usize;

    for entry in std::fs::read_dir(dir)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
            continue;
        }

        let modified = match entry.metadata().and_then(|m| m.modified()) {
            Ok(modified) => modified,
            Err(_) => continue,
        };

        let age = match now.duration_since(modified) {
            Ok(age) => age,
            Err(_) => continue,
        };

        if age < max_age {
            continue;
        }

        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    Ok(removed)
}

#[cfg(test)]
mod tests;
