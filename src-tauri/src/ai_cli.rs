//! Shared AI CLI process helpers (spawn, timeout, profile env, path cleanup).
use crate::errors::AppError;
use crate::utils::char_preview;
#[cfg(not(windows))]
use crate::win_compat::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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

/// Per-request path under the system temp directory. The sequence number keeps
/// concurrent requests in one process from sharing, and then deleting, each
/// other's workspace or output file.
pub(crate) fn unique_temp_path(prefix: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{}-{seq}", std::process::id()))
}

/// Windows profile an AI CLI is installed under: the configured profile, else
/// the current user's own profile, else another profile on the machine (an
/// elevated PSForge running as an admin account can still use the signed-in
/// user's install). The current user always wins over another account.
pub(crate) fn resolve_cli_profile(
    configured: Option<&str>,
    has_install: impl Fn(&Path) -> bool,
) -> Option<String> {
    resolve_cli_profile_in(
        configured,
        dirs::home_dir(),
        Path::new("C:\\Users"),
        has_install,
    )
}

fn resolve_cli_profile_in(
    configured: Option<&str>,
    current: Option<PathBuf>,
    users_root: &Path,
    has_install: impl Fn(&Path) -> bool,
) -> Option<String> {
    if let Some(value) = configured {
        return Some(normalize_configured_path(value));
    }
    if let Some(home) = current.filter(|home| has_install(home)) {
        return Some(home.to_string_lossy().into_owned());
    }
    let mut profiles: Vec<PathBuf> = std::fs::read_dir(users_root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|dir| has_install(dir))
        .collect();
    profiles.sort();
    profiles
        .into_iter()
        .next()
        .map(|dir| dir.to_string_lossy().into_owned())
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
    fn cli_profile_prefers_current_user_over_other_accounts() {
        let root = unique_temp_path("psforge-profile-test");
        let other = root.join("aaa-other");
        let me = root.join("zzz-me");
        for dir in [&other, &me] {
            std::fs::create_dir_all(dir.join(".codex")).unwrap();
        }
        let has_install = |dir: &Path| dir.join(".codex").is_dir();
        let found = resolve_cli_profile_in(None, Some(me.clone()), &root, has_install);
        let fallback =
            resolve_cli_profile_in(None, Some(root.join("no-install")), &root, has_install);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(found.as_deref(), Some(me.to_string_lossy().as_ref()));
        assert_eq!(fallback.as_deref(), Some(other.to_string_lossy().as_ref()));
    }

    #[test]
    fn cli_profile_uses_configured_value_first() {
        let found = resolve_cli_profile_in(
            Some(r#""D:\Profiles\me""#),
            None,
            Path::new("Z:\\missing"),
            |_| true,
        );
        assert_eq!(found.as_deref(), Some(r"D:\Profiles\me"));
    }

    #[test]
    fn unique_temp_paths_differ_within_one_process() {
        assert_ne!(unique_temp_path("psforge-x"), unique_temp_path("psforge-x"));
    }

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
