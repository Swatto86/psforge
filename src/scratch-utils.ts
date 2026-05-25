/** Helpers for PSForge scratch auto-save paths (`%APPDATA%/PSForge/scratch`). */

import type { EditorTab } from "./types";

const SCRATCH_FILE_RE = /^([a-f0-9-]{36})\.ps1$/i;

/** Build the on-disk path for an untitled tab's scratch file. */
export function scratchPathForTab(scratchDir: string, tabId: string): string {
  const sep = scratchDir.includes("\\") ? "\\" : "/";
  return `${scratchDir}${sep}${tabId}.ps1`;
}

/** Extract tab id from a scratch filename, or null when not a scratch file. */
export function tabIdFromScratchFilename(name: string): string | null {
  const match = SCRATCH_FILE_RE.exec(name.trim());
  return match ? match[1] : null;
}

/** True when the tab's backing path lives under the scratch directory. */
export function isScratchBackedTab(tab: EditorTab, scratchDir: string): boolean {
  if (!tab.filePath || !scratchDir) return false;
  const normalizedScratch = scratchDir.replace(/\\/g, "/").toLowerCase();
  const normalizedPath = tab.filePath.replace(/\\/g, "/").toLowerCase();
  return normalizedPath.startsWith(`${normalizedScratch}/`);
}

/** Untitled buffer with no user-chosen save path (may still have scratch auto-save). */
export function isUntitledScratchCandidate(tab: EditorTab): boolean {
  return tab.tabType !== "welcome" && !tab.filePath;
}
