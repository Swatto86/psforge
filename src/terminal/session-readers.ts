/**
 * Reading back what a console has shown: full scrollback, the current
 * selection, and the output of the most recent PSForge-launched run.
 *
 * The run baseline is an xterm marker rather than a buffer index: xterm
 * re-wraps the whole scrollback on resize and trims it at the scrollback cap,
 * so an index goes stale while a marker stays correct and reports itself
 * disposed once its row is evicted (S3-13).
 */

import type { Terminal } from "@xterm/xterm";
import {
  createRunOutputCaptureState,
  feedRunOutputCapture,
  getRunScriptOutputFromState,
  startRunOutputCapture,
  type RunOutputCaptureState,
} from "../run-output-capture";

export type SessionReaders = {
  /** Scrollback as plain text. No count means the whole buffer (S3-4). */
  getContent: (lineCount?: number) => string;
  getSelection: () => string;
  /** Baseline the "last run" output at the current row. */
  markRunStart: (command: string) => void;
  /** Lines since markRunStart, or null when there is no live baseline. */
  getRunOutputLineCount: () => number | null;
  /** stdout/stderr of the last run, prompt and command echo removed. */
  getRunScriptOutput: () => string | null;
  /** Feed PTY output to the run capture. */
  feed: (chunk: string) => void;
};

export function createSessionReaders(term: Terminal): SessionReaders {
  let runStartMarker: ReturnType<Terminal["registerMarker"]> | undefined;
  const capture: RunOutputCaptureState = createRunOutputCaptureState();

  return {
    getContent: (lineCount?: number) => {
      const buf = term.buffer.active;
      const count = lineCount ?? buf.length;
      const lines: string[] = [];
      const start = Math.max(0, buf.length - count);
      for (let i = start; i < buf.length; i++) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines.join("\n");
    },
    getSelection: () => term.getSelection(),
    markRunStart: (command: string) => {
      runStartMarker?.dispose();
      runStartMarker = term.registerMarker() ?? undefined;
      startRunOutputCapture(capture, command);
    },
    getRunOutputLineCount: () => {
      if (
        !runStartMarker ||
        runStartMarker.isDisposed ||
        runStartMarker.line < 0
      ) {
        return null;
      }
      const count = term.buffer.active.length - runStartMarker.line;
      return count > 0 ? count : 0;
    },
    getRunScriptOutput: () => getRunScriptOutputFromState(capture),
    feed: (chunk: string) => feedRunOutputCapture(capture, chunk),
  };
}
