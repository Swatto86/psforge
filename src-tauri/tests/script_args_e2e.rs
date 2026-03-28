/// E2E regression tests for script-argument binding in the persistent host.
///
/// These tests exercise `ProcessManager::execute` directly so they validate the
/// same wrapper/invoke-script path used by the frontend run/debug commands.

const TEST_TIMEOUT_SECS: u64 = 90;

use psforge_lib::powershell::ProcessManager;
use std::sync::{Arc, Mutex};
use tokio::time::{timeout, Duration};

macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_TIMEOUT_SECS), $e)
            .await
            .expect("script-args test timed out")
    };
}

fn find_ps() -> Option<String> {
    for candidate in ["pwsh.exe", "powershell.exe"] {
        let ok = std::process::Command::new(candidate)
            .args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(candidate.to_string());
        }
    }
    None
}

async fn run_script_with_args(script: &str, script_args: Vec<String>) -> Option<(i32, String)> {
    let ps = match find_ps() {
        Some(p) => p,
        None => {
            eprintln!("[SKIP] No PowerShell executable found.");
            return None;
        }
    };

    let pm = ProcessManager::new();
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let lines_for_callback = lines.clone();

    let work_dir = std::env::temp_dir().to_string_lossy().to_string();
    let exit_code = pm
        .execute(
            &ps,
            script,
            &work_dir,
            "Default",
            false,
            &script_args,
            None,
            move |line| {
                if let Ok(mut guard) = lines_for_callback.lock() {
                    guard.push(line.text);
                }
            },
        )
        .await
        .expect("ProcessManager::execute must succeed");

    let _ = pm.stop().await;

    let output = lines
        .lock()
        .expect("output lock")
        .iter()
        .map(|s| s.trim_end())
        .collect::<Vec<_>>()
        .join("\n");

    Some((exit_code, output))
}

#[tokio::test]
async fn script_args_bind_named_parameters_for_begin_process_end_scripts() {
    bounded!(async {
        let script = [
            "param([Parameter(Mandatory)][string]$Identity)",
            "begin { $items = [System.Collections.Generic.List[string]]::new() }",
            "process { $items.Add($Identity) }",
            "end { Write-Host ('BPE:' + $items[0]) }",
        ]
        .join("\n");
        let args = vec!["-Identity".to_string(), "ADUpdateTest".to_string()];

        let (exit_code, output) = match run_script_with_args(&script, args).await {
            Some(v) => v,
            None => return,
        };

        assert_eq!(exit_code, 0, "script should exit cleanly. Output:\n{}", output);
        assert!(
            output.contains("BPE:ADUpdateTest"),
            "expected begin/process/end output not found. Output:\n{}",
            output
        );
        assert!(
            !output.contains("The term 'begin' is not recognized"),
            "script was not executed as a proper file parse unit. Output:\n{}",
            output
        );
    });
}

#[tokio::test]
async fn script_args_bind_multiple_named_parameters_with_type_conversion() {
    bounded!(async {
        let script = "param([Parameter(Mandatory)][string]$FirstName, [Parameter(Mandatory)][int]$Age)\nWrite-Host \"$FirstName is $Age years old\"";
        let args = vec![
            "-FirstName".to_string(),
            "Alice".to_string(),
            "-Age".to_string(),
            "30".to_string(),
        ];

        let (exit_code, output) = match run_script_with_args(script, args).await {
            Some(v) => v,
            None => return,
        };

        assert_eq!(exit_code, 0, "script should exit cleanly. Output:\n{}", output);
        assert!(
            output.contains("Alice is 30 years old"),
            "expected multi-param output not found. Output:\n{}",
            output
        );
    });
}

#[tokio::test]
async fn script_args_bind_boolean_named_parameter_from_inline_value() {
    bounded!(async {
        let script = [
            "param([Parameter(Mandatory)][bool]$IsVerbose)",
            "if ($IsVerbose) { Write-Host 'verbose-on' } else { Write-Host 'verbose-off' }",
        ]
        .join("\n");
        let args = vec!["-IsVerbose:$true".to_string()];

        let (exit_code, output) = match run_script_with_args(&script, args).await {
            Some(v) => v,
            None => return,
        };

        assert_eq!(exit_code, 0, "script should exit cleanly. Output:\n{}", output);
        assert!(
            output.contains("verbose-on"),
            "boolean parameter did not bind as true. Output:\n{}",
            output
        );
    });
}

#[tokio::test]
async fn script_args_preserve_leading_dash_in_parameter_values() {
    bounded!(async {
        let script = "param([Parameter(Mandatory)][string]$Value)\nWrite-Host $Value";
        let args = vec!["-Value".to_string(), "-LeadingDash".to_string()];

        let (exit_code, output) = match run_script_with_args(script, args).await {
            Some(v) => v,
            None => return,
        };

        assert_eq!(exit_code, 0, "script should exit cleanly. Output:\n{}", output);
        assert!(
            output.contains("-LeadingDash"),
            "leading-dash argument value was not preserved. Output:\n{}",
            output
        );
    });
}

