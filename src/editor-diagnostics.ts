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
 * Debounced editor diagnostics. Call on content change and when a tab opens /
 * Monaco becomes ready so parse errors appear without requiring a keystroke.
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
    clearMarkersAndProblems(args);
    return;
  }

  const tabId = args.tabId;
  const content = args.scriptContent;
  const setProblems = args.setProblems;
  const analyze = args.analyze;

  args.timerRef.current = setTimeout(() => {
    analyze(psPath, content)
      .then((diags) => {
        monaco.editor.setModelMarkers(
          model,
          "pssa",
          diagnosticsToMarkers(monaco, diags),
        );
        setProblems(tabId, diags);
      })
      .catch(() => {
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
