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

/** One-shot working directory override for re-run from recent runs. */
export function resolveExecutionWorkDirWithOverride(
  activeTab: EditorTab,
  stateWorkingDir: string,
  settings: Pick<
    AppSettings,
    "workingDirMode" | "customWorkingDir" | "pinnedRunDir"
  >,
  platformHomeFallback: () => string,
  workingDirOverride?: string,
): string {
  const trimmed = workingDirOverride?.trim();
  if (trimmed) return trimmed;
  return resolveExecutionWorkDir(
    activeTab,
    stateWorkingDir,
    settings.workingDirMode,
    settings.customWorkingDir,
    settings.pinnedRunDir,
    platformHomeFallback,
  );
}
