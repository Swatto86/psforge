//! OpenCode CLI provider, including local Ollama models.
use crate::ai_cli::{
    apply_user_profile_env, attach_cli_stdio, blank_as_none, cli_error, effort_variant,
    normalize_configured_path, preview_cli_error, wait_capped,
};
use crate::ai_ollama::{fetch_ollama_tags, normalize_ollama_base_url};
use crate::errors::AppError;
use crate::settings::AppSettings;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const QUALIFIED_MODEL_PREFIXES: &[&str] = &[
    "ollama/",
    "anthropic/",
    "openai/",
    "google/",
    "openrouter/",
    "kilo/",
    "opencode/",
    "azure/",
    "groq/",
    "mistral/",
    "xai/",
    "github-copilot/",
    "copilot/",
    "amazon-bedrock/",
    "google-vertex/",
];

pub struct OpenCodeOutcome {
    pub text: String,
    pub model: String,
}

pub async fn run_opencode(
    settings: &AppSettings,
    requested_model: &str,
    prompt: &str,
) -> Result<OpenCodeOutcome, AppError> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let workspace =
        std::env::temp_dir().join(format!("psforge-opencode-{}-{seq}", std::process::id()));
    let _ = std::fs::create_dir_all(&workspace);
    let result = run_opencode_inner(settings, requested_model, prompt, &workspace).await;
    let _ = std::fs::remove_dir_all(&workspace);
    result
}

async fn run_opencode_inner(
    settings: &AppSettings,
    requested_model: &str,
    prompt: &str,
    workspace: &Path,
) -> Result<OpenCodeOutcome, AppError> {
    let ollama_base = normalize_ollama_base_url(&settings.ai_ollama_base_url)?;
    let model = resolve_opencode_model(requested_model, &ollama_base).await?;
    let profile = resolve_opencode_profile(blank_as_none(&settings.ai_opencode_user_profile));
    let binary = resolve_opencode_binary(
        blank_as_none(&settings.ai_opencode_cli_path),
        profile.as_deref(),
    );
    let args = opencode_run_args(&model, workspace, effort_variant(&settings.ai_effort));

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args(&args);
    attach_cli_stdio(&mut cmd);
    cmd.env("OPENCODE_DISABLE_AUTOUPDATE", "1")
        .env("OPENCODE_CLIENT", "psforge");
    apply_user_profile_env(&mut cmd, profile.as_deref(), true);
    if model.starts_with("ollama/") {
        cmd.env(
            "OPENCODE_CONFIG_CONTENT",
            opencode_ollama_inline_config(&ollama_base, &model),
        );
    }

    let child = cmd.spawn().map_err(|e| {
        cli_error(
            "AI_CLI_FAILED",
            format!("Failed to spawn OpenCode CLI: {e}"),
        )
    })?;
    let (status, stdout, stderr) = wait_capped(child, prompt.as_bytes().to_vec()).await?;
    if !status.success() {
        return Err(cli_error(
            "AI_CLI_FAILED",
            format!(
                "OpenCode CLI exited with {status}: {}",
                preview_cli_error(&stderr)
            ),
        ));
    }
    let text = parse_opencode_json_output(&stdout);
    if text.trim().is_empty() {
        return Err(cli_error("AI_EMPTY_RESPONSE", "OpenCode returned no text."));
    }
    Ok(OpenCodeOutcome { text, model })
}

async fn resolve_opencode_model(requested: &str, ollama_base: &str) -> Result<String, AppError> {
    let normalized = normalize_opencode_model(requested);
    if !normalized.is_empty() {
        return Ok(normalized);
    }
    let tags = fetch_ollama_tags(ollama_base).await?;
    let Some(first) = tags.into_iter().next() else {
        return Err(cli_error(
            "AI_MODEL_REQUIRED",
            "OpenCode needs a model. Start Ollama and pull a model, or type provider/model (for example ollama/qwen2.5-coder).",
        ));
    };
    Ok(format!("ollama/{first}"))
}

pub(crate) fn opencode_run_args(model: &str, dir: &Path, variant: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--dir".to_string(),
        dir.to_string_lossy().into_owned(),
        "--auto".to_string(),
        "--title".to_string(),
        "psforge".to_string(),
    ];
    if let Some(variant) = variant {
        args.push("--variant".to_string());
        args.push(variant.to_string());
    }
    args
}

pub(crate) fn normalize_opencode_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_ascii_lowercase();
    if QUALIFIED_MODEL_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        trimmed.to_string()
    } else {
        format!("ollama/{trimmed}")
    }
}

pub(crate) fn parse_opencode_json_output(stdout: &str) -> String {
    let mut texts = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(text) = completed_text_part(&value) {
            texts.push(text);
        }
    }
    let joined = texts.join("\n");
    if joined.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        joined
    }
}

