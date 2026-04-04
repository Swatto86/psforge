// E2E integration tests for file read/save operations (Rule 3).
//
// All tests write to OS-managed temporary directories so real user files are
// never touched. Each test exercises the full code path from the Tauri command
// layer down to the OS filesystem, including encoding detection, size guards,
// and path length validation (Rule 11).
//
// Why `#[tokio::test]`: `read_file_content` and `save_file_content` are
// declared `pub async fn` in commands.rs; tokio is already in `[dependencies]`
// with `features = ["full"]` so no additional dev dependency is required.

// Conservative async-test deadline (Rule 3): at least 5x the worst-case local
// completion time. File I/O on a temp dir should take < 100 ms locally.
const TEST_IO_TIMEOUT_SECS: u64 = 30;

use psforge_lib::commands;
use std::path::PathBuf;
use tokio::time::{timeout, Duration};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_file_path(ext: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("Failed to create temp dir");
    let path = dir.path().join(format!("test{}", ext));
    (dir, path)
}

/// Wraps an async block in a hard-deadline timeout (Rule 3).
macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_IO_TIMEOUT_SECS), $e)
            .await
            .expect("test timed out -- possible I/O hang")
    };
}

// ---------------------------------------------------------------------------
// Success cases - round-trips
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_roundtrip_utf8_no_bom() {
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let content = "Write-Host 'Hello, PSForge!'\n# UTF-8 script";
        let path_str = path.to_string_lossy().to_string();

        commands::save_file_content(path_str.clone(), content.to_string(), "utf8".to_string())
            .await
            .expect("save_file_content must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read_file_content must succeed");

        assert_eq!(result.content, content, "content must survive round trip");
        assert_eq!(result.encoding, "utf8", "encoding must be detected as utf8");
    });
}

#[tokio::test]
async fn file_roundtrip_utf8_bom() {
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let content = "# UTF-8 BOM script\nParam([string]$Name)";
        let path_str = path.to_string_lossy().to_string();

        commands::save_file_content(path_str.clone(), content.to_string(), "utf8bom".to_string())
            .await
            .expect("save_file_content with utf8bom must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read_file_content must succeed");

        assert_eq!(
            result.content, content,
            "content must match after BOM strip"
        );
        assert_eq!(
            result.encoding, "utf8bom",
            "encoding must be detected as utf8bom"
        );
    });
}

#[tokio::test]
async fn file_roundtrip_utf16le() {
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let content = "# UTF-16 LE\nWrite-Host 'test'";
        let path_str = path.to_string_lossy().to_string();

        commands::save_file_content(path_str.clone(), content.to_string(), "utf16le".to_string())
            .await
            .expect("save_file_content with utf16le must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read_file_content must succeed");

        assert_eq!(
            result.content, content,
            "content must survive UTF-16 LE round trip"
        );
        assert_eq!(result.encoding, "utf16le");
    });
}

#[tokio::test]
async fn file_content_matches_path_field() {
    // The returned FileContent.path must equal the input path.
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let path_str = path.to_string_lossy().to_string();

        commands::save_file_content(path_str.clone(), "# test".to_string(), "utf8".to_string())
            .await
            .expect("save must succeed");

        let result = commands::read_file_content(path_str.clone())
            .await
            .expect("read must succeed");

        assert_eq!(result.path, path_str, "returned path must equal input path");
    });
}

#[tokio::test]
async fn file_save_empty_content_succeeds() {
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let path_str = path.to_string_lossy().to_string();

        commands::save_file_content(path_str.clone(), String::new(), "utf8".to_string())
            .await
            .expect("saving empty content must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("reading empty file must succeed");

        assert!(result.content.is_empty(), "content must be empty");
        assert_eq!(result.encoding, "utf8");
    });
}

