//! Local Ollama discovery for the OpenCode provider.
use crate::ai_cli::cli_error;
use crate::errors::AppError;
use crate::settings::AppSettings;
use serde::{Deserialize, Serialize};

const DEFAULT_OLLAMA_BASE: &str = "http://127.0.0.1:11434";
const OLLAMA_LIST_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelChoice {
    pub id: String,
    pub label: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelList {
    pub models: Vec<AiModelChoice>,
    pub warning: Option<String>,
}

pub async fn list_models(settings: &AppSettings) -> Result<AiModelList, AppError> {
    if settings.disable_ai {
        return Ok(AiModelList {
            models: Vec::new(),
            warning: None,
        });
    }
    let base = normalize_ollama_base_url(&settings.ai_ollama_base_url)?;
    match fetch_ollama_tags(&base).await {
        Ok(tags) => Ok(AiModelList {
            models: tags
                .into_iter()
                .map(|tag| AiModelChoice {
                    id: format!("ollama/{tag}"),
                    label: tag,
                    source: "ollama".to_string(),
                })
                .collect(),
            warning: None,
        }),
        Err(err) => Ok(AiModelList {
            models: Vec::new(),
            warning: Some(err.message),
        }),
    }
}

pub(crate) async fn fetch_ollama_tags(base: &str) -> Result<Vec<String>, AppError> {
    let url = format!("{base}/api/tags");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(OLLAMA_LIST_TIMEOUT_SECS))
        .build()
        .map_err(|e| cli_error("AI_REQUEST_FAILED", e.to_string()))?;
    let response = client.get(&url).send().await.map_err(|e| {
        cli_error(
            "AI_OLLAMA_UNAVAILABLE",
            format!("Ollama is not reachable at {base}: {e}"),
        )
    })?;
    if !response.status().is_success() {
        return Err(cli_error(
            "AI_OLLAMA_UNAVAILABLE",
            format!("Ollama returned {} from {url}", response.status()),
        ));
    }
    let parsed: OllamaTags = response
        .json()
        .await
        .map_err(|e| cli_error("AI_RESPONSE_FAILED", e.to_string()))?;
    Ok(parsed
        .models
        .into_iter()
        .map(|model| model.name)
        .filter(|name| !name.trim().is_empty())
        .collect())
}

pub(crate) fn normalize_ollama_base_url(raw: &str) -> Result<String, AppError> {
    let mut trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Ok(DEFAULT_OLLAMA_BASE.to_string());
    }
    if let Some(without_v1) = trimmed.strip_suffix("/v1") {
        trimmed = without_v1.trim_end_matches('/').to_string();
    }
    let invalid_url = || {
        cli_error(
            "AI_OLLAMA_URL",
            "Ollama URL must be a local http(s) address (127.0.0.1, localhost, or [::1]).",
        )
    };
    let parsed = reqwest::Url::parse(&trimmed).map_err(|_| invalid_url())?;
    let authority = trimmed
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(rest))
        .unwrap_or_default();
    let local_host = parsed.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost") || matches!(host, "127.0.0.1" | "[::1]")
    });
    if !matches!(parsed.scheme(), "http" | "https") || authority.contains('@') || !local_host {
        return Err(invalid_url());
    }
    Ok(trimmed)
}

#[derive(Deserialize)]
struct OllamaTags {
    #[serde(default)]
    models: Vec<OllamaTag>,
}

#[derive(Deserialize)]
struct OllamaTag {
    #[serde(default)]
    name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_url_allows_loopback_only() {
        assert_eq!(
            normalize_ollama_base_url("").unwrap(),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            normalize_ollama_base_url("http://127.0.0.1:11434/v1").unwrap(),
            "http://127.0.0.1:11434"
        );
        assert!(normalize_ollama_base_url("https://example.com").is_err());
        assert!(normalize_ollama_base_url("http://192.168.1.5:11434").is_err());
    }

    #[test]
    fn ollama_url_rejects_remote_authorities_with_loopback_prefixes() {
        for url in [
            "http://127.0.0.1:11434@example.com",
            "https://localhost@example.com/v1",
            "http://127.0.0.1.evil.example",
            "http://localhost.evil.example:11434",
            "http://[::2]:11434",
            "http://[::ffff:127.0.0.1]:11434",
        ] {
            assert!(
                normalize_ollama_base_url(url).is_err(),
                "remote URL was accepted: {url}"
            );
        }
    }
}
