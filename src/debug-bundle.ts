import {
  getRunOutputLineCount,
  getTerminalPlainContent,
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

/** Build markdown suitable for pasting into an AI chat thread. */
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

export async function copyDebugBundleToClipboard(
  input: DebugBundleInput,
): Promise<boolean> {
  const markdown = buildDebugBundleMarkdown(input);
  if (!markdown.trim()) return false;
  await navigator.clipboard.writeText(markdown);
  return true;
}

/** Build bundle using terminal scrollback from the last F5 run when possible. */
export async function copyDebugBundleWithRunOutput(
  input: DebugBundleInput,
): Promise<boolean> {
  // Reflow/eviction-safe count of the last run's output lines (S3-13).
  // count === 0 means the run produced no output (leave it empty); only a null
  // baseline (no run / evicted) falls back to the full scrollback.
  const count = getRunOutputLineCount();
  let runOutput = count !== null ? getTerminalPlainContent(count) : "";
  if (count === null && !runOutput.trim()) {
    runOutput = getTerminalPlainContent();
  }
  return copyDebugBundleToClipboard({
    ...input,
    getRunOutput: () => runOutput,
  });
}
