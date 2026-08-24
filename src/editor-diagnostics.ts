import type { editor as MonacoEditor } from "monaco-editor";
import type { PssaDiagnostic } from "./types";

/** Maps analyzer severity strings to Monaco MarkerSeverity. */
export function pssaSeverity(
  monaco: typeof import("monaco-editor"),
  severity: string,
): number {
  switch (severity) {
    case "Error":
    case "ParseError":
      return monaco.MarkerSeverity.Error;
    case "Warning":
      return monaco.MarkerSeverity.Warning;
    case "Information":
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

/** Convert backend diagnostics into Monaco model markers (owner "pssa"). */
export function diagnosticsToMarkers(
  monaco: typeof import("monaco-editor"),
  diags: PssaDiagnostic[],
): MonacoEditor.IMarkerData[] {
  return diags.map((d) => ({
    severity: pssaSeverity(monaco, d.severity),
    message: d.message,
    source: d.ruleName,
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.endLine > 0 ? d.endLine : d.line,
    endColumn: d.endColumn > 0 ? d.endColumn : d.column + 1,
  }));
}

export type ScheduleDiagnosticsArgs = {
  enabled: boolean;
  psPath: string;
  scriptContent: string;
  tabId: string;
  monaco: typeof import("monaco-editor") | null;
  model: MonacoEditor.ITextModel | null;
  timerRef: { current: ReturnType<typeof setTimeout> | null };
  /** Bumped on each schedule so a slower older analyze cannot overwrite newer results. */
  requestIdRef?: { current: number };
  debounceMs: number;
  analyze: (psPath: string, content: string) => Promise<PssaDiagnostic[]>;
  setProblems: (tabId: string, diagnostics: PssaDiagnostic[]) => void;
};

function clearMarkersAndProblems(args: ScheduleDiagnosticsArgs): void {
  const { monaco, model, tabId, setProblems } = args;
  if (monaco && model) {
    monaco.editor.setModelMarkers(model, "pssa", []);
  }
  setProblems(tabId, []);
}

/**
 * Debounced editor diagnostics. Drive from tab content (typing, open, AI Fix)
 * so Reference → Problems stays in sync without requiring a keystroke.
 *
 * When Monaco/model/PowerShell path are not ready yet, wait — do not clear
 * Problems (that race left the Reference tab empty until the user typed).
 */
export function scheduleEditorDiagnostics(args: ScheduleDiagnosticsArgs): void {
  if (args.timerRef.current !== null) {
    clearTimeout(args.timerRef.current);
    args.timerRef.current = null;
  }

  if (!args.enabled) {
    clearMarkersAndProblems(args);
    return;
  }

  const { monaco, model, psPath } = args;
  if (!monaco || !model || !psPath) {
    return;
  }

  const tabId = args.tabId;
  const content = args.scriptContent;
  const setProblems = args.setProblems;
  const analyze = args.analyze;
  const requestId = args.requestIdRef
    ? ++args.requestIdRef.current
    : 0;

  args.timerRef.current = setTimeout(() => {
    analyze(psPath, content)
      .then((diags) => {
        if (
          args.requestIdRef &&
          requestId !== args.requestIdRef.current
        ) {
          return;
        }
        monaco.editor.setModelMarkers(
          model,
          "pssa",
          diagnosticsToMarkers(monaco, diags),
        );
        setProblems(tabId, diags);
      })
      .catch(() => {
        if (
          args.requestIdRef &&
          requestId !== args.requestIdRef.current
        ) {
          return;
        }
        clearMarkersAndProblems({
          ...args,
          monaco,
          model,
          tabId,
          setProblems,
        });
      });
  }, args.debounceMs);
}
