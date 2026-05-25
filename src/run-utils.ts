import type { EditorTab, AppSettings } from "./types";
import { dirname } from "./path-utils";

export type WorkingDirMode = AppSettings["workingDirMode"];

/** Resolve the directory used when F5 runs the active script. */
export function resolveExecutionWorkDir(
  activeTab: EditorTab,
  stateWorkingDir: string,
  workingDirMode: WorkingDirMode,
  customWorkingDir: string,
  pinnedRunDir: string,
  platformHomeFallback: () => string,
): string {
  if (workingDirMode === "pinned" && pinnedRunDir.trim()) {
    return pinnedRunDir.trim();
  }
  if (workingDirMode === "custom" && customWorkingDir.trim()) {
    return customWorkingDir.trim();
  }

  const fileDir = activeTab.filePath ? dirname(activeTab.filePath) : "";

  return stateWorkingDir || fileDir || platformHomeFallback();
}

export function isPssaErrorSeverity(severity: string): boolean {
  return severity === "Error" || severity === "ParseError";
}
