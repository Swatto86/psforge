import type { AppSettings, RunDirPreset } from "./types";

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

export function normalizeRunDirPresets(presets: RunDirPreset[]): RunDirPreset[] {
  const seen = new Set<string>();
  const out: RunDirPreset[] = [];
  for (const preset of presets) {
    const name = preset.name.trim();
    const path = preset.path.trim();
    if (!name || !path) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, path });
  }
  return out.slice(0, 12);
}
