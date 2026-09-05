/**
 * Buffered writer between the PTY event stream and xterm.js.
 *
 * A busy script can emit far more output in one frame than xterm can paint, so
 * chunks accumulate and are written a frame at a time. Side effects (exit-code
 * markers, missing-command detection) run over each newly buffered slice
 * exactly once, ahead of the write, so they still fire for output that has not
 * been painted yet.
 */

import type { Terminal } from "@xterm/xterm";

/** Bytes handed to xterm per animation frame. */
export const MAX_TERMINAL_WRITE_PER_FRAME = 256 * 1024;

export type OutputPump = {
  /** Buffer PTY output and schedule a write. */
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
  let sideEffectOffset = 0;
  let rafId: number | null = null;

  const runSideEffects = () => {
    if (sideEffectOffset >= pending.length) return;
    onSideEffects(pending.slice(sideEffectOffset));
    sideEffectOffset = pending.length;
  };

  const flush = () => {
    rafId = null;
    if (!pending) return;
    runSideEffects();

    const writeLength = Math.min(pending.length, MAX_TERMINAL_WRITE_PER_FRAME);
    term.write(pending.slice(0, writeLength));
    if (writeLength < pending.length) {
      pending = pending.slice(writeLength);
      sideEffectOffset -= writeLength;
      rafId = requestAnimationFrame(flush);
      return;
    }
    pending = "";
    sideEffectOffset = 0;
  };

  const cancelScheduledFlush = () => {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  };

  return {
    push: (data: string) => {
      pending += data;
      if (rafId === null) rafId = requestAnimationFrame(flush);
    },
    drain: () => {
      cancelScheduledFlush();
      if (pending) {
        runSideEffects();
        term.write(pending);
      }
      pending = "";
      sideEffectOffset = 0;
    },
    reset: () => {
      cancelScheduledFlush();
      pending = "";
      sideEffectOffset = 0;
    },
  };
}