#[tokio::test]
async fn file_save_overwrites_existing_file() {
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let path_str = path.to_string_lossy().to_string();

        commands::save_file_content(path_str.clone(), "# first".to_string(), "utf8".to_string())
            .await
            .expect("first save must succeed");

        commands::save_file_content(path_str.clone(), "# second".to_string(), "utf8".to_string())
            .await
            .expect("second save (overwrite) must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read must succeed");

        assert_eq!(result.content, "# second", "overwrite must take effect");
    });
}

// ---------------------------------------------------------------------------
// Failure / validation cases (Rule 11 - Input Validation Guards)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn read_file_content_missing_file_returns_error() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path_str = dir
            .path()
            .join("does_not_exist.ps1")
            .to_string_lossy()
            .to_string();

        let err = commands::read_file_content(path_str)
            .await
            .expect_err("reading missing file must return an error");

        assert_eq!(
            err.code, "FILE_STAT_FAILED",
            "missing file must produce FILE_STAT_FAILED error code, got: {}",
            err.code
        );
    });
}

#[tokio::test]
async fn read_file_content_oversized_file_returns_file_too_large() {
    // Rule 11: files exceeding MAX_FILE_SIZE (10 MiB) must be rejected before reading.
    // We create a real file that exceeds the limit to exercise the stat-check path.
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let path_str = path.to_string_lossy().to_string();

        // Write 11 MiB of data -- just over the 10 MiB limit.
        let big_data = vec![b'#'; 11 * 1024 * 1024];
        std::fs::write(&path, &big_data).expect("writing oversized file must succeed");

        let err = commands::read_file_content(path_str)
            .await
            .expect_err("oversized file must return an error");

        assert_eq!(
            err.code, "FILE_TOO_LARGE",
            "oversized file must produce FILE_TOO_LARGE error code, got: {}",
            err.code
        );
        assert!(
            err.message.contains("MiB") || err.message.contains("limit"),
            "error message must mention the size limit: {}",
            err.message
        );
    });
}

#[tokio::test]
async fn read_file_content_path_too_long_returns_error() {
    // Rule 11: paths exceeding MAX_PATH_LENGTH (1024) must be rejected before any I/O.
    bounded!(async {
        // Build a path string longer than 1024 characters -- deliberately invalid.
        let long_path = "C:\\".to_string() + &"a".repeat(1025) + ".ps1";

        let err = commands::read_file_content(long_path)
            .await
            .expect_err("path-too-long must return an error");

        assert_eq!(
            err.code, "PATH_TOO_LONG",
            "path-too-long must produce PATH_TOO_LONG, got: {}",
            err.code
        );
    });
}

#[tokio::test]
async fn save_file_content_path_too_long_returns_error() {
    bounded!(async {
        let long_path = "C:\\".to_string() + &"b".repeat(1025) + ".ps1";

        let err = commands::save_file_content(long_path, "content".to_string(), "utf8".to_string())
            .await
            .expect_err("path-too-long must return an error on save");

        assert_eq!(
            err.code, "PATH_TOO_LONG",
            "path-too-long on save must produce PATH_TOO_LONG, got: {}",
            err.code
        );
    });
}

// ---------------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_roundtrip_unicode_content() {
    // PowerShell scripts may contain non-ASCII identifiers or string literals.
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let path_str = path.to_string_lossy().to_string();
        let content = "# Unicode: \u{00e9}\u{03b1}\u{4e2d}\u{1f40d} test";

        commands::save_file_content(path_str.clone(), content.to_string(), "utf8".to_string())
            .await
            .expect("save unicode content must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read unicode content must succeed");

        assert_eq!(
            result.content, content,
            "unicode content must survive round trip"
        );
    });
}

#[tokio::test]
async fn file_roundtrip_windows_line_endings() {
    bounded!(async {
        let (_dir, path) = temp_file_path(".ps1");
        let path_str = path.to_string_lossy().to_string();
        let content = "line1\r\nline2\r\nline3";

        commands::save_file_content(path_str.clone(), content.to_string(), "utf8".to_string())
            .await
            .expect("save CRLF content must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read CRLF content must succeed");

        assert_eq!(
            result.content, content,
            "CRLF line endings must be preserved"
        );
    });
}
