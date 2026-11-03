//! OpenAI Codex CLI (`codex exec`) provider for the in-app assistant.
use crate::ai_cli::{
    apply_user_profile_env, attach_cli_stdio, blank_as_none, cli_error, normalize_configured_path,
    preview_cli_error, resolve_cli_profile, unique_temp_path, wait_capped,
};
use crate::errors::AppError;
use crate::settings::AppSettings;
use serde_json::Value;
use std::path::PathBuf;

pub struct CodexOutcome {
    pub text: String,
    pub model: String,
}

pub async fn run_codex(
    settings: &AppSettings,
    model: &str,
    prompt: &str,
) -> Result<CodexOutcome, AppError> {
    let profile = resolve_codex_profile(blank_as_none(&settings.ai_codex_user_profile));
    let binary = resolve_codex_binary(
        blank_as_none(&settings.ai_codex_cli_path),
        profile.as_deref(),
    );
    let out_path = unique_temp_path("psforge-codex-out").with_extension("txt");
    let workspace = unique_temp_path("psforge-codex-ws");
    let _ = std::fs::create_dir_all(&workspace);

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args([
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-C",
    ])
    .arg(&workspace)
    .arg("-o")
    .arg(&out_path);
    if !model.trim().is_empty() {
        cmd.args(["-m", model.trim()]);
    }
    // Prompt via stdin (`-`) so large debug bundles do not hit argv limits.
    cmd.arg("-");
    attach_cli_stdio(&mut cmd);
    apply_user_profile_env(&mut cmd, profile.as_deref(), true);

    let child = cmd
        .spawn()
        .map_err(|e| cli_error("AI_CLI_FAILED", format!("Failed to spawn Codex CLI: {e}")))?;
    let result = wait_capped(child, prompt.as_bytes().to_vec()).await;
    let text = read_codex_output(&out_path, result.as_ref().ok().map(|r| r.1.as_str()));
    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_dir_all(&workspace);
    let (status, _stdout, stderr) = result?;

    if !status.success() {
        return Err(cli_error(
            "AI_CLI_FAILED",
            format!(
                "Codex CLI exited with {status}: {}",
                preview_cli_error(&stderr)
            ),
        ));
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(cli_error(
            "AI_EMPTY_RESPONSE",
            "Codex CLI returned no text.",
        ));
    }
    Ok(CodexOutcome {
        text,
        model: if model.trim().is_empty() {
            "default".to_string()
        } else {
            model.trim().to_string()
        },
    })
}

fn read_codex_output(out_path: &PathBuf, stdout: Option<&str>) -> String {
    if let Ok(from_file) = std::fs::read_to_string(out_path) {
        if !from_file.trim().is_empty() {
            return from_file;
        }
    }
    let Some(stdout) = stdout else {
        return String::new();
    };
    // Prefer last agent message if JSONL was emitted on stdout.
    let mut last = String::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(msg) = ev
            .get("msg")
            .and_then(|m| m.get("message"))
            .and_then(|m| m.as_str())
            .or_else(|| ev.get("last_agent_message").and_then(|m| m.as_str()))
        {
            last = msg.to_string();
        }
    }
    if !last.is_empty() {
        last
    } else {
        stdout.to_string()
    }
}

fn resolve_codex_profile(configured: Option<&str>) -> Option<String> {
    resolve_cli_profile(configured, |dir| dir.join(".codex").is_dir())
}

pub(crate) fn resolve_codex_binary(configured: Option<&str>, user_profile: Option<&str>) -> String {
    if let Some(value) = configured {
        return normalize_configured_path(value);
    }
    if let Some(profile) = user_profile {
        for candidate in [
            format!("{profile}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"),
            format!("{profile}\\.local\\bin\\codex.exe"),
            format!("{profile}\\AppData\\Roaming\\npm\\codex.cmd"),
        ] {
            if std::path::Path::new(&candidate).is_file() {
                return candidate;
            }
        }
    }
    "codex".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_binary_drops_quotes() {
        assert_eq!(
            resolve_codex_binary(Some(r#""C:\Tools\codex.exe""#), None),
            r"C:\Tools\codex.exe"
        );
    }

    #[test]
    fn prefers_output_file_over_stdout() {
        let path = std::env::temp_dir().join("psforge-codex-test-out.txt");
        std::fs::write(&path, "from-file").unwrap();
        let text = read_codex_output(&path, Some("from-stdout"));
        let _ = std::fs::remove_file(&path);
        assert_eq!(text.trim(), "from-file");
    }

    #[tokio::test]
    async fn nonzero_exit_with_partial_output_is_an_error() {
        let root = unique_temp_path("psforge-codex-failing-cli");
        std::fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let script = root.join("codex-fail.cmd");
        #[cfg(not(windows))]
        let script = root.join("codex-fail");

        #[cfg(windows)]
        std::fs::write(
            &script,
            concat!(
                "@echo off\n",
                "setlocal\n",
                "set \"out=\"\n",
                ":args\n",
                "if \"%~1\"==\"\" goto done\n",
                "if \"%~1\"==\"-o\" (\n",
                "  set \"out=%~2\"\n",
                "  shift\n",
                "  shift\n",
                "  goto args\n",
                ")\n",
                "shift\n",
                "goto args\n",
                ":done\n",
                "echo partial answer>\"%out%\"\n",
                "echo synthetic codex failure>&2\n",
                "exit /b 7\n",
            ),
        )
        .unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::permissions::PermissionsExt;
            std::fs::write(
                &script,
                concat!(
                    "#!/bin/sh\n",
                    "out=\n",
                    "while [ \"$#\" -gt 0 ]; do\n",
                    "  if [ \"$1\" = \"-o\" ]; then\n",
                    "    out=$2\n",
                    "    shift 2\n",
                    "  else\n",
                    "    shift\n",
                    "  fi\n",
                    "done\n",
                    "printf 'partial answer\\n' > \"$out\"\n",
                    "printf 'synthetic codex failure\\n' >&2\n",
                    "exit 7\n",
                ),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let settings = AppSettings {
            ai_codex_cli_path: script.to_string_lossy().into_owned(),
            ..AppSettings::default()
        };
        let result = run_codex(&settings, "test-model", "test prompt").await;
        let _ = std::fs::remove_dir_all(&root);

        let err = result
            .err()
            .expect("a nonzero Codex exit must fail despite partial output");
        assert_eq!(err.code, "AI_CLI_FAILED");
        assert!(err.message.contains("Codex CLI exited with"));
        assert!(err.message.contains("synthetic codex failure"));
    }
}
