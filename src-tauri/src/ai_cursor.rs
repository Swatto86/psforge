//! Cursor Agent CLI (`agent`) provider for the in-app assistant.
use crate::ai_cli::{
    apply_user_profile_env, attach_cli_stdio, blank_as_none, cli_error, normalize_configured_path,
    preview_cli_error, wait_capped,
};
use crate::ai_ollama::{AiModelChoice, AiModelList};
use crate::errors::AppError;
use crate::settings::AppSettings;

pub struct CursorOutcome {
    pub text: String,
    pub model: String,
}

pub async fn run_cursor(
    settings: &AppSettings,
    model: &str,
    prompt: &str,
) -> Result<CursorOutcome, AppError> {
    let profile = resolve_cursor_profile(blank_as_none(&settings.ai_cursor_user_profile));
    let binary = resolve_cursor_binary(
        blank_as_none(&settings.ai_cursor_cli_path),
        profile.as_deref(),
    );
    let workspace = std::env::temp_dir().join(format!(
        "psforge-cursor-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let _ = std::fs::create_dir_all(&workspace);

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args([
        "-p",
        "--trust",
        "--mode",
        "ask",
        "--output-format",
        "text",
        "--workspace",
    ])
    .arg(&workspace);
    if !model.trim().is_empty() {
        cmd.args(["--model", model.trim()]);
    }
    attach_cli_stdio(&mut cmd);
    apply_user_profile_env(&mut cmd, profile.as_deref(), true);

    let child = cmd
        .spawn()
        .map_err(|e| cli_error("AI_CLI_FAILED", format!("Failed to spawn Cursor CLI: {e}")))?;
    let result = wait_capped(child, prompt.as_bytes().to_vec()).await;
    let _ = std::fs::remove_dir_all(&workspace);
    let (status, stdout, stderr) = result?;

    if !status.success() {
        return Err(cli_error(
            "AI_CLI_FAILED",
            format!(
                "Cursor CLI exited with {status}: {}",
                preview_cli_error(&stderr)
            ),
        ));
    }
    let text = stdout.trim().to_string();
    if text.is_empty() {
        return Err(cli_error(
            "AI_EMPTY_RESPONSE",
            "Cursor CLI returned no text.",
        ));
    }
    Ok(CursorOutcome {
        text,
        model: if model.trim().is_empty() {
            "auto".to_string()
        } else {
            model.trim().to_string()
        },
    })
}

pub async fn list_cursor_models(settings: &AppSettings) -> Result<AiModelList, AppError> {
    let profile = resolve_cursor_profile(blank_as_none(&settings.ai_cursor_user_profile));
    let binary = resolve_cursor_binary(
        blank_as_none(&settings.ai_cursor_cli_path),
        profile.as_deref(),
    );
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("--list-models");
    attach_cli_stdio(&mut cmd);
    apply_user_profile_env(&mut cmd, profile.as_deref(), true);
    let child = cmd
        .spawn()
        .map_err(|e| cli_error("AI_CLI_FAILED", format!("Failed to spawn Cursor CLI: {e}")))?;
    let (status, stdout, stderr) = wait_capped(child, Vec::new()).await?;
    if !status.success() {
        return Ok(AiModelList {
            models: Vec::new(),
            warning: Some(format!(
                "Could not list Cursor models: {}",
                preview_cli_error(&stderr)
            )),
        });
    }
    Ok(AiModelList {
        models: parse_cursor_model_list(&stdout),
        warning: None,
    })
}

pub(crate) fn parse_cursor_model_list(stdout: &str) -> Vec<AiModelChoice> {
    let mut models = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.eq_ignore_ascii_case("Available models") {
            continue;
        }
        let (id, label) = match line.split_once(" - ") {
            Some((id, label)) => (id.trim(), label.trim()),
            None => (line, line),
        };
        if id.is_empty() {
            continue;
        }
        models.push(AiModelChoice {
            id: id.to_string(),
            label: if label.is_empty() {
                id.to_string()
            } else {
                label.to_string()
            },
            source: "cursor".to_string(),
        });
    }
    models
}

fn resolve_cursor_profile(configured: Option<&str>) -> Option<String> {
    if let Some(value) = configured {
        return Some(normalize_configured_path(value));
    }
    let users = std::fs::read_dir("C:\\Users").ok()?;
    for entry in users.flatten() {
        let dir = entry.path();
        if dir.join(".cursor").is_dir()
            || dir.join(".local").join("bin").join("agent.cmd").is_file()
        {
            return Some(dir.to_string_lossy().into_owned());
        }
    }
    None
}

pub(crate) fn resolve_cursor_binary(
    configured: Option<&str>,
    user_profile: Option<&str>,
) -> String {
    if let Some(value) = configured {
        return normalize_configured_path(value);
    }
    if let Some(profile) = user_profile {
        for candidate in [
            format!("{profile}\\.local\\bin\\agent.cmd"),
            format!("{profile}\\.local\\bin\\agent.exe"),
            format!("{profile}\\AppData\\Local\\cursor-agent\\agent.cmd"),
            format!("{profile}\\AppData\\Local\\cursor-agent\\cursor-agent.ps1"),
        ] {
            if std::path::Path::new(&candidate).is_file() {
                return candidate;
            }
        }
    }
    "agent".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_list_models_text() {
        let raw = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\n";
        let models = parse_cursor_model_list(raw);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "auto");
        assert_eq!(models[1].id, "gpt-5.3-codex");
        assert_eq!(models[1].source, "cursor");
    }

    #[test]
    fn configured_binary_drops_quotes() {
        assert_eq!(
            resolve_cursor_binary(Some(r#""C:\Tools\agent.cmd""#), None),
            r"C:\Tools\agent.cmd"
        );
    }
}
