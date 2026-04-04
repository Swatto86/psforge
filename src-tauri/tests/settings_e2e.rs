// E2E integration tests for settings load/save (Rule 3).
//
// Tests use OS-managed temporary directories so they never touch the real
// user AppData/PSForge directory. All assertions exercise the real
// `settings::load_from` / `settings::save_to` I/O paths.
//
// Why separate test file: keeps production I/O tests isolated from unit logic
// tested inline in settings.rs; allows running with `cargo test --test settings_e2e`.

// Guard timeout for any operation that could hang (e.g. retry loops hitting a locked
// temp dir). Conservatively sized at 30 s for a cold CI runner with shared CPU.
// Actual operations should complete in well under 1 s.
const TEST_TIMEOUT_SECS: u64 = 30;

use psforge_lib::settings;
use psforge_lib::settings::AppSettings;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Creates a unique temp directory for one test and returns its path.
fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("Failed to create temp directory for test")
}

/// Runs an operation with a hard timeout to satisfy Rule 3 threaded-test requirements.
/// The operation is expected to complete long before the deadline; the timeout catches
/// any accidental infinite-loop or deadlock introduced in the retry helpers.
fn with_timeout<F, T>(op: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<T>();
    std::thread::spawn(move || {
        let result = op();
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_secs(TEST_TIMEOUT_SECS))
        .expect("settings operation timed out -- possible I/O hang in retry loop")
}

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

#[test]
fn settings_roundtrip_preserves_all_fields() {
    with_timeout(|| {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");

        // Build a non-default settings value so we can verify each field survives
        // the serialize -> write -> read -> deserialize round trip.
        let original = AppSettings {
            font_size: 18,
            font_family: "Fira Code, monospace".to_string(),
            theme: "light".to_string(),
            word_wrap: true,
            show_timestamps: true,
            split_position: 40.0,
            recent_files: vec!["C:\\foo.ps1".to_string(), "C:\\bar.ps1".to_string()],
            ..AppSettings::default()
        };

        settings::save_to(&path, &original).expect("save_to must succeed");
        assert!(path.exists(), "settings file must exist after save");

        let loaded = settings::load_from(&path).expect("load_from must succeed");

        assert_eq!(loaded.font_size, 18);
        assert_eq!(loaded.font_family, "Fira Code, monospace");
        assert_eq!(loaded.theme, "light");
        assert!(loaded.word_wrap, "word_wrap must roundtrip as true");
        assert!(
            loaded.show_timestamps,
            "show_timestamps must roundtrip as true"
        );
        assert!((loaded.split_position - 40.0).abs() < f64::EPSILON);
        assert_eq!(loaded.recent_files.len(), 2);
        assert_eq!(loaded.recent_files[0], "C:\\foo.ps1");
    });
}

#[test]
fn settings_load_from_nonexistent_returns_defaults() {
    with_timeout(|| {
        let dir = temp_dir();
        let path = dir.path().join("does_not_exist.json");

        let loaded = settings::load_from(&path).expect("load_from must not error on missing file");
        let defaults = AppSettings::default();

        // Compare string fields; numeric equality suffices for floats in this range.
        assert_eq!(loaded.theme, defaults.theme);
        assert_eq!(loaded.font_size, defaults.font_size);
        assert_eq!(loaded.font_family, defaults.font_family);
        assert!(loaded.recent_files.is_empty());
    });
}

#[test]
fn settings_save_and_reload_empty_recent_files() {
    with_timeout(|| {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");

        let settings = AppSettings::default();
        settings::save_to(&path, &settings).expect("save_to must succeed");
        let loaded = settings::load_from(&path).expect("load_from must succeed");
        assert!(loaded.recent_files.is_empty(), "recent_files must be empty");
    });
}

#[test]
fn settings_save_overwrites_previous_file() {
    with_timeout(|| {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");

        let first = AppSettings {
            font_size: 12,
            ..AppSettings::default()
        };
        settings::save_to(&path, &first).expect("first save must succeed");

        let second = AppSettings {
            font_size: 24,
            ..first.clone()
        };
        // Second save overwrites the first; no error on existing file.
        settings::save_to(&path, &second).expect("second save must succeed");

        let loaded = settings::load_from(&path).expect("load_from must succeed");
        assert_eq!(loaded.font_size, 24, "second save must overwrite first");
    });
}

// ---------------------------------------------------------------------------
// Failure / edge cases
// ---------------------------------------------------------------------------

#[test]
fn settings_load_corrupt_json_returns_defaults() {
    // Rule 11: corrupted JSON is a permanent error; must fall back to defaults silently.
    with_timeout(|| {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{ this is not valid json !!!").expect("write must succeed");

        // load_from must NOT return an Err — it should silently fall back to defaults.
        let loaded = settings::load_from(&path)
            .expect("load_from must return defaults and not propagate JSON parse error");

        let defaults = AppSettings::default();
        assert_eq!(
            loaded.font_size, defaults.font_size,
            "corrupted settings must fall back to default font_size"
        );
    });
}

#[test]
fn settings_load_empty_file_returns_defaults() {
    with_timeout(|| {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"").expect("write must succeed");

        let loaded = settings::load_from(&path)
            .expect("empty file must fall back to defaults without propagating error");
        let defaults = AppSettings::default();
        assert_eq!(loaded.theme, defaults.theme);
    });
}

#[test]
fn settings_load_partially_valid_json_returns_defaults() {
    // Partial JSON (truncated mid-write) is a common corruption pattern.
    with_timeout(|| {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");
        // Truncated after opening brace -- not a complete JSON object.
        std::fs::write(&path, b"{\"fontSize\":").expect("write must succeed");

        let loaded = settings::load_from(&path).expect("truncated JSON must fall back to defaults");
        let defaults = AppSettings::default();
        assert_eq!(loaded.font_size, defaults.font_size);
    });
}

#[test]
fn add_recent_file_deduplicates_and_caps() {
    // This test exercises AppSettings helpers directly without filesystem I/O.
    // Included here as it covers user-visible behaviour (recent-files list management).
    let mut s = AppSettings::default();

    // Add 25 files; only the most recent MAX_RECENT_FILES (20) must survive.
    for i in 0..25_u32 {
        s.add_recent_file(&format!("C:\\file{}.ps1", i));
    }
    assert_eq!(
        s.recent_files.len(),
        20,
        "list must be capped at MAX_RECENT_FILES=20"
    );
    assert_eq!(
        s.recent_files[0], "C:\\file24.ps1",
        "most-recently added file must be at front"
    );

    // Adding an existing file must move it to front without duplicating.
    s.add_recent_file("C:\\file10.ps1");
    assert_eq!(s.recent_files[0], "C:\\file10.ps1");
    assert_eq!(
        s.recent_files.len(),
        20,
        "length must not grow on de-duplicated add"
    );
}
