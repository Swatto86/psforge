//! Bounded, lossy PowerShell output decoding and completion-marker forwarding.
use crate::powershell::{
    chrono_now, parse_run_complete_marker, parse_run_complete_stderr_marker, OutputLine,
    SessionEvent, MAX_OUTPUT_LINES, MAX_OUTPUT_LINE_BYTES, RUN_COMPLETE_MARKER_PREFIX,
    RUN_COMPLETE_STDERR_MARKER_PREFIX,
};
use log::{debug, warn};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex};

const MARKER_TAIL_BYTES: usize = 512;

pub(crate) fn spawn(
    stream: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    stream_name: &'static str,
    tx: mpsc::UnboundedSender<SessionEvent>,
    output_budget: Arc<AtomicUsize>,
    output_budget_warned: Arc<AtomicBool>,
    active_command: Arc<Mutex<Option<String>>>,
) {
    tokio::spawn(async move {
        let mut reader = stream;
        let mut read_buffer = [0_u8; 8192];
        let mut line = LineBuffer::default();
        loop {
            let read = match reader.read(&mut read_buffer).await {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    debug!("{} reader I/O error: {}", stream_name, error);
                    return;
                }
            };
            for segment in read_buffer[..read].split_inclusive(|byte| *byte == b'\n') {
                let terminated = segment.ends_with(b"\n");
                let content = segment.strip_suffix(b"\n").unwrap_or(segment);
                line.push(content, terminated);
                if terminated {
                    for text in line.take_line() {
                        forward(
                            text,
                            stream_name,
                            &tx,
                            &output_budget,
                            &output_budget_warned,
                            &active_command,
                        )
                        .await;
                    }
                }
            }
        }
        for text in line.finish() {
            forward(
                text,
                stream_name,
                &tx,
                &output_budget,
                &output_budget_warned,
                &active_command,
            )
            .await;
        }
    });
}

#[derive(Default)]
struct LineBuffer {
    head: Vec<u8>,
    overflow_tail: VecDeque<u8>,
    has_content: bool,
}

impl LineBuffer {
    fn push(&mut self, content: &[u8], terminated: bool) {
        self.has_content |= !content.is_empty() || terminated;
        let retained = content
            .len()
            .min(MAX_OUTPUT_LINE_BYTES.saturating_sub(self.head.len()));
        self.head.extend_from_slice(&content[..retained]);
        for byte in &content[retained..] {
            if self.overflow_tail.len() == MARKER_TAIL_BYTES {
                self.overflow_tail.pop_front();
            }
            self.overflow_tail.push_back(*byte);
        }
    }

    fn take_line(&mut self) -> Vec<String> {
        self.has_content = false;
        let overflow: Vec<u8> = self.overflow_tail.drain(..).collect();
        let mut head = std::mem::take(&mut self.head);
        if overflow.is_empty() {
            if let Some(last) = head.last_mut() {
                if *last == b'\r' {
                    head.pop();
                }
            }
            return segments(&String::from_utf8_lossy(&head));
        }

        let head_text = String::from_utf8_lossy(&head).into_owned();
        let boundary_start = head.len().saturating_sub(MARKER_TAIL_BYTES);
        let mut boundary = head[boundary_start..].to_vec();
        boundary.extend_from_slice(&overflow);
        let boundary_text = String::from_utf8_lossy(&boundary);
        let mut output = Vec::new();
        if !head_text.is_empty() {
            output.push(head_text);
        }
        if let Some((_, marker)) = split_marker(&boundary_text) {
            output.push(marker.to_string());
        }
        output
    }

    fn finish(&mut self) -> Vec<String> {
        if !self.has_content {
            return Vec::new();
        }
        self.take_line()
    }
}

fn split_marker(line: &str) -> Option<(&str, &str)> {
    let end = line.trim_end().len();
    let trimmed = &line[..end];
    let start = [
        RUN_COMPLETE_MARKER_PREFIX,
        RUN_COMPLETE_STDERR_MARKER_PREFIX,
    ]
    .into_iter()
    .filter_map(|prefix| trimmed.find(prefix))
    .min()?;
    let marker = &trimmed[start..];
    if !marker.ends_with(">>") {
        return None;
    }
    let prefix = line[..start].trim_end_matches('\r');
    Some((prefix, marker))
}

fn segments(line: &str) -> Vec<String> {
    match split_marker(line) {
        Some((prefix, marker)) => {
            let mut output = Vec::new();
            if !prefix.is_empty() {
                output.push(prefix.to_string());
            }
            output.push(marker.to_string());
            output
        }
        None => vec![line.trim_end_matches('\r').to_string()],
    }
}

