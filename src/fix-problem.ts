/** Fix Problem (AI) — question builders and marker helpers for editor squiggles. */

import type { editor as MonacoEditor } from "monaco-editor";
import type { AppSettings, PssaDiagnostic } from "./types";
import { askAi } from "./commands";
import { fenceFor } from "./explain-selection";

/** Cap problem message size inside the AI question. */
export const MAX_FIX_PROBLEM_CHARS = 2_000;
/**
 * Cap for the Fix All diagnostics payload (under backend MAX_DIAGNOSTICS_CHARS).
 * The question itself stays short; the model reads this attached list.
 */
export const MAX_FIX_ALL_DIAGNOSTICS_CHARS = 18_000;
/** Backend ask_ai rejects questions longer than this (ai.rs MAX_QUESTION_CHARS). */
export const MAX_AI_QUESTION_CHARS = 8_000;

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

export interface FixAllProblemsQuestion extends FixProblemQuestion {
  /** How many diagnostics were included in this batch. */
  includedCount: number;
  /** How many were deferred (over budget / lower priority). */
  omittedCount: number;
  totalCount: number;
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

function diagnosticSeverityRank(severity: string): number {
  switch (severity) {
    case "ParseError":
      return 0;
    case "Error":
      return 1;
    case "Warning":
      return 2;
    default:
      return 3;
  }
}

/** Errors/parse failures first, then warnings, then by line. */
export function prioritizeDiagnostics(
  diagnostics: PssaDiagnostic[],
): PssaDiagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const bySev =
      diagnosticSeverityRank(a.severity) - diagnosticSeverityRank(b.severity);
    if (bySev !== 0) return bySev;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
}

/**
 * Builds a short mode-"fix" question for Fix All.
 * Packs a prioritized diagnostics list into the separate diagnostics field
 * (not the question) so large Problem lists do not hit AI_QUESTION_TOO_LONG.
 */
export function buildFixAllProblemsQuestion(
  diagnostics: PssaDiagnostic[],
): FixAllProblemsQuestion {
  const ordered = prioritizeDiagnostics(diagnostics);
  const lines: string[] = [];
  for (const diagnostic of ordered) {
    const line = formatDiagnosticLine(diagnosticToTarget(diagnostic));
    const nextLen =
      lines.length === 0 ? line.length : lines.join("\n").length + 1 + line.length;
    if (nextLen > MAX_FIX_ALL_DIAGNOSTICS_CHARS && lines.length > 0) {
      break;
    }
    lines.push(line);
  }
  const includedCount = lines.length;
  const omittedCount = Math.max(0, ordered.length - includedCount);
  if (omittedCount > 0) {
    lines.push(
      `(+ ${omittedCount} lower-priority problem(s) deferred — run Fix All again after this batch)`,
    );
  }
  const diagnosticsText = lines.join("\n");
  const question =
    `Fix the PowerShell PROBLEMS attached as DIAGNOSTICS (${includedCount} of ${ordered.length}, errors first). ` +
    "Return the complete corrected script in the JSON code field. " +
    "Change only what is needed to resolve these diagnostics; preserve the rest of the script and its intent. " +
    "Do not invent unrelated features." +
    (omittedCount > 0
      ? ` ${omittedCount} lower-priority problem(s) were deferred for a later pass.`
      : "");
  if (question.length > MAX_AI_QUESTION_CHARS) {
    // Defensive: keep ask_ai from rejecting; diagnostics payload still carries detail.
    return {
      question: question.slice(0, MAX_AI_QUESTION_CHARS - 1),
      diagnostics: diagnosticsText,
      includedCount,
      omittedCount,
      totalCount: ordered.length,
    };
  }
  return {
    question,
    diagnostics: diagnosticsText,
    includedCount,
    omittedCount,
    totalCount: ordered.length,
  };
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
