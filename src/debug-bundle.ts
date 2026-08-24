import {
  getRunOutputLineCount,
  getRunScriptOutput,
  getRunTerminalPlainContent,
} from "./terminal-utils";
import type { EditorTab, LastRunResult, PssaDiagnostic } from "./types";
import { isPssaErrorSeverity } from "./run-utils";

/** Choose a fence delimiter longer than any backtick run in `content`, so an
 *  embedded ``` inside the script or its output cannot prematurely close the
 *  fence and spill the rest of the bundle outside any code block (S3-23). */
function fenceFor(content: string): string {
  let max = 0;
  const runs = content.match(/`+/g);
  if (runs) {
    for (const run of runs) max = Math.max(max, run.length);
  }
  return "`".repeat(Math.max(3, max + 1));
}

export interface DebugBundleInput {
  tab: EditorTab | undefined;
  lastRun: LastRunResult | null;
  workingDir: string;
  problems: PssaDiagnostic[];
  getRunOutput: () => string;
}

function formatExitLabel(exitCode: number | null): string {
  if (exitCode === null) return "failed (no exit code)";
  if (exitCode === 0) return "0 (success)";
  return String(exitCode);
}

/** Build markdown for the in-app assistant (script, last run, PSSA). */
export function buildDebugBundleMarkdown(input: DebugBundleInput): string {
  const tab = input.tab;
  const title = tab?.filePath
    ? tab.filePath
    : tab?.title ?? "Untitled script";
  const lines: string[] = [
    "## PSForge debug bundle",
    "",
    `- **Script:** ${title}`,
    `- **Working directory:** ${input.workingDir || "(unknown)"}`,
  ];

  if (input.lastRun) {
    lines.push(
      `- **Last run:** exit ${formatExitLabel(input.lastRun.exitCode)}, ${input.lastRun.durationMs} ms`,
    );
  } else {
    lines.push("- **Last run:** (none yet — press F5)");
  }

  const errors = input.problems.filter((d) => isPssaErrorSeverity(d.severity));
  const warnings = input.problems.filter(
    (d) => d.severity === "Warning" || d.severity === "Information",
  );

  if (errors.length > 0) {
    lines.push("", "### PSScriptAnalyzer errors", "");
    for (const d of errors.slice(0, 8)) {
      lines.push(
        `- Line ${d.line}: ${d.message}${d.ruleName ? ` (\`${d.ruleName}\`)` : ""}`,
      );
    }
    if (errors.length > 8) {
      lines.push(`- _+ ${errors.length - 8} more in Reference → Problems_`);
    }
  }

  if (warnings.length > 0 && errors.length === 0) {
    lines.push("", "### PSScriptAnalyzer warnings", "");
    for (const d of warnings.slice(0, 5)) {
      lines.push(`- Line ${d.line}: ${d.message}`);
    }
  }

  const output = input.getRunOutput().trim();
  lines.push("", "### Terminal output (last run)", "");
  if (output) {
    const fence = fenceFor(output);
    lines.push(`${fence}text`, output, fence);
  } else {
    lines.push("_No captured output for the last run._");
  }

  if (tab?.content?.trim()) {
    const body = tab.content.trimEnd();
    const fence = fenceFor(body);
    lines.push("", "### Script snapshot", "", `${fence}powershell`, body, fence);
  }

  return lines.join("\n");
}

/** Snapshot last-run terminal output the same way Copy Script Output does. */
export function captureLastRunOutput(): string {
  const scriptOutput = getRunScriptOutput();
  if (scriptOutput !== null) return scriptOutput;

  // Reflow/eviction-safe count of the last run's output lines (S3-13).
  // count === 0 means the run produced no output (leave it empty); only a null
  // baseline (no run / evicted) falls back to the full scrollback. Both reads
  // target the console tab that ran the script, not the active one (S6-20).
  const count = getRunOutputLineCount();
  if (count === 0) return "";
  let runOutput = count !== null ? getRunTerminalPlainContent(count) : "";
  if (count === null && !runOutput.trim()) {
    runOutput = getRunTerminalPlainContent();
  }
  return runOutput;
}

/** Debug bundle for the in-app assistant: script, last run, PSSA, working dir. */
export function collectDebugBundleMarkdown(
  input: Omit<DebugBundleInput, "getRunOutput">,
): string {
  const output = captureLastRunOutput();
  return buildDebugBundleMarkdown({
    ...input,
    getRunOutput: () => output,
  });
}
