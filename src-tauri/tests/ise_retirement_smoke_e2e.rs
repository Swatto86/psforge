// ISE-retirement smoke tests (backend).
//
// Goal: validate that PSForge can replace day-to-day ISE workflows on the
// command backend surface for each detected shell (PowerShell 7+ and Windows
// PowerShell 5.1 where available).
//
// Coverage in this suite:
// - Script parameter inspection
// - Module enumeration + command enumeration
// - Command parameter metadata + help retrieval
// - Completions, formatting, static-analysis graceful behavior
// - Runspace persistence semantics (persist on/off)
// - Debug breakpoint pause + continue flow
//
// Notes:
// - Tests skip cleanly when no PowerShell executable is present.
// - Each async test is wrapped in a hard timeout per Rule 3.

const TEST_TIMEOUT_SECS: u64 = 240;
const DEBUG_BREAK_WAIT_SECS: u64 = 45;

use psforge_lib::commands;
use psforge_lib::powershell::{DebugBreakpointSpec, ProcessManager};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_TIMEOUT_SECS), $e)
            .await
            .expect("ISE retirement smoke test timed out")
    };
}

fn discover_shells() -> Vec<String> {
    let mut shells = Vec::new();
    for candidate in ["pwsh.exe", "powershell.exe"] {
        let ok = std::process::Command::new(candidate)
            .args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            shells.push(candidate.to_string());
        }
    }
    shells
}

macro_rules! require_shells {
    () => {{
        let shells = discover_shells();
        if shells.is_empty() {
            eprintln!("[SKIP] No PowerShell executable found — skipping smoke test.");
            return;
        }
        shells
    }};
}

async fn run_script_collecting_output(
    pm: &ProcessManager,
    ps_path: &str,
    script: &str,
    persist_runspace: bool,
    script_args: &[String],
) -> (i32, String) {
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let lines_for_callback = lines.clone();
    let working_dir = std::env::temp_dir().to_string_lossy().to_string();

    let exit_code = pm
        .execute(
            ps_path,
            script,
            &working_dir,
            "Default",
            persist_runspace,
            script_args,
            None,
            move |line| {
                if let Ok(mut guard) = lines_for_callback.lock() {
                    guard.push(line.text);
                }
            },
        )
        .await
        .expect("ProcessManager::execute must succeed");

    let output = lines
        .lock()
        .expect("output lock")
        .iter()
        .map(|s| s.trim_end())
        .collect::<Vec<_>>()
        .join("\n");

    (exit_code, output)
}

