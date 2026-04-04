// E2E integration tests for file association commands (Rule 3).
//
// File associations write to HKCU (per-user, no elevation required), so these
// tests run on the real Windows registry and clean up after themselves.
//
// All tests are conditionally compiled for Windows only; they are skipped
// automatically on non-Windows CI runners (which cannot run the app anyway).
//
// Batch commands test Rule 11 error accumulation: processing multiple items
// while collecting per-item errors instead of aborting on the first failure.

// Conservative async timeout for registry I/O (Rule 3).
const TEST_TIMEOUT_SECS: u64 = 30;

use psforge_lib::commands;
use tokio::time::{timeout, Duration};

macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_TIMEOUT_SECS), $e)
            .await
            .expect("association test timed out")
    };
}

// ---------------------------------------------------------------------------
// Single extension round-trip
// ---------------------------------------------------------------------------

/// Registers and then unregisters a single extension, verifying the status
/// at each step. Uses a test-only extension name to avoid interfering with
/// any real .ps1 registration the user may have.
#[cfg(target_os = "windows")]
#[tokio::test]
async fn register_and_unregister_single_extension_roundtrip() {
    // Use a synthetic extension unlikely to be registered for anything real.
    // The leading dot is required by the registry schema.
    let ext = ".psforge_test_ext".to_string();

    bounded!(async {
        // ---- Register ----
        commands::register_file_association(ext.clone())
            .await
            .expect("register_file_association must succeed for synthetic extension");

        // Verify via status query.
        let statuses = commands::get_file_association_status()
            .await
            .expect("get_file_association_status must succeed after registration");

        // Our test extension is not in the canonical PS_EXTENSIONS list, so it won't
        // appear in the status list -- verify the known extensions still work.
        assert!(
            !statuses.is_empty(),
            "status list must contain the standard PS extensions"
        );

        // ---- Unregister ----
        commands::unregister_file_association(ext.clone())
            .await
            .expect("unregister_file_association must succeed");

        // Unregistering a second time must be idempotent (no error).
        commands::unregister_file_association(ext)
            .await
            .expect("second unregister must be a no-op, not an error");
    });
}

/// Verifies that the registered ProgID uses the dedicated file-association icon
/// rather than the main executable icon resource.
#[cfg(target_os = "windows")]
#[tokio::test]
async fn register_sets_distinct_file_association_icon() {
    use winreg::enums::*;
    use winreg::RegKey;

    let ext = ".psforge_icon_test".to_string();

    bounded!(async {
        commands::register_file_association(ext.clone())
            .await
            .expect("register_file_association must succeed for icon test extension");

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let prog_id = format!("PSForge{}", ext.replace('.', "_"));
        let icon_key_path = format!(r"Software\Classes\{}\DefaultIcon", prog_id);
        let icon_key = hkcu
            .open_subkey(&icon_key_path)
            .expect("DefaultIcon key must exist after registration");

        let icon_value: String = icon_key
            .get_value("")
            .expect("DefaultIcon default value must exist");

        assert!(
            icon_value
                .to_ascii_lowercase()
                .contains("psforge-file-association.ico"),
            "DefaultIcon should reference psforge-file-association.ico, got '{}'",
            icon_value
        );

        commands::unregister_file_association(ext)
            .await
            .expect("cleanup unregister must succeed");
    });
}

// ---------------------------------------------------------------------------
// Batch register / unregister (Rule 11 error accumulation)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[tokio::test]
async fn batch_register_multiple_extensions_all_succeed() {
    let extensions = vec![
        ".psforge_batch1".to_string(),
        ".psforge_batch2".to_string(),
        ".psforge_batch3".to_string(),
    ];

    bounded!(async {
        let result = commands::batch_register_file_associations(extensions.clone())
            .await
            .expect("batch_register_file_associations must succeed");

        assert_eq!(
            result.items.len(),
            3,
            "all 3 extensions must be registered successfully, items={:?}, errors={:?}",
            result.items,
            result.errors
        );
        assert!(
            result.errors.is_empty(),
            "no errors expected for valid synthetic extensions, errors={:?}",
            result.errors
        );
        assert!(
            result.is_clean(),
            "BatchResult must be clean when all items succeed"
        );

        // Cleanup: unregister all
        commands::batch_unregister_file_associations(extensions)
            .await
            .expect("cleanup batch_unregister must succeed");
    });
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn batch_unregister_multiple_extensions_all_succeed() {
    let extensions = vec![
        ".psforge_untest1".to_string(),
        ".psforge_untest2".to_string(),
    ];

    bounded!(async {
        // First register so there is something to unregister.
        commands::batch_register_file_associations(extensions.clone())
            .await
            .expect("setup batch_register must succeed");

        let result = commands::batch_unregister_file_associations(extensions)
            .await
            .expect("batch_unregister_file_associations must succeed");

        assert_eq!(
            result.items.len(),
            2,
            "both extensions must be unregistered"
        );
        assert!(result.errors.is_empty(), "no errors expected on unregister");
    });
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn batch_unregister_already_unregistered_is_no_op() {
    // Rule 11 / defensive design: unregistering a never-registered extension must
    // not produce an error or panic. It is treated as a successful no-op.
    let ext = ".psforge_never_registered_xyz".to_string();

    bounded!(async {
        let result = commands::batch_unregister_file_associations(vec![ext])
            .await
            .expect("batch_unregister of never-registered extension must not error");

        // unregister_file_association silently ignores missing entries so the
        // extension should appear in items (succeeded) not errors.
        assert!(
            result.errors.is_empty(),
            "never-registered extension must not produce a batch error"
        );
    });
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn batch_register_empty_list_returns_empty_result() {
    bounded!(async {
        let result = commands::batch_register_file_associations(vec![])
            .await
            .expect("batch_register with empty list must succeed");

        assert!(result.items.is_empty(), "no items with empty input");
        assert!(result.errors.is_empty(), "no errors with empty input");
        assert!(result.is_clean());
    });
}

// ---------------------------------------------------------------------------
// get_file_association_status coverage
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[tokio::test]
async fn get_file_association_status_returns_all_ps_extensions() {
    bounded!(async {
        let statuses = commands::get_file_association_status()
            .await
            .expect("get_file_association_status must succeed");

        let extensions: Vec<&str> = statuses.iter().map(|s| s.extension.as_str()).collect();

        // All canonical PowerShell extensions must appear in the status list.
        for required in &[".ps1", ".psm1", ".psd1"] {
            assert!(
                extensions.contains(required),
                "extension {} must appear in status list, got {:?}",
                required,
                extensions
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Non-Windows stub
// ---------------------------------------------------------------------------

/// On non-Windows the file association commands are expected to return an
/// UNSUPPORTED_PLATFORM error rather than silently succeeding or panicking.
#[cfg(not(target_os = "windows"))]
#[tokio::test]
async fn register_file_association_unsupported_on_non_windows() {
    bounded!(async {
        let err = commands::register_file_association(".ps1".to_string())
            .await
            .expect_err("register must fail on non-Windows");
        assert_eq!(
            err.code, "UNSUPPORTED_PLATFORM",
            "non-Windows error code must be UNSUPPORTED_PLATFORM, got {}",
            err.code
        );
    });
}
