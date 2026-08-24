//! OpenAI Codex CLI (`codex exec`) provider for the in-app assistant.
use crate::ai_cli::{
    apply_user_profile_env, attach_cli_stdio, blank_as_none, cli_error, normalize_configured_path,
    preview_cli_error, wait_capped,
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
    let out_path = std::env::temp_dir().join(format!(
        "psforge-codex-out-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let workspace = std::env::temp_dir().join(format!("psforge-codex-ws-{}", std::process::id()));
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

    if !status.success() && text.trim().is_empty() {
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
    if let Some(value) = configured {
        return Some(normalize_configured_path(value));
    }
    let users = std::fs::read_dir("C:\\Users").ok()?;
    for entry in users.flatten() {
        let dir = entry.path();
        if dir.join(".codex").is_dir() {
            return Some(dir.to_string_lossy().into_owned());
        }
    }
    None
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
}
