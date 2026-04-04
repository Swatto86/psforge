// E2E tests for encoding edge cases and file content handling (Rule 3).
//
// Supplements file_ops_e2e.rs with additional boundary and regression scenarios:
// - Encoding detection for ambiguous BOM-less files.
// - Round-trip preservation of CR/LF/CRLF line endings.
// - UTF-16 LE encoding with multi-byte characters.
// - Zero-byte file handling.
// - Save with unknown encoding defaults to UTF-8.

// Conservative async timeout for CI runners (Rule 3).
const TEST_TIMEOUT_SECS: u64 = 30;

use psforge_lib::commands;
use tokio::time::{timeout, Duration};

macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_TIMEOUT_SECS), $e)
            .await
            .expect("encoding test timed out")
    };
}

// ---------------------------------------------------------------------------
// Zero-byte file
// ---------------------------------------------------------------------------

#[tokio::test]
async fn read_zero_byte_file_returns_empty_utf8() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("empty.ps1");
        std::fs::write(&path, b"").expect("write empty file");

        let result = commands::read_file_content(path.to_string_lossy().to_string())
            .await
            .expect("zero-byte file must be readable");

        assert_eq!(
            result.encoding, "utf8",
            "zero-byte file must detect as utf8"
        );
        assert!(result.content.is_empty(), "content must be empty");
    });
}

// ---------------------------------------------------------------------------
// BOM-only file (BOM bytes but no content)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn read_bom_only_utf8_file_returns_empty_content() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bom_only.ps1");
        std::fs::write(&path, [0xEF, 0xBB, 0xBF]).expect("write BOM-only file");

        let result = commands::read_file_content(path.to_string_lossy().to_string())
            .await
            .expect("BOM-only file must be readable");

        assert_eq!(result.encoding, "utf8bom");
        assert!(result.content.is_empty(), "content after BOM must be empty");
    });
}

#[tokio::test]
async fn read_bom_only_utf16le_file_returns_empty_content() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bom_only_utf16.ps1");
        std::fs::write(&path, [0xFF, 0xFE]).expect("write UTF-16 LE BOM-only file");

        let result = commands::read_file_content(path.to_string_lossy().to_string())
            .await
            .expect("UTF-16 LE BOM-only file must be readable");

        assert_eq!(result.encoding, "utf16le");
        assert!(result.content.is_empty());
    });
}

// ---------------------------------------------------------------------------
// Save with explicit encoding round-trips correctly
// ---------------------------------------------------------------------------

#[tokio::test]
async fn save_and_read_utf8bom_preserves_content() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bom_test.ps1");
        let path_str = path.to_string_lossy().to_string();

        let content = "Write-Host 'Hello BOM'\r\n$x = 42\r\n";

        commands::save_file_content(path_str.clone(), content.to_string(), "utf8bom".to_string())
            .await
            .expect("save with utf8bom must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read back must succeed");

        assert_eq!(result.encoding, "utf8bom", "encoding must round-trip");
        assert_eq!(result.content, content, "content must round-trip exactly");
    });
}

#[tokio::test]
async fn save_and_read_utf16le_preserves_unicode() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("utf16_unicode.ps1");
        let path_str = path.to_string_lossy().to_string();

        // Content with CJK and emoji characters.
        let content = "# Unicode test\r\n$msg = '\u{4F60}\u{597D}'  # nihao\r\n";

        commands::save_file_content(path_str.clone(), content.to_string(), "utf16le".to_string())
            .await
            .expect("save with utf16le must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read back must succeed");

        assert_eq!(result.encoding, "utf16le");
        assert_eq!(result.content, content, "UTF-16 LE must preserve CJK chars");
    });
}

// ---------------------------------------------------------------------------
// File content validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn save_then_read_preserves_trailing_newline() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("trailing.ps1");
        let path_str = path.to_string_lossy().to_string();

        // Important: PowerShell scripts often end with a trailing newline.
        let content = "Get-Process\n";
        commands::save_file_content(path_str.clone(), content.to_string(), "utf8".to_string())
            .await
            .expect("save must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read must succeed");

        assert_eq!(
            result.content, content,
            "trailing newline must be preserved"
        );
    });
}

#[tokio::test]
async fn save_unknown_encoding_falls_back_to_utf8() {
    // Passing an unrecognised encoding string must not panic; it should
    // default to UTF-8 no BOM (the _ arm in the match).
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("unknown_enc.ps1");
        let path_str = path.to_string_lossy().to_string();

        let content = "Get-ChildItem\n";
        commands::save_file_content(
            path_str.clone(),
            content.to_string(),
            "cp1252".to_string(), // not a recognized encoding
        )
        .await
        .expect("save with unknown encoding must not panic");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read back must succeed");

        // Should have been written as raw UTF-8 bytes (the fallback).
        assert_eq!(result.encoding, "utf8");
        assert_eq!(result.content, content);
    });
}

// ---------------------------------------------------------------------------
// Large content (below limit) round-trips
// ---------------------------------------------------------------------------

#[tokio::test]
async fn save_and_read_utf16be_preserves_content() {
    // Regression test for UTF-16 BE files being silently saved as UTF-8.
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("utf16be_test.ps1");
        let path_str = path.to_string_lossy().to_string();

        // Write a UTF-16 BE file manually (BOM + content).
        let content = "Write-Host 'UTF-16 BE'\r\n$x = 42\r\n";
        let mut bytes = vec![0xFE, 0xFF]; // UTF-16 BE BOM
        for c in content.encode_utf16() {
            bytes.extend_from_slice(&c.to_be_bytes());
        }
        std::fs::write(&path, &bytes).expect("write UTF-16 BE file");

        // Read it back to get the detected encoding.
        let result = commands::read_file_content(path_str.clone())
            .await
            .expect("read UTF-16 BE file must succeed");

        assert_eq!(result.encoding, "utf16be", "must detect UTF-16 BE encoding");
        assert_eq!(result.content, content, "content must be preserved");

        // Now save it back with the detected encoding and read again.
        commands::save_file_content(
            path_str.clone(),
            result.content.clone(),
            "utf16be".to_string(),
        )
        .await
        .expect("save UTF-16 BE must succeed");

        let result2 = commands::read_file_content(path_str)
            .await
            .expect("re-read must succeed");

        assert_eq!(
            result2.encoding, "utf16be",
            "encoding must survive save round-trip"
        );
        assert_eq!(
            result2.content, content,
            "content must survive save round-trip"
        );
    });
}

#[tokio::test]
async fn save_and_read_large_script_below_limit() {
    bounded!(async {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("large.ps1");
        let path_str = path.to_string_lossy().to_string();

        // ~1 MB of repeated script lines -- well below the 10 MiB limit.
        let line = "Write-Host 'Line of output for testing purposes'\r\n";
        let content = line.repeat(20_000); // ~1 MB

        commands::save_file_content(path_str.clone(), content.clone(), "utf8".to_string())
            .await
            .expect("save 1 MB file must succeed");

        let result = commands::read_file_content(path_str)
            .await
            .expect("read 1 MB file must succeed");

        assert_eq!(
            result.content.len(),
            content.len(),
            "content size must match"
        );
    });
}
