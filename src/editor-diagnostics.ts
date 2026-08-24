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

export function applyDiagnosticsMarkers(
  monaco: typeof import("monaco-editor") | null,
  model: MonacoEditor.ITextModel | null,
  diags: PssaDiagnostic[],
): void {
  if (!monaco || !model) return;
  monaco.editor.setModelMarkers(
    model,
    "pssa",
    diagnosticsToMarkers(monaco, diags),
  );
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
  applyDiagnosticsMarkers(monaco, model, []);
  setProblems(tabId, []);
}

/**
 * Debounced editor diagnostics. Runs analyze when script + PS host are ready
 * (Monaco optional). Reference → Problems updates even before the editor model
 * exists; squiggles apply when the model is available.
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

  const psPath = args.psPath.trim();
  if (!psPath) {
    return;
  }

  const tabId = args.tabId;
  const content = args.scriptContent;
  const setProblems = args.setProblems;
  const analyze = args.analyze;
  const { monaco, model } = args;
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
        setProblems(tabId, diags);
        applyDiagnosticsMarkers(monaco, model, diags);
      })
      .catch(() => {
        if (
          args.requestIdRef &&
          requestId !== args.requestIdRef.current
        ) {
          return;
        }
        setProblems(tabId, []);
        applyDiagnosticsMarkers(monaco, model, []);
      });
  }, args.debounceMs);
}