async fn forward(
    line: String,
    stream_name: &'static str,
    tx: &mpsc::UnboundedSender<SessionEvent>,
    output_budget: &AtomicUsize,
    output_budget_warned: &AtomicBool,
    active_command: &Mutex<Option<String>>,
) {
    let keep = consume_output_budget(output_budget)
        || is_active_completion_marker(&line, active_command).await;
    if keep {
        send(line, stream_name, tx);
    } else if !output_budget_warned.swap(true, Ordering::Relaxed) {
        warn!(
            "Output line limit reached ({}); dropping additional lines for current command",
            MAX_OUTPUT_LINES
        );
        send(
            format!(
                "[PSForge] Output truncated after {} lines; \
                 subsequent script output is being dropped to keep the UI responsive.",
                MAX_OUTPUT_LINES
            ),
            "stderr",
            tx,
        );
    }
}

fn send(line: String, stream_name: &'static str, tx: &mpsc::UnboundedSender<SessionEvent>) {
    let _ = tx.send(SessionEvent::Output(OutputLine {
        stream: stream_name.to_string(),
        text: line,
        timestamp: chrono_now(),
    }));
}

fn consume_output_budget(budget: &AtomicUsize) -> bool {
    let mut current = budget.load(Ordering::Relaxed);
    loop {
        if current == 0 {
            return false;
        }
        match budget.compare_exchange_weak(
            current,
            current - 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return true,
            Err(next) => current = next,
        }
    }
}

async fn is_active_completion_marker(line: &str, active_command: &Mutex<Option<String>>) -> bool {
    let marker_id = match parse_run_complete_marker(line) {
        Some((id, _)) => id,
        None => match parse_run_complete_stderr_marker(line) {
            Some(id) => id,
            None => return false,
        },
    };
    active_command.lock().await.as_deref() == Some(marker_id.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn collect(input: Vec<u8>) -> Vec<OutputLine> {
        let (reader, mut writer) = tokio::io::duplex(64);
        let (tx, mut rx) = mpsc::unbounded_channel();
        spawn(
            reader,
            "stdout",
            tx,
            Arc::new(AtomicUsize::new(MAX_OUTPUT_LINES)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(Some("run-1".to_string()))),
        );
        let writer_task = tokio::spawn(async move {
            let _ = tokio::io::AsyncWriteExt::write_all(&mut writer, &input).await;
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut writer).await;
        });
        let output = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut output = Vec::new();
            while let Some(event) = rx.recv().await {
                if let SessionEvent::Output(line) = event {
                    output.push(line);
                }
            }
            output
        })
        .await
        .expect("reader must drain the stream and terminate at EOF");
        writer_task.await.expect("writer task");
        output
    }

    fn texts(output: &[OutputLine]) -> Vec<&str> {
        output.iter().map(|line| line.text.as_str()).collect()
    }

    #[tokio::test]
    async fn decodes_invalid_utf8_and_keeps_reading_later_runs() {
        let output = collect(
            b"bad\xFFbytes\n<<PSFORGE_DONE|run-1|0>>\nnext run\n<<PSFORGE_DONE|run-2|0>>\n"
                .to_vec(),
        )
        .await;
        assert_eq!(
            texts(&output),
            vec![
                "bad\u{FFFD}bytes",
                "<<PSFORGE_DONE|run-1|0>>",
                "next run",
                "<<PSFORGE_DONE|run-2|0>>",
            ]
        );
    }

    #[tokio::test]
    async fn separates_no_newline_output_from_the_completion_marker() {
        let output = collect(b"unterminated<<PSFORGE_DONE|run-1|0>>".to_vec()).await;
        assert_eq!(
            texts(&output),
            vec!["unterminated", "<<PSFORGE_DONE|run-1|0>>"]
        );
    }

    #[tokio::test]
    async fn caps_an_unterminated_line_and_still_detects_done() {
        let mut input = vec![b'x'; MAX_OUTPUT_LINE_BYTES + 17];
        input.extend_from_slice(b"<<PSFORGE_DONE|run-1|0>>");
        let output = collect(input).await;
        assert_eq!(output.len(), 2);
        assert_eq!(output[0].text.len(), MAX_OUTPUT_LINE_BYTES);
        assert_eq!(output[1].text, "<<PSFORGE_DONE|run-1|0>>");
    }
}
