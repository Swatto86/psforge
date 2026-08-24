/**
 * VS Code-style terminal run: invoke a saved script in the current session
 * (`Set-Location`; `& 'path.ps1'`), not a fresh -NoProfile child.
 */

import type { EditorTab } from "./types";
import { isScratchBackedTab } from "./scratch-utils";

/** True when F5 should `&` the file in the open console (not a temp wrapper). */
export function isSavedDiskScript(
  tab: EditorTab,
  scriptPath: string,
  scratchDir: string,
): boolean {
  if (!scriptPath.trim()) return false;
  if (!scratchDir) return true;
  return !isScratchBackedTab({ ...tab, filePath: scriptPath }, scratchDir);
}

/** PowerShell single-quoted literal, with `'` doubled. */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildDirectTerminalRunCommand(options: {
  scriptPath: string;
  workingDir: string;
  executionPolicy: string;
  scriptArgs?: readonly string[];
}): string {
  const parts: string[] = [];
  const policy = options.executionPolicy.trim();
  if (policy && policy !== "Default") {
    parts.push(
      `Set-ExecutionPolicy -Scope Process -ExecutionPolicy ${psSingleQuote(policy)} -Force`,
    );
  }
  const workDir = options.workingDir.trim();
  if (workDir) {
    parts.push(`Set-Location -LiteralPath ${psSingleQuote(workDir)}`);
  }
  let invoke = `& ${psSingleQuote(options.scriptPath)}`;
  const args = options.scriptArgs ?? [];
  if (args.length > 0) {
    invoke += ` ${args.map(psSingleQuote).join(" ")}`;
  }
  parts.push(invoke);
  return parts.join("; ");
}
