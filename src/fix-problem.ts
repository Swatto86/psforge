/** Fix Problem (AI) — question builders and marker helpers for editor squiggles. */

import type { editor as MonacoEditor } from "monaco-editor";
import type { AppSettings, PssaDiagnostic } from "./types";
import { askAi } from "./commands";
import { fenceFor } from "./explain-selection";

/** Cap problem message size inside the AI question. */
export const MAX_FIX_PROBLEM_CHARS = 2_000;
/** Cap combined diagnostic list for Fix All (matches backend diagnostics budget). */
export const MAX_FIX_ALL_DIAGNOSTICS_CHARS = 18_000;

export interface FixProblemTarget {
  message: string;
  severity: string;
  source: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface FixProblemQuestion {
  question: string;
  diagnostics: string;
}

/** Rank markers so parse/errors win over warnings when several share a line. */
export function pickPrimaryMarker(
  markers: MonacoEditor.IMarker[],
): MonacoEditor.IMarker | null {
  if (markers.length === 0) return null;
  const rank = (m: MonacoEditor.IMarker): number => {
    switch (m.severity) {
      case 8: // MarkerSeverity.Error
        return 0;
      case 4: // Warning
        return 1;
      case 2: // Info
        return 2;
      default:
        return 3;
    }
  };
  return [...markers].sort((a, b) => {
    const bySev = rank(a) - rank(b);
    if (bySev !== 0) return bySev;
    return a.startColumn - b.startColumn;
  })[0];
}

/** Filter markers to those covering `line`. */
export function filterMarkersAtLine(
  markers: MonacoEditor.IMarker[],
  line: number,
): MonacoEditor.IMarker[] {
  return markers.filter(
    (m) => line >= m.startLineNumber && line <= m.endLineNumber,
  );
}

export function markerToTarget(
  marker: MonacoEditor.IMarker,
): FixProblemTarget {
  return {
    message: marker.message,
    severity: severityLabel(marker.severity),
    source: marker.source || "Diagnostics",
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
  };
}

function severityLabel(severity: number): string {
  switch (severity) {
    case 8:
      return "Error";
    case 4:
      return "Warning";
    case 2:
      return "Info";
    case 1:
      return "Hint";
    default:
      return "Error";
  }
}

/** Builds mode-"fix" question focused on one squiggle/problem. */
export function buildFixProblemQuestion(
  target: FixProblemTarget,
): FixProblemQuestion {
  const truncated = target.message.length > MAX_FIX_PROBLEM_CHARS;
  const message = truncated
    ? target.message.slice(0, MAX_FIX_PROBLEM_CHARS)
    : target.message;
  const location = `line ${target.startLineNumber}, column ${target.startColumn}`;
  const diagnostics =
    `${location} [${target.severity}/${target.source}]: ${message}` +
    (truncated ? "…" : "");
  const fence = fenceFor(diagnostics);
  const question =
    "Fix the PowerShell PROBLEM below in the script. " +
    "Return the complete corrected script in the JSON code field. " +
    "Change only what is needed to fix this problem; preserve the rest of the script and its intent. " +
    "Do not invent unrelated features.\n\n" +
    `PROBLEM (${location}${truncated ? ", message truncated" : ""}):\n` +
    `${fence}text\n${diagnostics}\n${fence}`;
  return { question, diagnostics };
}

export function diagnosticToTarget(
  diagnostic: PssaDiagnostic,
): FixProblemTarget {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: diagnostic.ruleName || "Diagnostics",
    startLineNumber: diagnostic.line,
    startColumn: diagnostic.column,
    endLineNumber: diagnostic.endLine > 0 ? diagnostic.endLine : diagnostic.line,
    endColumn: diagnostic.endColumn > 0 ? diagnostic.endColumn : diagnostic.column,
  };
}

function formatDiagnosticLine(target: FixProblemTarget): string {
  const truncated = target.message.length > MAX_FIX_PROBLEM_CHARS;
  const message = truncated
    ? `${target.message.slice(0, MAX_FIX_PROBLEM_CHARS)}…`
    : target.message;
  return `line ${target.startLineNumber}, column ${target.startColumn} [${target.severity}/${target.source}]: ${message}`;
}

/** Builds mode-"fix" question covering every listed diagnostic. */
export function buildFixAllProblemsQuestion(
  diagnostics: PssaDiagnostic[],
): FixProblemQuestion {
  const lines: string[] = [];
  let omitted = 0;
  for (const diagnostic of diagnostics) {
    const line = formatDiagnosticLine(diagnosticToTarget(diagnostic));
    const next = [...lines, line].join("\n");
    if (next.length > MAX_FIX_ALL_DIAGNOSTICS_CHARS && lines.length > 0) {
      omitted += 1;
      continue;
    }
    lines.push(line);
  }
  if (omitted > 0) {
    lines.push(`(+ ${omitted} more problems omitted from this list)`);
  }
  const diagnosticsText = lines.join("\n");
  const fence = fenceFor(diagnosticsText);
  const question =
    "Fix ALL PowerShell PROBLEMS and WARNINGS listed below in the script. " +
    "Return the complete corrected script in the JSON code field. " +
    "Change only what is needed to resolve these diagnostics; preserve the rest of the script and its intent. " +
    "Do not invent unrelated features.\n\n" +
    `PROBLEMS (${diagnostics.length}):\n` +
    `${fence}text\n${diagnosticsText}\n${fence}`;
  return { question, diagnostics: diagnosticsText };
}

export interface ApplyAiFixRequest {
  settings: AppSettings;
  question: string;
  diagnostics: string;
  script: string;
  scriptPath: string;
  terminalOutput?: string;
  debugBundle?: string;
}

export interface ApplyAiFixResult {
  ok: boolean;
  code?: string;
  toast: string;
}

/** Shared ask_ai fix path used by squiggle Fix and Problems Fix All. */
export async function applyAiFix(
  request: ApplyAiFixRequest,
): Promise<ApplyAiFixResult> {
  try {
    const response = await askAi(request.settings, {
      mode: "fix",
      question: request.question,
      scriptPath: request.scriptPath,
      script: request.script,
      terminalOutput: request.terminalOutput ?? "",
      diagnostics: request.diagnostics,
      debugBundle: request.debugBundle ?? "",
    });
    const code = response.code?.trim() ?? "";
    if (!code) {
      return {
        ok: false,
        toast: response.answer?.trim()
          ? `AI did not return a script: ${response.answer.trim().slice(0, 160)}`
          : "AI did not return a fixed script.",
      };
    }
    return {
      ok: true,
      code,
      toast: `Fixed with ${response.provider} · ${response.model}`,
    };
  } catch (err) {
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    return { ok: false, toast: `Fix failed: ${message}` };
  }
}
