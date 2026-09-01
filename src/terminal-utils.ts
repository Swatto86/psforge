/** Strip ANSI escape sequences from integrated terminal buffer text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** Selected text in the active integrated terminal ("" if none). */
export function getTerminalSelection(): string {
  const w = window as unknown as Record<string, unknown>;
  const getSelection = w.__psforge_terminal_get_selection as
    | (() => string)
    | undefined;
  return getSelection?.() ?? "";
}

/** Copy the active terminal selection. Returns false when nothing is selected. */
export async function copyTerminalSelectionToClipboard(): Promise<boolean> {
  const text = getTerminalSelection();
  if (!text) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

/** Read plain-text terminal scrollback from the integrated terminal bridge. */
export function getTerminalPlainContent(lineCount?: number): string {
  const w = window as unknown as Record<string, unknown>;
  const getContent = w.__psforge_terminal_get_content as
    | ((count?: number) => string)
    | undefined;
  return stripAnsi(getContent?.(lineCount) ?? "");
}

export async function copyTerminalOutputToClipboard(
  lineCount?: number,
): Promise<boolean> {
  const text = getTerminalPlainContent(lineCount);
  if (!text.trim()) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

/** Read plain-text content from the console tab that ran the last script.
 *  Falls back to the active tab only when no run has happened yet; returns ""
 *  when the run's tab has been closed (its output is gone — silently reading
 *  a different terminal would be wrong, S6-20). */
export function getRunTerminalPlainContent(lineCount?: number): string {
  const w = window as unknown as Record<string, unknown>;
  const getContent = w.__psforge_terminal_get_run_content as
    | ((count?: number) => string)
    | undefined;
  return stripAnsi(getContent?.(lineCount) ?? "");
}

/**
 * Number of output lines since the last run started, tracked by a
 * reflow/eviction-safe xterm marker in session-readers.ts (S3-13). Returns null
 * no run has started or the baseline row was evicted from scrollback.
 */
export function getRunOutputLineCount(): number | null {
  const w = window as unknown as Record<string, unknown>;
  const getCount = w.__psforge_terminal_get_run_output_line_count as
    | (() => number | null)
    | undefined;
  return getCount?.() ?? null;
}

export function getRunScriptOutput(): string | null {
  const w = window as unknown as Record<string, unknown>;
  const getOutput = w.__psforge_terminal_get_run_script_output as
    | (() => string | null)
    | undefined;
  return getOutput?.() ?? null;
}

export async function copyLastRunOutputToClipboard(): Promise<boolean> {
  const scriptOutput = getRunScriptOutput();
  if (scriptOutput !== null) {
    if (!scriptOutput.trim()) return false;
    await navigator.clipboard.writeText(scriptOutput);
    return true;
  }

  const count = getRunOutputLineCount();
  // count === 0 means the last run produced no output — copy nothing rather
  // than dumping the whole prior scrollback. Only a null baseline (no run yet,
  // or the run-start row was evicted) falls back to the full scrollback —
  // still read from the tab that ran the script, not the active one (S6-20).
  if (count === 0) return false;
  const text =
    count !== null
      ? getRunTerminalPlainContent(count)
      : getRunTerminalPlainContent();
  if (!text.trim()) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

/** Floor PTY dims so PowerShell RawUI does not warn on short panes. */
export const MIN_PTY_ROWS = 5;
export const MIN_PTY_COLS = 1;

export function clampPtyDims(
  cols: number,
  rows: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(cols || 120, MIN_PTY_COLS),
    rows: Math.max(rows || 30, MIN_PTY_ROWS),
  };
}

/**
 * PTY size for a console that is starting up.
 *
 * xterm.js falls back to its own 2x1 floor while the host element has no
 * layout, and on WebKitGTK the console mounts before the pane's flex layout
 * resolves. Spawning PowerShell against a 2-column window wraps the prompt
 * into unreadable fragments that survive the later resize, so ignore the
 * measurement until the pane has a real size; the ResizeObserver resizes the
 * PTY as soon as it does.
 */
export function startupPtyDims(
  paneIsLaidOut: boolean,
  cols: number,
  rows: number,
): { cols: number; rows: number } {
  if (!paneIsLaidOut) return clampPtyDims(0, 0);
  return clampPtyDims(cols, rows);
}

/**
 * Publish imperative terminal entry points on `window` and return their
 * teardown. Install and teardown share one key list, so a new entry can no
 * longer be added without also being removed on unmount.
 */
export function installWindowBridge(
  entries: Record<string, unknown>,
): () => void {
  const w = window as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(entries)) {
    w[key] = value;
  }
  return () => {
    for (const key of Object.keys(entries)) {
      delete w[key];
    }
  };
}
