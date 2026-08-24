/**
 * VS Code-style terminal run: invoke a saved script in the current session
 * (`Set-Location`; `& 'path.ps1'`), not a fresh -NoProfile child.
 */

import type { EditorTab } from "./types";

/**
 * True when F5 should `&` the file in the open console (not a temp wrapper).
 * Scratch-backed paths count: they are real files on disk, so running them
 * in the live console matches saved-script behaviour (profile, modules, classes).
 */
export function isSavedDiskScript(
  _tab: EditorTab,
  scriptPath: string,
  _scratchDir: string,
): boolean {
  return scriptPath.trim().length > 0;
}

/** PowerShell single-quoted literal, with `'` doubled. */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Format one token for `& path.ps1 …`. Named-parameter tokens (`-Name`,
 * `-Switch:$true`) must stay bare; quoting them turns them into strings and
 * breaks binder matching.
 */
export function formatDirectRunArg(arg: string): string {
  if (/^-[A-Za-z_][\w]*(?::\S*)?$/.test(arg)) {
    return arg;
  }
  return psSingleQuote(arg);
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
    invoke += ` ${args.map(formatDirectRunArg).join(" ")}`;
  }
  parts.push(invoke);
  return parts.join("; ");
}
