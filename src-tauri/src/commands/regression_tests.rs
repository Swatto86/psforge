use super::*;

fn test_pwsh() -> Option<std::path::PathBuf> {
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
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in ["pwsh", "pwsh.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[tokio::test]
async fn terminal_runs_staged_a_and_b_remain_independent_until_executed() {
    let Some(pwsh) = test_pwsh() else {
        eprintln!("skip: pwsh not on PATH");
        return;
    };
    let pwsh = pwsh.to_string_lossy().into_owned();
    let command_a = prepare_terminal_script_command(
        pwsh.clone(),
        "[Console]::WriteLine('TERMINAL_RUN_A')".to_string(),
        String::new(),
        "Default".to_string(),
        None,
        Some("A.ps1".to_string()),
    )
    .await
    .expect("stage run A");
    let command_b = prepare_terminal_script_command(
        pwsh.clone(),
        "[Console]::WriteLine('TERMINAL_RUN_B')".to_string(),
        String::new(),
        "Default".to_string(),
        None,
        Some("B.ps1".to_string()),
    )
    .await
    .expect("stage run B");

    fn staged_path(command: &str) -> &str {
        command
            .strip_prefix("$env:PSFORGE_RUN_FILE='")
            .and_then(|rest| rest.split("'; psrun").next())
            .expect("command must select its unique staged run path")
    }
    let path_a = staged_path(&command_a).to_string();
    let path_b = staged_path(&command_b).to_string();
    assert_ne!(path_a, path_b, "overlapping staging must not share a path");

    for (command, path, marker) in [
        (&command_a, &path_a, "TERMINAL_RUN_A"),
        (&command_b, &path_b, "TERMINAL_RUN_B"),
    ] {
        let invocation = format!("function psrun {{ & $env:PSFORGE_RUN_FILE }}; {command}");
        let output = tokio::process::Command::new(&pwsh)
            .args(["-NoLogo", "-NoProfile", "-Command"])
            .arg(invocation)
            .output()
            .await
            .expect("execute staged run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success() && stdout.contains(marker),
            "staged run did not produce {marker}: stdout={stdout} stderr={stderr}"
        );
        assert!(
            !std::path::Path::new(path).exists(),
            "executed run must clean only its own staged wrapper"
        );
    }
}

#[test]
fn utf8_bom_with_invalid_byte_round_trips_exactly_as_windows1252() {
    let original = [0xEF, 0xBB, 0xBF, b'A', 0xFF, b'B'];
    let (content, encoding, _) = detect_and_decode(&original);
    assert_eq!(encoding, "windows1252");

    let path = std::env::temp_dir().join(format!(
        "psforge_bom_invalid_roundtrip_{}.ps1",
        uuid::Uuid::new_v4()
    ));
    save_file_content_blocking(path.to_string_lossy().into_owned(), content, encoding)
        .expect("unchanged Windows-1252 save must succeed");
    let saved = std::fs::read(&path).expect("read round-trip file");
    let _ = std::fs::remove_file(&path);

    assert_eq!(saved, original, "unchanged save must preserve every byte");
}

#[test]
fn find_last_json_selects_outer_object_with_nested_aliases_array() {
    let s = concat!(
        "noise\n",
        "{\"name\":\"Name\",\"typeName\":\"System.String\",",
        "\"isMandatory\":false,\"position\":0,\"aliases\":[\"Text\",\"Value\"],",
        "\"acceptsPipelineInput\":true,\"isSwitch\":false}"
    );
    let json = find_last_json(s).expect("outer command parameter object");
    let param: CommandParameterInfo =
        serde_json::from_str(json).expect("single parameter object must remain intact");
    assert_eq!(param.name, "Name");
    assert_eq!(param.aliases, ["Text", "Value"]);
}
