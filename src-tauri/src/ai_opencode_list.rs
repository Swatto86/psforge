//! OpenCode model discovery via `opencode models` (Zen, Go, ChatGPT, Ollama, …).
use crate::ai_cli::{
    apply_user_profile_env, attach_cli_stdio, blank_as_none, preview_cli_error, wait_capped,
};
use crate::ai_ollama::{AiModelChoice, AiModelList};
use crate::ai_opencode::{resolve_opencode_binary, resolve_opencode_profile};
use crate::errors::AppError;
use crate::settings::AppSettings;

/// Lists every model OpenCode CLI knows about after login/config.
/// Includes OpenCode Zen (`opencode/…`), OpenCode Go (`opencode-go/…`),
/// ChatGPT/other providers, and local Ollama. Falls back to Ollama tags if
/// the CLI listing fails.
pub async fn list_opencode_models(settings: &AppSettings) -> Result<AiModelList, AppError> {
    if settings.disable_ai {
        return Ok(AiModelList {
            models: Vec::new(),
            warning: None,
        });
    }
    let profile = resolve_opencode_profile(blank_as_none(&settings.ai_opencode_user_profile));
    let binary = resolve_opencode_binary(
        blank_as_none(&settings.ai_opencode_cli_path),
        profile.as_deref(),
    );
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("models");
    attach_cli_stdio(&mut cmd);
    apply_user_profile_env(&mut cmd, profile.as_deref(), true);
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Ok(ollama_fallback_list(
                settings,
                Some(format!("Failed to spawn OpenCode CLI: {e}")),
            )
            .await);
        }
    };
    match wait_capped(child, Vec::new()).await {
        Ok((status, stdout, stderr)) if status.success() => {
            let models = parse_opencode_model_list(&stdout);
            if !models.is_empty() {
                return Ok(AiModelList {
                    models,
                    warning: None,
                });
            }
            let warning = if stderr.trim().is_empty() {
                "OpenCode returned no models. In the OpenCode TUI run /connect for Zen, Go, or ChatGPT, then Refresh models here.".to_string()
            } else {
                preview_cli_error(&stderr)
            };
            Ok(ollama_fallback_list(settings, Some(warning)).await)
        }
        Ok((_, _, stderr)) => Ok(ollama_fallback_list(
            settings,
            Some(format!(
                "Could not list OpenCode models: {}",
                preview_cli_error(&stderr)
            )),
        )
        .await),
        Err(err) => Ok(ollama_fallback_list(settings, Some(err.message)).await),
    }
}

pub(crate) fn parse_opencode_model_list(stdout: &str) -> Vec<AiModelChoice> {
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('{') || line.starts_with('[') {
            continue;
        }
        // `opencode models` prints one `provider/model` id per line.
        if !line.contains('/') || line.contains(' ') || line.contains('\t') {
            continue;
        }
        let id = line.to_string();
        if !seen.insert(id.clone()) {
            continue;
        }
        let source = id
            .split_once('/')
            .map(|(provider, _)| provider.to_string())
            .unwrap_or_else(|| "opencode".to_string());
        let label = match source.as_str() {
            "opencode" => format!("{line} (Zen)"),
            "opencode-go" => format!("{line} (Go)"),
            _ => line.to_string(),
        };
        models.push(AiModelChoice { id, label, source });
    }
    models
}

async fn ollama_fallback_list(settings: &AppSettings, warning: Option<String>) -> AiModelList {
    match crate::ai_ollama::list_models(settings).await {
        Ok(mut list) => {
            if list.warning.is_none() {
                list.warning = warning;
            }
            list
        }
        Err(_) => AiModelList {
            models: Vec::new(),
            warning,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_models_tags_zen_and_go() {
        let models = parse_opencode_model_list(
            "opencode/big-pickle\nopencode-go/kimi-k3\nollama/qwen:latest\nbad line\n",
        );
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "opencode/big-pickle");
        assert!(models[0].label.contains("(Zen)"));
        assert_eq!(models[1].id, "opencode-go/kimi-k3");
        assert!(models[1].label.contains("(Go)"));
        assert_eq!(models[2].source, "ollama");
    }
}
