//! Timed execution-policy updates with bounded child lifetime.
use crate::commands::{ps_command, ps_utf8_script};
use crate::errors::AppError;
#[cfg(not(windows))]
use crate::win_compat::CommandExt;

pub(crate) const TIMEOUT_SECS: u64 = 15;

pub(crate) async fn run(
    ps_path: &str,
    script: &str,
    timeout_duration: std::time::Duration,
) -> Result<(), AppError> {
    let mut child = ps_command(ps_path)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(ps_utf8_script(script))
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Failed to set execution policy: {}", e),
        })?;

    let stdout = child.stdout.take().ok_or_else(|| AppError {
        code: "EXEC_POLICY_SET_FAILED".to_string(),
        message: "Failed to capture execution-policy stdout".to_string(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| AppError {
        code: "EXEC_POLICY_SET_FAILED".to_string(),
        message: "Failed to capture execution-policy stderr".to_string(),
    })?;
    let stdout_task = tokio::spawn(async move {
        let mut reader = stdout;
        let mut bytes = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut bytes)
            .await
            .map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut reader = stderr;
        let mut bytes = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut bytes)
            .await
            .map(|_| bytes)
    });

    let status = match tokio::time::timeout(timeout_duration, child.wait()).await {
        Ok(result) => result.map_err(|e| AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Failed while setting execution policy: {}", e),
        })?,
        Err(_) => {
            let kill_error = child.start_kill().err();
            let wait_error = child.wait().await.err();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            if let Some(e) = kill_error.or(wait_error) {
                return Err(AppError {
                    code: "EXEC_POLICY_SET_FAILED".to_string(),
                    message: format!("Failed to stop timed-out execution-policy host: {}", e),
                });
            }
            return Err(AppError {
                code: "EXEC_POLICY_SET_TIMEOUT".to_string(),
                message: format!(
                    "Set-ExecutionPolicy timed out after {}s",
                    timeout_duration.as_secs_f64()
                ),
            });
        }
    };

    let _stdout = stdout_task
        .await
        .map_err(|e| AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Execution-policy stdout task failed: {}", e),
        })?
        .map_err(|e| AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Failed to read execution-policy stdout: {}", e),
        })?;
    let stderr = stderr_task
        .await
        .map_err(|e| AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Execution-policy stderr task failed: {}", e),
        })?
        .map_err(|e| AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!("Failed to read execution-policy stderr: {}", e),
        })?;

    if !status.success() {
        return Err(AppError {
            code: "EXEC_POLICY_SET_FAILED".to_string(),
            message: format!(
                "Set-ExecutionPolicy failed: {}",
                String::from_utf8_lossy(&stderr).trim()
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
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
    async fn timeout_kills_sleeping_fake_host() {
        let Some(pwsh) = test_pwsh() else {
            eprintln!("skip: pwsh not on PATH");
            return;
        };
        let sentinel = std::env::temp_dir().join(format!(
            "psforge_exec_policy_timeout_{}",
            uuid::Uuid::new_v4()
        ));
        let sentinel_ps = sentinel.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Start-Sleep -Milliseconds 1200; [System.IO.File]::WriteAllText('{sentinel_ps}', 'completed')"
        );
        let started = std::time::Instant::now();
        let error = run(
            &pwsh.to_string_lossy(),
            &script,
            std::time::Duration::from_millis(100),
        )
        .await
        .expect_err("sleeping host must time out");
        assert_eq!(error.code, "EXEC_POLICY_SET_TIMEOUT");
        assert!(started.elapsed() < std::time::Duration::from_secs(1));

        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert!(
            !sentinel.exists(),
            "timed-out child continued and wrote its sentinel"
        );
        let _ = std::fs::remove_file(sentinel);
    }
}
