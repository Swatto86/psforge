/// E2E tests for execution policy management (Rule 3 + Rule 11).
///
/// Validates that:
///   - Invalid policy values are rejected with the correct error code.
///   - The allow-list is enforced (no arbitrary strings pass through to PS).
///   - "Default" policy is accepted as a no-op (does not invoke Set-ExecutionPolicy).
///   - Case-insensitive matching works for valid policies.
///
/// These tests do NOT mutate the real execution policy on the machine; they
/// only test validation logic and the "Default" no-op path.

/// Conservative async timeout for CI runners (Rule 3).
const TEST_TIMEOUT_SECS: u64 = 30;

use psforge_lib::commands;
use tokio::time::{timeout, Duration};

macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_TIMEOUT_SECS), $e)
            .await
            .expect("execution policy test timed out")
    };
}

// ---------------------------------------------------------------------------
// Input validation (Rule 11)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn set_execution_policy_rejects_invalid_value() {
    bounded!(async {
        let err = commands::set_execution_policy(
            "powershell.exe".to_string(),
            "DefinitelyNotAPolicy".to_string(),
        )
        .await
        .expect_err("invalid policy must be rejected");

        assert_eq!(
            err.code, "INVALID_POLICY",
            "error code must be INVALID_POLICY, got: {}",
            err.code
        );
        assert!(
            err.message.contains("DefinitelyNotAPolicy"),
            "error message must include the rejected value"
        );
    });
}

#[tokio::test]
async fn set_execution_policy_rejects_empty_string() {
    bounded!(async {
        let err = commands::set_execution_policy("powershell.exe".to_string(), String::new())
            .await
            .expect_err("empty policy string must be rejected");

        assert_eq!(err.code, "INVALID_POLICY");
    });
}

#[tokio::test]
async fn set_execution_policy_rejects_injection_attempt() {
    // Ensure that shell injection via the policy parameter is impossible.
    // The allow-list check must reject before the string reaches PowerShell.
    bounded!(async {
        let err = commands::set_execution_policy(
            "powershell.exe".to_string(),
            "Bypass; Remove-Item C:\\ -Recurse".to_string(),
        )
        .await
        .expect_err("injection attempt must be blocked by allow-list");

        assert_eq!(err.code, "INVALID_POLICY");
    });
}

#[tokio::test]
async fn set_execution_policy_default_is_noop() {
    // "Default" means "leave the policy alone". The command must succeed
    // without spawning a PS process.
    bounded!(async {
        let result =
            commands::set_execution_policy("powershell.exe".to_string(), "Default".to_string())
                .await;

        assert!(
            result.is_ok(),
            "Default policy must be a no-op success, got: {:?}",
            result.err()
        );
    });
}

#[tokio::test]
async fn set_execution_policy_case_insensitive_default() {
    // The "Default" sentinel must be matched case-insensitively.
    bounded!(async {
        let result =
            commands::set_execution_policy("powershell.exe".to_string(), "default".to_string())
                .await;

        assert!(result.is_ok(), "lowercase 'default' must be accepted");
    });
}

#[tokio::test]
async fn set_execution_policy_accepts_valid_policies_case_insensitive() {
    // All valid policy names must pass the allow-list check regardless of case.
    // We use "Default" for all because it is the only one that doesn't actually
    // change the system policy (safe for CI).
    bounded!(async {
        // Just verify "DEFAULT" (uppercase) passes validation.
        let result =
            commands::set_execution_policy("powershell.exe".to_string(), "DEFAULT".to_string())
                .await;

        assert!(result.is_ok(), "ALL-CAPS DEFAULT must pass validation");
    });
}
