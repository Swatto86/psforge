/**
 * VS Code-style terminal run: invoke a saved script in the current session
 * (`& 'path.ps1'`), not a fresh -NoProfile child. Working-directory and
 * execution-policy setup run as a silent prelude so the echoed command line
 * shows only the script invocation.
 */

export interface DirectTerminalRunCommand {
  /** Echoed command line — script invocation only. */
  command: string;
  /** Working directory applied silently before the command runs. */
  workingDir: string | null;
  /** Process-scoped execution policy applied silently (when not Default). */
  executionPolicy: string | null;
}

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
}): DirectTerminalRunCommand {
  const workDir = options.workingDir.trim();
  const policy = options.executionPolicy.trim();
  let invoke = `& ${psSingleQuote(options.scriptPath)}`;
  const args = options.scriptArgs ?? [];
  if (args.length > 0) {
    invoke += ` ${args.map(formatDirectRunArg).join(" ")}`;
  }
  return {
    command: invoke,
    workingDir: workDir || null,
    executionPolicy: policy && policy !== "Default" ? policy : null,
  };
}
