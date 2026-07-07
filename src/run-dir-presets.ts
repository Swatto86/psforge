import type { AppSettings } from "./types";

/** Apply a named preset: pins working directory and switches mode to pinned. */
export function applyRunDirPreset(
  settings: AppSettings,
  presetName: string,
): AppSettings {
  const preset = (settings.runDirPresets ?? []).find((p) => p.name === presetName);
  if (!preset?.path.trim()) return settings;
  return {
    ...settings,
    workingDirMode: "pinned",
    pinnedRunDir: preset.path.trim(),
  };
}
