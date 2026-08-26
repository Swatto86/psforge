import type { Terminal } from "@xterm/xterm";

/**
 * Wipe viewport + scrollback so a restarted shell paints on a blank canvas.
 * Prefer reset over clear(): clear() keeps the current prompt line as row 0,
 * which leaves the old prompt above the new session.
 */
export function wipeTerminalDisplay(term: Terminal): void {
  term.reset();
}
