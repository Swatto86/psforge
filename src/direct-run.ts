/** Saved scripts run in a fresh, profile-free PowerShell child process. */

export interface DirectTerminalRunCommand {
  /** Command submitted to the integrated console. */
  command: string;
  /** Legacy prep metadata; setup now happens inside the child. */
  workingDir: string | null;
  /** Legacy prep metadata; policy now belongs to the child. */
  executionPolicy: string | null;
}

import type { EditorTab } from "./types";

/** Disk scripts retain their real path, including scratch-backed files. */
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
  const setup = workDir
    ? `Set-Location -LiteralPath ${psSingleQuote(workDir)} -ErrorAction Stop; `
    : "";
  const childScript = `${setup}${invoke}; if (-not $?) { exit 1 }`;
  const policyArg = policy && policy !== "Default"
    ? ` -ExecutionPolicy ${psSingleQuote(policy)}`
    : "";
  return {
    command: `& (Get-Process -Id $PID).Path -NoLogo -NoProfile${policyArg} -Command ${psSingleQuote(childScript)}`,
    workingDir: null,
    executionPolicy: null,
  };
}
