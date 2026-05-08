/**
 * Path-keyed bookmark / breakpoint persistence.
 *
 * Bookmarks and breakpoints in the React store are keyed by tab id, which
 * is fine for the active session but does not survive close-and-reopen of
 * a file-backed tab — the new tab is assigned a fresh id, leaving its
 * markers orphaned. This module mirrors markers for *file-backed* tabs into
 * a parallel store keyed by absolute file path so they reattach the next
 * time the user opens the same file (within or across sessions).
 *
 * Storage: a single localStorage key. The data is small (a few hundred
 * line numbers per file at most) so the quota concerns that motivate
 * trimming in the session snapshot don't apply here.
 *
 * Path matching is case-sensitive on Linux/macOS (where the filesystem is
 * case-sensitive) and case-insensitive on Windows. Without this, `C:\foo.ps1`
 * and `c:\foo.ps1` — two ways the same file can arrive into the app
 * (Explorer-launch vs. user-typed path) — would each get their own marker
 * set and the user would see disappearing bookmarks.
 */

import type { DebugBreakpoint } from "./types";

const STORAGE_KEY = "psforge.path-state.v1";

interface PathState {
  bookmarks: Record<string, number[]>;
  breakpoints: Record<string, DebugBreakpoint[]>;
}

const EMPTY_STATE: PathState = { bookmarks: {}, breakpoints: {} };

let cached: PathState | null = null;

function isWindowsRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  return /win/i.test(navigator.platform);
}

/**
 * Returns the lookup key for `filePath`. Lower-cases on Windows so the same
 * file accessed through differently-cased paths shares one marker set.
 */
export function pathKey(filePath: string): string {
  if (!filePath) return "";
  return isWindowsRuntime() ? filePath.toLowerCase() : filePath;
}

function load(): PathState {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = { bookmarks: {}, breakpoints: {} };
      return cached;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      cached = { bookmarks: {}, breakpoints: {} };
      return cached;
    }
    const rec = parsed as Partial<PathState>;
    cached = {
      bookmarks:
        rec.bookmarks && typeof rec.bookmarks === "object"
          ? sanitizeBookmarks(rec.bookmarks)
          : {},
      breakpoints:
        rec.breakpoints && typeof rec.breakpoints === "object"
          ? sanitizeBreakpoints(rec.breakpoints)
          : {},
    };
    return cached;
  } catch {
    cached = { bookmarks: {}, breakpoints: {} };
    return cached;
  }
}

function sanitizeBookmarks(
  raw: Record<string, unknown>,
): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !Array.isArray(value)) continue;
    const lines = value
      .filter(
        (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1,
      )
      .sort((a, b) => a - b);
    if (lines.length > 0) result[key] = Array.from(new Set(lines));
  }
  return result;
}

function sanitizeBreakpoints(
  raw: Record<string, unknown>,
): Record<string, DebugBreakpoint[]> {
  const result: Record<string, DebugBreakpoint[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !Array.isArray(value)) continue;
    const breakpoints = value
      .map((bp) => normalizeBreakpoint(bp))
      .filter((bp): bp is DebugBreakpoint => bp !== null);
    if (breakpoints.length > 0) result[key] = breakpoints;
  }
  return result;
}

function normalizeBreakpoint(value: unknown): DebugBreakpoint | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const line =
    typeof rec.line === "number" && Number.isInteger(rec.line) && rec.line >= 1
      ? rec.line
      : undefined;
  const variableRaw =
    typeof rec.variable === "string"
      ? rec.variable.trim().replace(/^\$/, "")
      : "";
  const variable = variableRaw.length > 0 ? variableRaw : undefined;
  const targetCommandRaw =
    typeof rec.targetCommand === "string" ? rec.targetCommand.trim() : "";
  const targetCommand =
    targetCommandRaw.length > 0 ? targetCommandRaw : undefined;
  if (
    line === undefined &&
    variable === undefined &&
    targetCommand === undefined
  ) {
    return null;
  }
  const condition =
    typeof rec.condition === "string" && rec.condition.trim()
      ? rec.condition.trim()
      : undefined;
  const command =
    typeof rec.command === "string" && rec.command.trim()
      ? rec.command.trim()
      : undefined;
  const hitCount =
    typeof rec.hitCount === "number" &&
    Number.isInteger(rec.hitCount) &&
    rec.hitCount >= 1
      ? rec.hitCount
      : undefined;
  const mode =
    rec.mode === "Read" || rec.mode === "Write"
      ? rec.mode
      : variable
        ? "ReadWrite"
        : undefined;
  return { line, variable, targetCommand, mode, condition, hitCount, command };
}

function persist(state: PathState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / private mode failures here are non-fatal: bookmarks degrade to
    // session-scoped, which matches the pre-fix behaviour.
  }
}

/** Returns the saved bookmarks for `filePath`, or undefined if none. */
export function getBookmarksForPath(filePath: string): number[] | undefined {
  if (!filePath) return undefined;
  const state = load();
  const key = pathKey(filePath);
  const stored = state.bookmarks[key];
  return stored && stored.length > 0 ? [...stored] : undefined;
}

/** Returns the saved breakpoints for `filePath`, or undefined if none. */
export function getBreakpointsForPath(
  filePath: string,
): DebugBreakpoint[] | undefined {
  if (!filePath) return undefined;
  const state = load();
  const key = pathKey(filePath);
  const stored = state.breakpoints[key];
  return stored && stored.length > 0 ? stored.map((bp) => ({ ...bp })) : undefined;
}

/** Writes the current bookmark list for `filePath`. Empty list deletes the entry. */
export function setBookmarksForPath(
  filePath: string,
  lines: number[],
): void {
  if (!filePath) return;
  const state = load();
  const key = pathKey(filePath);
  if (lines.length === 0) {
    if (!(key in state.bookmarks)) return;
    delete state.bookmarks[key];
  } else {
    state.bookmarks[key] = [...lines].sort((a, b) => a - b);
  }
  persist(state);
}

/** Writes the current breakpoint list for `filePath`. Empty list deletes the entry. */
export function setBreakpointsForPath(
  filePath: string,
  breakpoints: DebugBreakpoint[],
): void {
  if (!filePath) return;
  const state = load();
  const key = pathKey(filePath);
  if (breakpoints.length === 0) {
    if (!(key in state.breakpoints)) return;
    delete state.breakpoints[key];
  } else {
    state.breakpoints[key] = breakpoints.map((bp) => ({ ...bp }));
  }
  persist(state);
}
