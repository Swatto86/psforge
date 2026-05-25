import {
  getTerminalLineCount,
  getTerminalPlainContent,
} from "./terminal-utils";
import type { EditorTab, LastRunResult, PssaDiagnostic } from "./types";
import { isPssaErrorSeverity } from "./run-utils";

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
    lines.push("```text", output, "```");
  } else {
    lines.push("_No captured output for the last run._");
  }

  if (tab?.content?.trim()) {
    lines.push("", "### Script snapshot", "", "```powershell", tab.content.trimEnd(), "```");
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
  lastRunStartLine: number | null,
): Promise<boolean> {
  let runOutput = "";
  const total = getTerminalLineCount();
  if (lastRunStartLine !== null && lastRunStartLine >= 0 && total > lastRunStartLine) {
    runOutput = getTerminalPlainContent(total - lastRunStartLine);
  }
  if (!runOutput.trim()) {
    runOutput = getTerminalPlainContent();
  }
  return copyDebugBundleToClipboard({
    ...input,
    getRunOutput: () => runOutput,
  });
}
