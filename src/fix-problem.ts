/** Fix Problem (AI) — question builders and marker helpers for editor squiggles. */

import type { editor as MonacoEditor } from "monaco-editor";
import { fenceFor } from "./explain-selection";

/** Cap problem message size inside the AI question. */
export const MAX_FIX_PROBLEM_CHARS = 2_000;

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
