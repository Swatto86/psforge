use super::*;

#[test]
fn terminal_invoke_wrapper_includes_shared_binders() {
    let script = build_terminal_invoke_wrapper("C:\\temp\\run.ps1", &[]);
    assert!(script.contains("__psforge_coerce_arg_value"));
    assert!(script.contains("__psforge_invoke_user_script"));
    assert!(script.contains("__psforge_invoke_user_script -__psforge_input_args $__psforge_args"));
    assert!(script.contains("$__psforge_script_path = 'C:\\temp\\run.ps1'"));
    assert!(
        script.contains("& $__psforge_script_path @__psforge_named @__psforge_positional"),
        "user script must use the call operator, not dot-source"
    );
    assert!(
        script.contains("NetworkCredential"),
        "PS 5.1 SecureString path must be present"
    );
    assert!(
        script.contains("__psforge_coerce_arg_value -Raw $__psforge_input_args[$__psforge_i + 1]"),
        "space-form tokens must be coerced"
    );
}

#[test]
fn persistent_host_block_includes_emit_wrapper() {
    let block = persistent_host_invoke_block();
    assert!(block.contains("__psforge_invoke_user_script_with_emit"));
    assert!(block.contains("__psforge_emit_variables"));
    assert!(block.contains("NetworkCredential"));
}

#[test]
fn invoke_wrapper_preserves_empty_positional_and_named_string_tokens() {
    let Some(pwsh) = find_pwsh() else {
        eprintln!("skip: pwsh not on PATH");
        return;
    };
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("argument-binding.ps1");
    let fixture_text = std::fs::read_to_string(&fixture).expect("read argument fixture");
    assert!(fixture_text.contains("PSFORGE_ARGUMENT_BINDING_OK"));
    let fixture_ps = fixture.to_string_lossy().replace('\'', "''");
    let invoke_path = std::env::temp_dir().join(format!(
        "psforge_argument_binding_invoke_{}.ps1",
        uuid::Uuid::new_v4()
    ));
    let invoke = build_terminal_invoke_wrapper(
        &fixture_ps,
        &[
            String::new(),
            "   ".to_string(),
            "-Text:true".to_string(),
            "-OtherText:$false".to_string(),
            "-Enabled:$false".to_string(),
            "-Force".to_string(),
        ],
    );
    std::fs::write(&invoke_path, invoke).expect("write invoke wrapper");

    let output = std::process::Command::new(&pwsh)
        .args(["-NoLogo", "-NoProfile", "-File"])
        .arg(&invoke_path)
        .output()
        .expect("spawn pwsh");
    let _ = std::fs::remove_file(&invoke_path);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "argument fixture failed: stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("PSFORGE_ARGUMENT_BINDING_OK"),
        "argument values were not preserved: stdout={stdout} stderr={stderr}"
    );
}

#[test]
fn variables_and_done_markers_start_fresh_lines_after_no_newline_output() {
    let Some(pwsh) = find_pwsh() else {
        eprintln!("skip: pwsh not on PATH");
        return;
    };
    let script = format!(
        "{PSFORGE_EMIT_VARIABLES_FN}\n$script:InspectorProbe = 'visible'\n[Console]::Out.Write('NO_NEWLINE')\n__psforge_emit_variables\n[Console]::Out.WriteLine('<<PSFORGE_DONE|probe|0>>')\n"
    );
    let script_path = std::env::temp_dir().join(format!(
        "psforge_no_newline_protocol_{}.ps1",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&script_path, script).expect("write protocol fixture");
    let output = std::process::Command::new(&pwsh)
        .args(["-NoLogo", "-NoProfile", "-File"])
        .arg(&script_path)
        .output()
        .expect("spawn pwsh");
    let _ = std::fs::remove_file(&script_path);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "protocol fixture failed: {stderr}");
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.first(), Some(&"NO_NEWLINE"), "stdout={stdout}");
    assert!(
        lines.iter().any(|line| {
            line.starts_with("<<PSFORGE_VARIABLES_JSON>>") && line.contains("InspectorProbe")
        }),
        "inspector marker must be parseable on its own line: stdout={stdout}"
    );
    assert!(
        lines.contains(&"<<PSFORGE_DONE|probe|0>>"),
        "DONE marker must remain intact: stdout={stdout}"
    );
}

/// Live gate: the shared invoke wrapper must run the coverage fixture end
/// to end under real pwsh (same binder path as untitled/selection psrun).
#[test]
fn invoke_wrapper_runs_runner_coverage_fixture() {
    let pwsh = find_pwsh();
    let Some(pwsh) = pwsh else {
        eprintln!("skip: pwsh not on PATH");
        return;
    };

    let fixture = coverage_fixture_path();
    assert!(
        fixture.is_file(),
        "missing coverage fixture at {}",
        fixture.display()
    );
    let fixture_text = std::fs::read_to_string(&fixture).expect("read coverage fixture");
    assert!(
        fixture_text.contains("PSFORGE_COVERAGE_OK"),
        "fixture must emit a known-present success marker"
    );
    assert!(
        !fixture_text.contains("$$(") && !fixture_text.contains("Item-$$_"),
        "fixture must not contain the $$ mangling patterns that break parsing"
    );

    let fixture_ps = fixture.to_string_lossy().replace('\'', "''");
    let invoke = build_terminal_invoke_wrapper(&fixture_ps, &[]);
    let invoke_path = std::env::temp_dir().join(format!(
        "psforge_coverage_invoke_{}.ps1",
        std::process::id()
    ));
    std::fs::write(&invoke_path, invoke).expect("write invoke wrapper");

    let output = std::process::Command::new(&pwsh)
        .args(["-NoLogo", "-NoProfile", "-File"])
        .arg(&invoke_path)
        .output()
        .expect("spawn pwsh");
    let _ = std::fs::remove_file(&invoke_path);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "coverage fixture failed via invoke wrapper.\nstatus={:?}\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status.code()
    );
    assert!(
        stdout.contains("PSFORGE_COVERAGE_OK sections=13"),
        "expected coverage marker in stdout, got:\n{stdout}"
    );
}

fn coverage_fixture_path() -> std::path::PathBuf {
    // src-tauri/ -> repo root
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("runner-coverage.ps1")
}

fn find_pwsh() -> Option<std::path::PathBuf> {
    let candidates = if cfg!(windows) {
        vec![
            std::path::PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            std::path::PathBuf::from(r"C:\Program Files\PowerShell\7-preview\pwsh.exe"),
        ]
    } else {
        Vec::new()
    };
    for path in candidates {
        if path.is_file() {
            return Some(path);
        }
    }
    which_on_path("pwsh")
}

fn which_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if cfg!(windows) {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}
