/** PowerShell script extensions shown in welcome/recent lists. */
export const PS_SCRIPT_EXTENSIONS = [".ps1", ".psm1", ".psd1"] as const;

export function isPowerShellScriptPath(path: string): boolean {
  const lower = path.toLowerCase();
  return PS_SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isWindowsRuntime(): boolean {
  return typeof navigator !== "undefined" && /win/i.test(navigator.platform);
}

function recentPathKey(path: string, isWindows = isWindowsRuntime()): string {
  const trimmed = path.trim();
  return isWindows ? trimmed.replace(/\\/g, "/").toLowerCase() : trimmed;
}

export function mergeRecentFilePaths(
  existing: string[],
  added: string[],
  maxRecent: number,
  isWindows = isWindowsRuntime(),
): string[] {
  const cap = Number.isFinite(maxRecent)
    ? Math.max(0, Math.floor(maxRecent))
    : 0;
  if (cap === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of [...added, ...existing]) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const key = recentPathKey(trimmed, isWindows);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

export function removeRecentFilePath(
  existing: string[],
  path: string,
  isWindows = isWindowsRuntime(),
): string[] {
  const key = recentPathKey(path, isWindows);
  return existing.filter((item) => recentPathKey(item, isWindows) !== key);
}

/** True when the script declares a top-level param() block (ignoring leading comments). */
export function hasScriptLevelParamBlock(content: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return /^param\s*\(/i.test(trimmed);
  }
  return false;
}
