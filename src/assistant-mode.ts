import type { AppSettings } from "./types";

/** Recommended settings for AI paste → run → debug loop. */
export const ASSISTANT_MODE_SETTINGS: Pick<
  AppSettings,
  | "sanitizePasteOnPaste"
  | "runAfterPasteCleanFormat"
  | "runAfterSanitizedPaste"
  | "autoSaveOnRun"
  | "clearOutputOnRun"
  | "autoSaveScratchScripts"
  | "pssaRunGate"
  | "enablePssa"
  | "splitPosition"
  | "showDebuggerTools"
> = {
  sanitizePasteOnPaste: true,
  runAfterPasteCleanFormat: true,
  runAfterSanitizedPaste: false,
  autoSaveOnRun: true,
  clearOutputOnRun: true,
  autoSaveScratchScripts: true,
  pssaRunGate: "warn",
  enablePssa: true,
  splitPosition: 28,
  showDebuggerTools: false,
};

export function applyAssistantMode(settings: AppSettings): AppSettings {
  return {
    ...settings,
    ...ASSISTANT_MODE_SETTINGS,
    assistantMode: true,
  };
}

export function clearAssistantModeFlag(settings: AppSettings): AppSettings {
  return { ...settings, assistantMode: false };
}

/** True when persisted flag is set (user enabled assistant mode). */
export function isAssistantModeEnabled(settings: AppSettings): boolean {
  return settings.assistantMode === true;
}
