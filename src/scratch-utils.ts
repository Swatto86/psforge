/** Helpers for PSForge scratch auto-save paths (`%APPDATA%/PSForge/scratch`). */

import type { EditorTab } from "./types";

/** Build the on-disk path for an untitled tab's scratch file. */
export function scratchPathForTab(scratchDir: string, tabId: string): string {
  const sep = scratchDir.includes("\\") ? "\\" : "/";
  return `${scratchDir.replace(/[/\\]+$/, "")}${sep}${tabId}.ps1`;
}

/** True when the tab's backing path lives under the scratch directory. */
export function isScratchBackedTab(tab: EditorTab, scratchDir: string): boolean {
  if (!tab.filePath || !scratchDir) return false;
  const normalizedScratch = scratchDir
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  const normalizedPath = tab.filePath.replace(/\\/g, "/").toLowerCase();
  return normalizedPath.startsWith(`${normalizedScratch}/`);
}

/** Untitled buffer with no user-chosen save path (may still have scratch auto-save). */
export function isUntitledScratchCandidate(tab: EditorTab): boolean {
  return tab.tabType !== "welcome" && !tab.filePath;
}
