//! Shared AI CLI process helpers (spawn, timeout, profile env, path cleanup).
use crate::errors::AppError;
use crate::utils::char_preview;
#[cfg(not(windows))]
use crate::win_compat::CommandExt;

pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub(crate) const CLI_TIMEOUT_SECS: u64 = 300;
const CLI_OUTPUT_CAP: usize = 16 * 1024 * 1024;

pub(crate) fn cli_error(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.to_string(),
        message: message.into(),
    }
}

pub(crate) fn effort_variant(effort: &str) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" | "max" => Some("high"),
        _ => None,
    }
}

pub(crate) fn blank_as_none(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains("YourName") {
        None
    } else {
        Some(trimmed)
    }
}

pub(crate) fn normalize_configured_path(value: &str) -> String {
    value
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string()
}

pub(crate) fn apply_user_profile_env(
    cmd: &mut tokio::process::Command,
    user_profile: Option<&str>,
    set_home: bool,
) {
    if let Some(profile) = user_profile {
        let appdata = format!("{profile}\\AppData\\Roaming");
        let localappdata = format!("{profile}\\AppData\\Local");
        let homepath = profile.strip_prefix("C:").unwrap_or(profile);
        cmd.env("USERPROFILE", profile)
            .env("HOMEPATH", homepath)
            .env("HOMEDRIVE", "C:")
            .env("APPDATA", appdata)
            .env("LOCALAPPDATA", localappdata);
        if set_home {
            cmd.env("HOME", profile);
        }
    }
}

pub(crate) fn attach_cli_stdio(cmd: &mut tokio::process::Command) {
    cmd.kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
}

pub(crate) async fn wait_capped(
    mut child: tokio::process::Child,
    stdin_payload: Vec<u8>,
) -> Result<(std::process::ExitStatus, String, String), AppError> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    let write_fut = async move {
        if let Some(mut stdin) = stdin {
            use tokio::io::AsyncWriteExt as _;
            let _ = stdin.write_all(&stdin_payload).await;
        }
    };
    let combined = async {
        let (out, err, status, _) = tokio::join!(
            read_stream_capped(stdout),
            read_stream_capped(stderr),
            child.wait(),
            write_fut
        );
        (out, err, status)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(CLI_TIMEOUT_SECS), combined).await {
        Ok((out, err, status)) => Ok((
            status.map_err(|e| cli_error("AI_CLI_FAILED", e.to_string()))?,
            String::from_utf8_lossy(&out).into_owned(),
            String::from_utf8_lossy(&err).into_owned(),
        )),
        Err(_) => {
            let _ = child.start_kill();
            Err(cli_error(
                "AI_CLI_TIMEOUT",
                format!("AI CLI timed out after {CLI_TIMEOUT_SECS}s"),
            ))
        }
    }
}

async fn read_stream_capped<R: tokio::io::AsyncRead + Unpin>(stream: Option<R>) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut out = Vec::new();
    let Some(mut stream) = stream else {
        return out;
    };
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() < CLI_OUTPUT_CAP {
                    let take = n.min(CLI_OUTPUT_CAP - out.len());
                    out.extend_from_slice(&chunk[..take]);
                }
            }
        }
    }
    out
}

pub(crate) fn preview_cli_error(stderr: &str) -> String {
    char_preview(stderr.trim(), 2000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_variant_maps_known_values() {
        assert_eq!(effort_variant("low"), Some("low"));
        assert_eq!(effort_variant("HIGH"), Some("high"));
        assert_eq!(effort_variant("xhigh"), Some("high"));
        assert!(effort_variant("").is_none());
    }

    #[test]
    fn configured_paths_drop_copied_quotes() {
        assert_eq!(
            normalize_configured_path(r#""C:\Tools\opencode.exe""#),
            r"C:\Tools\opencode.exe"
        );
        assert!(blank_as_none("YourName").is_none());
        assert_eq!(blank_as_none("C:\\Users\\Ada"), Some(r"C:\Users\Ada"));
    }
}
