/// Shared I/O utility functions for PSForge.
/// Provides retry logic for transient I/O failures (Rule 11 - Resilience).
use log::warn;

/// Maximum number of I/O retry attempts for transient failures.
/// Backoff sequence: 50 ms -> 100 ms -> 200 ms, then propagate the error.
pub(crate) const MAX_IO_RETRIES: u32 = 3;

/// Base delay in milliseconds for the first retry backoff interval.
const RETRY_BASE_DELAY_MS: u64 = 50;

/// Executes a fallible I/O closure with capped exponential backoff retry (Rule 11).
///
/// Only retries on genuinely transient error kinds (`WouldBlock`, `TimedOut`, `Interrupted`).
/// Permanent errors (`NotFound`, `PermissionDenied`, etc.) are returned immediately
/// without retrying, since retrying would be pointless and could mask bugs.
///
/// # Arguments
/// * `label` - Diagnostic label emitted in log messages on retry.
/// * `op`    - Closure performing the I/O operation. Called up to `MAX_IO_RETRIES` times.
pub(crate) fn with_retry<T, F>(label: &str, op: F) -> std::io::Result<T>
where
    F: Fn() -> std::io::Result<T>,
{
    let mut delay = RETRY_BASE_DELAY_MS;
    for attempt in 0..MAX_IO_RETRIES {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if is_transient(&e) && attempt + 1 < MAX_IO_RETRIES => {
                warn!(
                    "{}: transient I/O error (attempt {}/{}): {}. Retrying in {}ms...",
                    label,
                    attempt + 1,
                    MAX_IO_RETRIES,
                    e,
                    delay
                );
                std::thread::sleep(std::time::Duration::from_millis(delay));
                delay = delay.saturating_mul(2);
            }
            Err(e) => return Err(e),
        }
    }
    // Safety: the loop body always returns on the last iteration because
    // (attempt + 1 < MAX_IO_RETRIES) is false when attempt == MAX_IO_RETRIES - 1,
    // so the Err arm returns unconditionally.
    unreachable!("retry loop exited unexpectedly")
}

/// Returns `true` for error kinds that indicate a transient condition:
/// file lock contention, resource temporarily busy, or interrupted syscall.
/// Permanent errors (file not found, permission denied, invalid path, etc.) return `false`.
fn is_transient(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[test]
    fn with_retry_succeeds_on_first_attempt() {
        let result: std::io::Result<i32> = with_retry("test", || Ok(42));
        assert_eq!(result.unwrap(), 42);
    }

    /// This test sleeps ~150 ms (50 ms + 100 ms backoff) intentionally.
    /// That is well within the 5x CI timeout margin required by Rule 3.
    #[test]
    fn with_retry_eventually_succeeds_after_transient_errors() {
        // First two calls fail with Interrupted (transient); third succeeds.
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let result: std::io::Result<i32> = with_retry("test", move || {
            let n = attempts_clone.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "interrupted",
                ))
            } else {
                Ok(99)
            }
        });
        assert_eq!(result.unwrap(), 99);
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn with_retry_does_not_retry_permanent_errors() {
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let result: std::io::Result<i32> = with_retry("test", move || {
            attempts_clone.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "not found",
            ))
        });
        assert!(result.is_err());
        // Must have given up immediately -- no retry on a permanent error.
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    /// This test sleeps ~150 ms (50 ms + 100 ms backoff) intentionally.
    /// That is well within the 5x CI timeout margin required by Rule 3.
    #[test]
    fn with_retry_exhausts_all_attempts_for_persistent_transient_error() {
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let result: std::io::Result<i32> = with_retry("test", move || {
            attempts_clone.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "busy"))
        });
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), MAX_IO_RETRIES);
    }

    #[test]
    fn is_transient_classifies_correctly() {
        assert!(is_transient(&std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            ""
        )));
        assert!(is_transient(&std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            ""
        )));
        assert!(is_transient(&std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            ""
        )));
        assert!(!is_transient(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            ""
        )));
        assert!(!is_transient(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            ""
        )));
        assert!(!is_transient(&std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            ""
        )));
    }
}
