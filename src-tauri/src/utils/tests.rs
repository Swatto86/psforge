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

#[cfg(unix)]
fn assert_unix_mode(path: &Path, expected: u32) {
    use std::os::unix::fs::MetadataExt;

    let mode = std::fs::metadata(path)
        .expect("path must have metadata")
        .mode()
        & 0o777;
    assert_eq!(mode, expected, "unexpected mode for {}", path.display());
}

#[test]
fn write_secure_temp_file_uses_psforge_temp_dir() {
    let path = write_secure_temp_file("psforge_test_dir", ".txt", b"ok")
        .expect("temp file must be created");
    let parent = path.parent().expect("temp file must have parent");
    let dir_name = parent
        .file_name()
        .and_then(|name| name.to_str())
        .expect("temp directory name must be valid UTF-8");
    #[cfg(unix)]
    assert!(
        dir_name.starts_with(&format!("{PSFORGE_TEMP_DIR_NAME}-")),
        "Unix temp directory must be user-specific"
    );
    #[cfg(not(unix))]
    assert_eq!(dir_name, PSFORGE_TEMP_DIR_NAME);
    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
#[test]
fn write_secure_temp_file_enforces_private_unix_modes() {
    let path = write_secure_temp_file("psforge_test_modes", ".txt", b"secret")
        .expect("temp file must be created");
    let parent = path.parent().expect("temp file must have parent");

    assert_unix_mode(parent, 0o700);
    assert_unix_mode(&path, 0o600);

    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
#[test]
fn atomic_write_preserves_existing_unix_modes() {
    use std::os::unix::fs::PermissionsExt;

    for mode in [0o600, 0o755] {
        let path = write_secure_temp_file("psforge_test_atomic_modes", ".txt", b"old")
            .expect("temp file must be created");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
            .expect("test must set destination mode");

        atomic_write(&path, b"new").expect("atomic write must succeed");

        assert_eq!(std::fs::read(&path).expect("file must be readable"), b"new");
        assert_unix_mode(&path, mode);
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(unix)]
#[test]
fn atomic_write_uses_private_mode_for_new_unix_files() {
    let path = write_secure_temp_file("psforge_test_atomic_new", ".txt", b"old")
        .expect("temp file must be created");
    std::fs::remove_file(&path).expect("test must remove destination");

    atomic_write(&path, b"new").expect("atomic write must succeed");

    assert_unix_mode(&path, 0o600);
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
    let path =
        write_secure_temp_file("psforge_tmp", ".txt", b"stale").expect("temp file must be created");
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
