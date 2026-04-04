// E2E integration tests for snippet management (Rule 3).
//
// Tests exercise `get_snippets_from`, `save_user_snippets_to`, and the
// builtin-snippet catalogue. No changes are made to real AppData directories.

// Conservative blocking-operation deadline (Rule 3).
const TEST_TIMEOUT_SECS: u64 = 30;

use psforge_lib::commands::{self, Snippet};
use std::path::PathBuf;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_snippets_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("Failed to create temp dir for snippets test");
    let path = dir.path().join("snippets.json");
    (dir, path)
}

fn with_timeout<F, T>(op: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<T>();
    std::thread::spawn(move || {
        let _ = tx.send(op());
    });
    rx.recv_timeout(Duration::from_secs(TEST_TIMEOUT_SECS))
        .expect("snippet operation timed out -- possible I/O hang")
}

/// Helper: creates a minimal user snippet for testing.
fn make_snippet(name: &str, category: &str, code: &str) -> Snippet {
    Snippet {
        name: name.to_string(),
        category: category.to_string(),
        description: format!("{} description", name),
        code: code.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Builtin snippet catalogue
// ---------------------------------------------------------------------------

#[test]
fn builtin_snippets_are_loaded_when_no_user_file_exists() {
    with_timeout(|| {
        let dir = tempfile::tempdir().expect("temp dir");
        let nonexistent = dir.path().join("no_snippets.json");

        let snippets = commands::get_snippets_from(nonexistent)
            .expect("get_snippets_from must succeed even with no user file");

        assert!(
            !snippets.is_empty(),
            "builtin snippets must be returned when no user file is present"
        );

        // Verify a known builtin snippet exists (the Function snippet is always present).
        let has_function = snippets.iter().any(|s| s.name == "Function");
        assert!(
            has_function,
            "built-in 'Function' snippet must always be present"
        );
    });
}

#[test]
fn builtin_snippets_have_required_fields() {
    with_timeout(|| {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("no_snippets.json");

        let snippets = commands::get_snippets_from(path).expect("get_snippets_from must succeed");

        for snippet in &snippets {
            assert!(!snippet.name.is_empty(), "snippet.name must not be empty");
            assert!(
                !snippet.category.is_empty(),
                "snippet.category must not be empty"
            );
            assert!(!snippet.code.is_empty(), "snippet.code must not be empty");
        }
    });
}

#[test]
fn builtin_snippets_covers_at_least_twenty_templates() {
    // PROGRESS.md documents 20 built-in snippets; this guards against accidental removal.
    with_timeout(|| {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("no_snippets.json");

        let snippets = commands::get_snippets_from(path).expect("get_snippets_from must succeed");
        assert!(
            snippets.len() >= 20,
            "at least 20 built-in snippets must be present, found {}",
            snippets.len()
        );
    });
}

// ---------------------------------------------------------------------------
// User snippets round-trip
// ---------------------------------------------------------------------------

#[test]
fn user_snippets_roundtrip_single_snippet() {
    with_timeout(|| {
        let (_dir, path) = temp_snippets_path();

        let user_snippets = vec![make_snippet("MyHelper", "Custom", "Write-Host 'hi'")];
        commands::save_user_snippets_to(&path, &user_snippets)
            .expect("save_user_snippets_to must succeed");

        assert!(path.exists(), "snippets file must exist after save");

        let all =
            commands::get_snippets_from(path).expect("get_snippets_from must succeed after save");

        let custom = all.iter().find(|s| s.name == "MyHelper");
        assert!(
            custom.is_some(),
            "saved user snippet must appear in loaded list"
        );
        assert_eq!(custom.unwrap().code, "Write-Host 'hi'");
    });
}

#[test]
fn user_snippets_merged_with_builtins() {
    with_timeout(|| {
        let (_dir, path) = temp_snippets_path();

        let user_snippets = vec![
            make_snippet("UserSnippet1", "Custom", "# user1"),
            make_snippet("UserSnippet2", "Custom", "# user2"),
        ];
        commands::save_user_snippets_to(&path, &user_snippets)
            .expect("save_user_snippets_to must succeed");

        let all = commands::get_snippets_from(path).expect("get_snippets_from must succeed");

        // Both user and builtin snippets must be present.
        let has_user1 = all.iter().any(|s| s.name == "UserSnippet1");
        let has_user2 = all.iter().any(|s| s.name == "UserSnippet2");
        let has_function = all.iter().any(|s| s.name == "Function");

        assert!(has_user1, "UserSnippet1 must appear in merged list");
        assert!(has_user2, "UserSnippet2 must appear in merged list");
        assert!(
            has_function,
            "built-in 'Function' snippet must still appear after user snippets merge"
        );
    });
}

#[test]
fn user_snippets_overwrite_on_second_save() {
    with_timeout(|| {
        let (_dir, path) = temp_snippets_path();

        let first = vec![make_snippet("Old", "Tests", "# old")];
        commands::save_user_snippets_to(&path, &first).expect("first save must succeed");

        let second = vec![make_snippet("New", "Tests", "# new")];
        commands::save_user_snippets_to(&path, &second)
            .expect("second save (overwrite) must succeed");

        let all = commands::get_snippets_from(path).expect("get_snippets_from must succeed");

        let has_new = all.iter().any(|s| s.name == "New");
        let has_old = all.iter().any(|s| s.name == "Old");

        assert!(has_new, "'New' snippet must be present after overwrite");
        assert!(!has_old, "'Old' snippet must NOT appear after overwrite");
    });
}

#[test]
fn user_snippets_preserve_special_characters_in_code() {
    with_timeout(|| {
        let (_dir, path) = temp_snippets_path();
        // PowerShell often contains quotes, backticks, dollar signs, and braces.
        let code = r#"$obj = [PSCustomObject]@{ Name = "test"; Value = $null }"#;
        let user_snippets = vec![make_snippet("SpecialChars", "Custom", code)];

        commands::save_user_snippets_to(&path, &user_snippets)
            .expect("save with special chars must succeed");

        let all = commands::get_snippets_from(path).expect("load must succeed");
        let found = all.iter().find(|s| s.name == "SpecialChars");

        assert!(found.is_some(), "SpecialChars snippet must round-trip");
        assert_eq!(
            found.unwrap().code,
            code,
            "code with special chars must survive round trip"
        );
    });
}

// ---------------------------------------------------------------------------
// Failure / edge cases
// ---------------------------------------------------------------------------

#[test]
fn corrupt_user_snippets_file_returns_only_builtins() {
    // Rule 11: corrupt user snippets must not crash or suppress builtins.
    // The silent-skip behaviour in get_snippets_from is intentional: user data
    // corruption is recoverable by simply overwriting the snippets file.
    with_timeout(|| {
        let (_dir, path) = temp_snippets_path();
        std::fs::write(&path, b"[{NOT VALID JSON").expect("write must succeed");

        let all = commands::get_snippets_from(path)
            .expect("get_snippets_from must not error on corrupt user snippets");

        // Must still return at least the builtins.
        assert!(
            !all.is_empty(),
            "builtins must be returned even when user snippets file is corrupt"
        );
        // The corrupt entry must NOT appear.
        let has_corrupt = all.iter().any(|s| s.name.is_empty() || s.code.is_empty());
        assert!(
            !has_corrupt,
            "corrupt entries must not appear in the snippet list"
        );
    });
}

#[test]
fn empty_user_snippets_array_returns_only_builtins() {
    with_timeout(|| {
        let (_dir, path) = temp_snippets_path();
        std::fs::write(&path, b"[]").expect("write must succeed");

        let all = commands::get_snippets_from(path).expect("get_snippets_from must succeed");

        // [] is valid; no user snippets added, builtins still returned.
        let has_function = all.iter().any(|s| s.name == "Function");
        assert!(
            has_function,
            "builtins must still be returned when user array is empty"
        );
    });
}
