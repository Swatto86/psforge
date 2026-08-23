/// Shared I/O utility functions for PSForge.
/// Provides retry logic for transient I/O failures (Rule 11 - Resilience).
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
    let dir = std::env::temp_dir().join(PSFORGE_TEMP_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Fixed per-app-process path where the next terminal run's wrapper script is
/// staged. PTY sessions receive it via the PSFORGE_RUN_FILE env var so the
/// bootstrap's `psrun` function can execute it, keeping the echoed command
/// line down to `psrun 'ScriptName.ps1'` instead of the full wrapper text.
/// The `psforge_terminal_run_` prefix keeps it covered by stale-file cleanup.
// ponytail: one staged run per app process; per-terminal-session files if
// concurrent runs across terminal tabs ever become a thing (runs are
// currently serialized by SET_RUNNING).
pub(crate) fn pending_terminal_run_path() -> std::io::Result<PathBuf> {
    Ok(psforge_temp_dir()?.join(format!(
        "psforge_terminal_run_pending_{}.ps1",
        std::process::id()
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
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
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

    // Pick a unique sibling temp file. Sibling (not /tmp) so the rename is
    // guaranteed to be on the same filesystem and therefore atomic.
    let mut last_err: Option<std::io::Error> = None;
    for _ in 0..16 {
        let tmp_path = parent.join(format!(".{}.psforge_tmp_{}", file_name, Uuid::new_v4()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
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
    fn write_secure_temp_file_prepends_bom_only_for_ps1() {
        let ps1 = write_secure_temp_file("psforge_test_bom", ".ps1", b"$x = 1")
            .expect("temp file must be created");
        let ps1_bytes = std::fs::read(&ps1).expect("temp file must be readable");
        assert_eq!(
            &ps1_bytes[..3],
            &[0xEF, 0xBB, 0xBF],
            ".ps1 temp file must start with a UTF-8 BOM"
        );
        assert_eq!(&ps1_bytes[3..], b"$x = 1");
        let _ = std::fs::remove_file(ps1);

        let txt = write_secure_temp_file("psforge_test_bom", ".txt", b"$x = 1")
            .expect("temp file must be created");
        let txt_bytes = std::fs::read(&txt).expect("temp file must be readable");
        assert_eq!(
            txt_bytes, b"$x = 1",
            "non-.ps1 temp file must not gain a BOM"
        );
        let _ = std::fs::remove_file(txt);

        // Content that already begins with a BOM must not be double-BOM'd (R-2).
        let with_bom = write_secure_temp_file("psforge_test_bom", ".ps1", b"\xEF\xBB\xBF$x = 1")
            .expect("temp file must be created");
        let with_bom_bytes = std::fs::read(&with_bom).expect("temp file must be readable");
        assert_eq!(
            with_bom_bytes, b"\xEF\xBB\xBF$x = 1",
            ".ps1 content that already has a BOM must not gain a second one"
        );
        let _ = std::fs::remove_file(with_bom);
    }

    #[test]
    fn char_preview_never_splits_multibyte_chars() {
        // A byte-index slice would panic here: byte 200 lands mid-codepoint.
        let s = "é".repeat(150); // 300 bytes, 150 chars
        assert_eq!(char_preview(&s, 200).chars().count(), 150);
        assert_eq!(char_preview(&s, 100).chars().count(), 100);
        assert_eq!(char_preview("abc", 200), "abc");
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
