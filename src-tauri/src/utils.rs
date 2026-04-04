/// Shared I/O utility functions for PSForge.
/// Provides retry logic for transient I/O failures (Rule 11 - Resilience).
use log::warn;
use std::io::Write;
use std::path::PathBuf;
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
    let dir = std::env::temp_dir().join(PSFORGE_TEMP_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
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
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
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
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[test]
    fn with_retry_succeeds_on_first_attempt() {
        let result: std::io::Result<i32> = with_retry("test", || Ok(42));
        assert_eq!(result.unwrap(), 42);
    }

    /// This test sleeps ~150 ms (50 ms + 100 ms backoff) intentionally.
    /// That is well within the 5x CI timeout margin required by Rule 3.
    #[test]
    fn with_retry_eventually_succeeds_after_transient_errors() {
        // First two calls fail with Interrupted (transient); third succeeds.
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let result: std::io::Result<i32> = with_retry("test", move || {
            let n = attempts_clone.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "interrupted",
                ))
            } else {
                Ok(99)
            }
        });
        assert_eq!(result.unwrap(), 99);
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn with_retry_does_not_retry_permanent_errors() {
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let result: std::io::Result<i32> = with_retry("test", move || {
            attempts_clone.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "not found",
            ))
        });
        assert!(result.is_err());
        // Must have given up immediately -- no retry on a permanent error.
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    /// This test sleeps ~150 ms (50 ms + 100 ms backoff) intentionally.
    /// That is well within the 5x CI timeout margin required by Rule 3.
    #[test]
    fn with_retry_exhausts_all_attempts_for_persistent_transient_error() {
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let result: std::io::Result<i32> = with_retry("test", move || {
            attempts_clone.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "busy"))
        });
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), MAX_IO_RETRIES);
    }

    #[test]
    fn is_transient_classifies_correctly() {
        assert!(is_transient(&std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            ""
        )));
        assert!(is_transient(&std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            ""
        )));
        assert!(is_transient(&std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            ""
        )));
        assert!(!is_transient(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            ""
        )));
        assert!(!is_transient(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            ""
        )));
        assert!(!is_transient(&std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            ""
        )));
    }

    #[test]
    fn write_secure_temp_file_uses_psforge_temp_dir() {
        let path = write_secure_temp_file("psforge_test_dir", ".txt", b"ok")
            .expect("temp file must be created");
        let parent = path.parent().expect("temp file must have parent");
        assert_eq!(
            parent.file_name().and_then(|name| name.to_str()),
            Some(PSFORGE_TEMP_DIR_NAME)
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cleanup_psforge_temp_files_removes_stale_matching_files() {
        let path = write_secure_temp_file("psforge_tmp", ".txt", b"stale")
            .expect("temp file must be created");
        let stale_time = SystemTime::now()
            .checked_sub(Duration::from_secs(STALE_TEMP_FILE_MAX_AGE_SECS + 60))
            .expect("stale timestamp must be representable");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("temp file must be reopenable");
        file.set_times(std::fs::FileTimes::new().set_modified(stale_time))
            .expect("test must be able to age temp file");

        let removed = cleanup_psforge_temp_files().expect("cleanup must succeed");
        assert!(removed >= 1, "cleanup must remove the stale test file");
        assert!(!path.exists(), "cleanup must delete the stale temp file");
    }
}
