/** Helpers for PSForge scratch auto-save paths (`%APPDATA%/PSForge/scratch`). */

import type { EditorTab } from "./types";

function usesWindowsPathSemantics(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) return true;
  if (typeof navigator !== "undefined" && navigator.platform) {
    return /win/i.test(navigator.platform);
  }
  return false;
}

/** Build the on-disk path for an untitled tab's scratch file. */
export function scratchPathForTab(scratchDir: string, tabId: string): string {
  const sep =
    usesWindowsPathSemantics(scratchDir) && scratchDir.includes("\\")
      ? "\\"
      : "/";
  return `${scratchDir.replace(/[/\\]+$/, "")}${sep}${tabId}.ps1`;
}

/** True when the tab's backing path lives under the scratch directory. */
export function isScratchBackedTab(tab: EditorTab, scratchDir: string): boolean {
  if (!tab.filePath || !scratchDir) return false;
  const windows = usesWindowsPathSemantics(scratchDir);
  const normalize = (path: string) => {
    const normalized = windows ? path.replace(/\\/g, "/") : path;
    return windows ? normalized.toLowerCase() : normalized;
  };
  const normalizedScratch = normalize(scratchDir).replace(/\/+$/, "");
  const normalizedPath = normalize(tab.filePath);
  return normalizedPath.startsWith(`${normalizedScratch}/`);
}

/** Untitled buffer with no user-chosen save path (may still have scratch auto-save). */
export function isUntitledScratchCandidate(tab: EditorTab): boolean {
  return tab.tabType !== "welcome" && !tab.filePath;
}

/** Display title for a recovered scratch file (never the UUID backing name). */
export function recoveredScratchTitle(nextUntitled: number): string {
  return `Untitled-${nextUntitled}`;
}

/**
 * After writing `writtenContent` to disk, keep the tab dirty when the live
 * buffer has already moved on. A late save completion must not clear the
 * dirty flag (or a close prompt) for newer unsaved edits.
 */
export function diskWriteTabChanges(
  path: string,
  writtenContent: string,
  liveContent: string | undefined,
): { filePath: string; savedContent: string; isDirty: boolean } | null {
  if (liveContent === undefined) return null;
  return {
    filePath: path,
    savedContent: writtenContent,
    isDirty: liveContent !== writtenContent,
  };
}