#[tokio::test]
async fn ise_retirement_smoke_core_workflows_across_detected_shells() {
    bounded!(async {
        let shells = require_shells!();

        for ps in shells {
            eprintln!("[INFO] Running core smoke checks on {}", ps);

            let params_script = [
                "param(",
                "  [Parameter(Mandatory)][string]$Name,",
                "  [int]$Count = 1,",
                "  [switch]$Force",
                ")",
                "Write-Host $Name",
            ]
            .join("\n");
            let params = commands::get_script_parameters(ps.clone(), params_script)
                .await
                .expect("get_script_parameters must succeed");
            assert!(
                params.iter().any(|p| {
                    p.name.eq_ignore_ascii_case("Name") && p.is_mandatory && !p.has_default
                }),
                "mandatory parameter metadata missing for shell {}",
                ps
            );
            assert!(
                params
                    .iter()
                    .any(|p| p.name.eq_ignore_ascii_case("Count") && p.has_default),
                "default-valued parameter metadata missing for shell {}",
                ps
            );
            assert!(
                params.iter().any(|p| {
                    p.name.eq_ignore_ascii_case("Force")
                        && p.type_name.to_lowercase().contains("switch")
                }),
                "switch parameter metadata missing for shell {}",
                ps
            );

            let modules = commands::get_installed_modules(ps.clone())
                .await
                .expect("get_installed_modules must succeed");
            assert!(
                !modules.is_empty(),
                "module enumeration unexpectedly empty for shell {}",
                ps
            );

            let preferred_module = "Microsoft.PowerShell.Management".to_string();
            let mut module_commands =
                commands::get_module_commands(ps.clone(), preferred_module.clone())
                    .await
                    .expect("get_module_commands must succeed");
            if module_commands.is_empty() {
                module_commands =
                    commands::get_module_commands(ps.clone(), modules[0].name.clone())
                        .await
                        .expect("get_module_commands fallback must succeed");
            }
            assert!(
                !module_commands.is_empty(),
                "command enumeration unexpectedly empty for shell {}",
                ps
            );

            let command_params =
                commands::get_command_parameters(ps.clone(), "Get-ChildItem".to_string())
                    .await
                    .expect("get_command_parameters must succeed");
            assert!(
                command_params
                    .iter()
                    .any(|p| p.name.eq_ignore_ascii_case("Path")),
                "Get-ChildItem parameters missing expected -Path on shell {}",
                ps
            );

            let help = commands::get_command_help(ps.clone(), "Get-ChildItem".to_string())
                .await
                .expect("get_command_help must succeed");
            let help = help.expect("Get-ChildItem help should be available");
            assert!(
                !help.synopsis.trim().is_empty() || !help.full_text.trim().is_empty(),
                "Get-ChildItem help content unexpectedly empty for shell {}",
                ps
            );

            let completions =
                commands::get_completions(ps.clone(), "Get-Ch".to_string(), "Get-Ch".len())
                    .await
                    .expect("get_completions must succeed");
            assert!(
                !completions.is_empty(),
                "completion list unexpectedly empty for shell {}",
                ps
            );

            let format_input = "Get-ChildItem|Where-Object{$_.Name}";
            let formatted = commands::format_script(ps.clone(), format_input.to_string())
                .await
                .expect("format_script must succeed");
            assert!(
                !formatted.trim().is_empty(),
                "format_script returned empty content for shell {}",
                ps
            );

            let _diagnostics =
                commands::analyze_script(ps.clone(), "Write-Host 'Smoke Test'".to_string())
                    .await
                    .expect("analyze_script must succeed");

            let profile_path = commands::get_ps_profile_path(ps.clone())
                .await
                .expect("get_ps_profile_path must succeed");
            assert!(
                !profile_path.trim().is_empty(),
                "profile path should not be empty for shell {}",
                ps
            );

            let policy = commands::get_execution_policy(ps.clone())
                .await
                .expect("get_execution_policy must succeed");
            assert!(
                !policy.trim().is_empty(),
                "execution policy should not be empty for shell {}",
                ps
            );

            let _suggestions = commands::suggest_modules_for_command(
                ps.clone(),
                "CommandThatDoesNotExistForPSForgeSmoke".to_string(),
            )
            .await
            .expect("suggest_modules_for_command must succeed");

            // Runspace persistence semantics (critical replacement behavior).
            let pm = ProcessManager::new();

            let (code_set, output_set) = run_script_collecting_output(
                &pm,
                &ps,
                "$global:__psforge_smoke_var = 'alive'; Write-Output 'set-ok'",
                true,
                &[],
            )
            .await;
            assert_eq!(
                code_set, 0,
                "set script should exit cleanly on {}. Output:\n{}",
                ps, output_set
            );
            assert!(
                output_set.contains("set-ok"),
                "set script output missing on {}. Output:\n{}",
                ps,
                output_set
            );

            let (code_read_persist, output_read_persist) = run_script_collecting_output(
                &pm,
                &ps,
                "if ($global:__psforge_smoke_var) { Write-Output $global:__psforge_smoke_var } else { Write-Output '<missing>' }",
                true,
                &[],
            )
            .await;
            assert_eq!(
                code_read_persist, 0,
                "persisted read script should exit cleanly on {}. Output:\n{}",
                ps, output_read_persist
            );
            assert!(
                output_read_persist.contains("alive"),
                "persisted runspace value was not visible on {}. Output:\n{}",
                ps,
                output_read_persist
            );

            let (code_read_fresh, output_read_fresh) = run_script_collecting_output(
                &pm,
                &ps,
                "if ($global:__psforge_smoke_var) { Write-Output $global:__psforge_smoke_var } else { Write-Output '<missing>' }",
                false,
                &[],
            )
            .await;
            assert_eq!(
                code_read_fresh, 0,
                "fresh read script should exit cleanly on {}. Output:\n{}",
                ps, output_read_fresh
            );
            assert!(
                output_read_fresh.contains("<missing>"),
                "fresh runspace should not retain global variable on {}. Output:\n{}",
                ps,
                output_read_fresh
            );

            let _ = pm.stop().await;
        }
    });
}

