// Regression tests for command validation and graceful-degradation paths.
//
// These tests focus on commands that intentionally return empty/Unknown
// results when the selected PowerShell executable is invalid, instead of
// spawning an arbitrary local process.

const TEST_TIMEOUT_SECS: u64 = 30;

use psforge_lib::commands;
use tokio::time::{timeout, Duration};

macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_TIMEOUT_SECS), $e)
            .await
            .expect("command validation test timed out")
    };
}

fn missing_executable_path() -> String {
    std::env::temp_dir()
        .join("psforge_missing_executable_validation.exe")
        .to_string_lossy()
        .into_owned()
}

#[tokio::test]
async fn analyze_script_invalid_ps_path_returns_empty_vec() {
    bounded!(async {
        let diagnostics =
            commands::analyze_script(missing_executable_path(), "Write-Host 'test'".to_string())
                .await
                .expect("invalid PS path must degrade to empty diagnostics");

        assert!(diagnostics.is_empty());
    });
}

#[tokio::test]
async fn get_completions_invalid_ps_path_returns_empty_vec() {
    bounded!(async {
        let completions =
            commands::get_completions(missing_executable_path(), "Get-Ch".to_string(), 6)
                .await
                .expect("invalid PS path must degrade to empty completions");

        assert!(completions.is_empty());
    });
}

#[tokio::test]
async fn get_execution_policy_invalid_ps_path_returns_unknown() {
    bounded!(async {
        let policy = commands::get_execution_policy(missing_executable_path())
            .await
            .expect("invalid PS path must degrade to Unknown");

        assert_eq!(policy, "Unknown");
    });
}

#[tokio::test]
async fn get_signing_certificates_invalid_ps_path_returns_empty_vec() {
    bounded!(async {
        let certs = commands::get_signing_certificates(missing_executable_path())
            .await
            .expect("invalid PS path must degrade to empty cert list");

        assert!(certs.is_empty());
    });
}

#[tokio::test]
async fn get_variables_after_run_without_cached_snapshot_returns_empty_vec() {
    bounded!(async {
        let vars = commands::get_variables_after_run(String::new(), String::new(), String::new())
            .await
            .expect("missing cached variables must return an empty list");

        assert!(vars.is_empty());
    });
}
