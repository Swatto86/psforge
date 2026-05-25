/** Per-project runner overrides from `.psforge.json` beside scripts. */

import { readFileContent } from "./commands";
import { dirname, joinPath } from "./path-utils";
import type { AppSettings } from "./types";

const CONFIG_FILENAME = ".psforge.json";

export interface ProjectConfig {
  workingDirMode?: AppSettings["workingDirMode"];
  customWorkingDir?: string;
  pinnedRunDir?: string;
  pssaRunGate?: AppSettings["pssaRunGate"];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseProjectConfig(raw: string): ProjectConfig | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    const config: ProjectConfig = {};
    const mode = parsed.workingDirMode;
    if (mode === "file" || mode === "custom" || mode === "pinned") {
      config.workingDirMode = mode;
    }
    if (typeof parsed.customWorkingDir === "string") {
      config.customWorkingDir = parsed.customWorkingDir;
    }
    if (typeof parsed.pinnedRunDir === "string") {
      config.pinnedRunDir = parsed.pinnedRunDir;
    }
    const gate = parsed.pssaRunGate;
    if (gate === "off" || gate === "warn" || gate === "block") {
      config.pssaRunGate = gate;
    }
    return config;
  } catch {
    return null;
  }
}

/** Walk upward from `startPath` looking for `.psforge.json`. */
export async function findProjectConfig(
  startPath: string,
): Promise<{ configPath: string; config: ProjectConfig } | null> {
  if (!startPath.trim()) return null;

  let dir = dirname(startPath).replace(/\\/g, "/");
  const root = dir.startsWith("/") ? "/" : dir.match(/^[A-Za-z]:/)?.[0] ?? "";

  for (let depth = 0; depth < 32 && dir; depth++) {
    const candidate = joinPath(dir, CONFIG_FILENAME);
    try {
      const file = await readFileContent(candidate);
      const config = parseProjectConfig(file.content);
      if (config) return { configPath: candidate, config };
    } catch {
      // not found — keep walking up
    }

    if (dir === root || !dir.includes("/")) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** Merge project overrides into app settings (non-destructive for unrelated fields). */
export function applyProjectConfig(
  settings: AppSettings,
  config: ProjectConfig,
): AppSettings {
  const next = { ...settings };
  if (config.workingDirMode) next.workingDirMode = config.workingDirMode;
  if (config.customWorkingDir !== undefined) {
    next.customWorkingDir = config.customWorkingDir;
  }
  if (config.pinnedRunDir !== undefined) {
    next.pinnedRunDir = config.pinnedRunDir;
  }
  if (config.pssaRunGate) next.pssaRunGate = config.pssaRunGate;
  return next;
}