#[tokio::test]
async fn ise_retirement_smoke_debug_break_marker_and_completion_across_detected_shells() {
    bounded!(async {
        let shells = require_shells!();

        for ps in shells {
            eprintln!("[INFO] Running debug smoke checks on {}", ps);

            let pm = Arc::new(ProcessManager::new());
            let output_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let output_for_callback = output_lines.clone();
            let (break_tx, mut break_rx) = mpsc::unbounded_channel::<String>();

            let pm_exec = pm.clone();
            let ps_exec = ps.clone();
            let execute_task = tokio::spawn(async move {
                let breakpoints = vec![DebugBreakpointSpec {
                    line: Some(2),
                    variable: None,
                    target_command: None,
                    mode: None,
                    condition: None,
                    hit_count: None,
                    command: None,
                }];
                let working_dir = std::env::temp_dir().to_string_lossy().to_string();
                pm_exec
                    .execute(
                        &ps_exec,
                        "$value = 1\n$value = 2\nWrite-Output 'debug-finished'",
                        &working_dir,
                        "Default",
                        false,
                        &[],
                        Some(&breakpoints),
                        move |line| {
                            if line.text.contains("<<PSF_DEBUG_BREAK>>") {
                                let _ = break_tx.send(line.text.clone());
                            }
                            if let Ok(mut guard) = output_for_callback.lock() {
                                guard.push(line.text);
                            }
                        },
                    )
                    .await
            });

            let break_line =
                match timeout(Duration::from_secs(DEBUG_BREAK_WAIT_SECS), break_rx.recv()).await {
                    Ok(Some(line)) => line,
                    _ => {
                        let snapshot = output_lines
                            .lock()
                            .expect("output lock")
                            .iter()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join("\n");
                        if let Some(found) = snapshot
                            .lines()
                            .find(|line| line.contains("<<PSF_DEBUG_BREAK>>"))
                        {
                            found.to_string()
                        } else {
                            panic!(
                                "debug breakpoint marker was not received.\nShell: {}\nOutput:\n{}",
                                ps, snapshot
                            );
                        }
                    }
                };
            assert!(
                break_line.contains("<<PSF_DEBUG_BREAK>>"),
                "unexpected break marker '{}' for shell {}",
                break_line,
                ps
            );

            let _ = pm.send_stdin("c").await;

            let exit_code = timeout(Duration::from_secs(60), execute_task)
                .await
                .expect("debug execution task timed out")
                .expect("debug execution task should not panic")
                .expect("debug execution should succeed");
            let output = output_lines
                .lock()
                .expect("output lock")
                .iter()
                .map(|s| s.trim_end())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                output.contains("<<PSF_DEBUG_BREAK>>"),
                "debug marker not present in final output on {}. Output:\n{}",
                ps,
                output
            );
            assert!(
                output.contains("debug-finished"),
                "debug run did not complete cleanly on {} (exit={}). Output:\n{}",
                ps,
                exit_code,
                output
            );
            assert!(
                !output.to_lowercase().contains("console output buffer")
                    && !output.to_lowercase().contains("the handle is invalid"),
                "debug run surfaced a console-handle regression on {} (exit={}). Output:\n{}",
                ps,
                exit_code,
                output
            );

            let _ = pm.stop().await;
        }
    });
}
