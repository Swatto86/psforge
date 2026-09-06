/**
 * Buffered writer between the PTY event stream and xterm.js.
 *
 * A busy script can emit far more output in one frame than xterm can paint, so
 * chunks accumulate and are written a frame at a time. Side effects (exit-code
 * markers, run capture, missing-command detection) run over each chunk as it
 * arrives, once it is buffered: they see every byte exactly once and never
 * wait on a frame, so a run still completes while the window is hidden and
 * animation frames are paused.
 */

import type { Terminal } from "@xterm/xterm";

/** Bytes handed to xterm per animation frame. */
export const MAX_TERMINAL_WRITE_PER_FRAME = 256 * 1024;

export type OutputPump = {
  /** Process a PTY chunk's side effects, buffer it, and schedule a write. */
  push: (data: string) => void;
  /** Write everything still buffered now — for teardown, not the hot path. */
  drain: () => void;
  /** Drop buffered output and any scheduled write (session restart). */
  reset: () => void;
};

export function createOutputPump(
  term: Terminal,
  onSideEffects: (text: string) => void,
): OutputPump {
  let pending = "";
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;
    if (!pending) return;
    const writeLength = Math.min(pending.length, MAX_TERMINAL_WRITE_PER_FRAME);
    term.write(pending.slice(0, writeLength));
    pending = pending.slice(writeLength);
    if (pending) rafId = requestAnimationFrame(flush);
  };

  const cancelScheduledFlush = () => {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  };

  return {
    push: (data: string) => {
      if (!data) return;
      pending += data;
      if (rafId === null) rafId = requestAnimationFrame(flush);
      onSideEffects(data);
    },
    drain: () => {
      cancelScheduledFlush();
      if (pending) term.write(pending);
      pending = "";
    },
    reset: () => {
      cancelScheduledFlush();
      pending = "";
    },
  };
}