fn completed_text_part(value: &Value) -> Option<String> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let part = match kind {
        "text" => value.get("part"),
        "message.part.updated" => value
            .get("properties")
            .and_then(|props| props.get("part"))
            .or_else(|| value.get("part")),
        _ => None,
    }?;
    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("text");
    if part_type != "text" {
        return None;
    }
    let ended = part.get("time").and_then(|time| time.get("end")).is_some();
    if kind == "message.part.updated" && !ended {
        return None;
    }
    part.get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub(crate) fn opencode_ollama_inline_config(ollama_base: &str, model_id: &str) -> String {
    let tag = model_id
        .strip_prefix("ollama/")
        .or_else(|| model_id.strip_prefix("Ollama/"))
        .unwrap_or(model_id);
    let openai_base = if ollama_base.ends_with("/v1") {
        ollama_base.to_string()
    } else {
        format!("{}/v1", ollama_base.trim_end_matches('/'))
    };
    let mut models = serde_json::Map::new();
    models.insert(tag.to_string(), json!({ "name": tag }));
    json!({
        "provider": {
            "ollama": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Ollama (local)",
                "options": { "baseURL": openai_base },
                "models": models
            }
        },
        "permission": {
            "edit": "deny",
            "bash": "deny"
        }
    })
    .to_string()
}

fn resolve_opencode_profile(configured: Option<&str>) -> Option<String> {
    if let Some(value) = configured {
        return Some(normalize_configured_path(value));
    }
    let users = std::fs::read_dir("C:\\Users").ok()?;
    for entry in users.flatten() {
        let dir = entry.path();
        if opencode_marker_exists(&dir) {
            return Some(dir.to_string_lossy().into_owned());
        }
    }
    None
}

fn opencode_marker_exists(profile: &Path) -> bool {
    let config = profile.join(".config").join("opencode");
    config.join("opencode.json").is_file()
        || config.join("opencode.jsonc").is_file()
        || profile
            .join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json")
            .is_file()
}

fn resolve_opencode_binary(configured: Option<&str>, user_profile: Option<&str>) -> String {
    if let Some(value) = configured {
        return normalize_configured_path(value);
    }
    if let Some(profile) = user_profile {
        for candidate in [
            format!("{profile}\\.opencode\\bin\\opencode.exe"),
            format!("{profile}\\.local\\bin\\opencode.exe"),
            format!(
                "{profile}\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"
            ),
            format!("{profile}\\AppData\\Roaming\\npm\\opencode.exe"),
            format!("{profile}\\AppData\\Roaming\\npm\\opencode.cmd"),
        ] {
            if PathBuf::from(&candidate).is_file() {
                return candidate;
            }
        }
    }
    "opencode".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_model_prefixes_bare_ollama_tags() {
        assert_eq!(normalize_opencode_model(""), "");
        assert_eq!(
            normalize_opencode_model("qwen2.5-coder"),
            "ollama/qwen2.5-coder"
        );
        assert_eq!(
            normalize_opencode_model("ollama/qwen2.5-coder:latest"),
            "ollama/qwen2.5-coder:latest"
        );
        assert_eq!(
            normalize_opencode_model("anthropic/claude-sonnet-4-6"),
            "anthropic/claude-sonnet-4-6"
        );
        assert_eq!(
            normalize_opencode_model("huihui_ai/qwen3.8-abliterated:latest"),
            "ollama/huihui_ai/qwen3.8-abliterated:latest"
        );
    }

    #[test]
    fn parse_json_takes_completed_text_and_ignores_tools() {
        let stdout = concat!(
            r#"{"type":"text","part":{"type":"text","text":"{\"answer\":\"ok\",\"code\":null}","time":{"end":1}}}"#,
            "\n",
            r#"{"type":"text","part":{"type":"tool","text":"should-skip"}}"#,
            "\n",
            r#"{"type":"message.part.updated","part":{"type":"text","text":"partial"}}"#,
            "\n",
        );
        assert_eq!(
            parse_opencode_json_output(stdout),
            r#"{"answer":"ok","code":null}"#
        );
    }

    #[test]
    fn run_args_keep_model_as_its_own_flag() {
        let dir = PathBuf::from(r"C:\tmp\psforge-opencode");
        let args = opencode_run_args("ollama/qwen2.5-coder", &dir, Some("high"));
        let model_at = args
            .iter()
            .position(|a| a == "--model")
            .expect("model flag");
        assert_eq!(args[model_at + 1], "ollama/qwen2.5-coder");
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--format" && w[1] == "json"));
        assert!(args.contains(&"--auto".to_string()));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--variant" && w[1] == "high"));
    }

    #[test]
    fn inline_config_keeps_namespaced_ollama_tags() {
        let config = opencode_ollama_inline_config(
            "http://127.0.0.1:11434",
            "ollama/huihui_ai/qwen3.8-abliterated:latest",
        );
        assert!(config.contains("huihui_ai/qwen3.8-abliterated:latest"));
        assert!(!config.contains(r#""qwen3.8-abliterated:latest""#));
        assert!(config.contains("http://127.0.0.1:11434/v1"));
        assert_eq!(
            resolve_opencode_binary(Some(r#""C:\Tools\opencode.exe""#), None),
            r"C:\Tools\opencode.exe"
        );
    }
}
