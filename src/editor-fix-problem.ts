/** Monaco wiring for "Fix Problem (AI)" on diagnostic squiggles. */

import type { editor as MonacoEditor } from "monaco-editor";
import type { AppSettings } from "./types";
import { askAi } from "./commands";
import { showAppToast } from "./components/ToastStack";
import {
  buildFixProblemQuestion,
  filterMarkersAtLine,
  markerToTarget,
  pickPrimaryMarker,
} from "./fix-problem";

export const FIX_PROBLEM_ACTION_ID = "psforge-fix-problem";

export interface FixProblemEditorDeps {
  getSettings: () => AppSettings;
  getTabMeta: () => {
    id: string;
    title: string;
    filePath: string;
  } | null;
  applyFixedScript: (tabId: string, code: string) => void;
  isAiEnabled: () => boolean;
}

type MonacoApi = typeof import("monaco-editor");

/**
 * Registers context-menu action + context key so "Fix Problem (AI)" appears
 * when right-clicking a line that has editor markers (red/yellow squiggles).
 */
export function registerFixProblemAction(
  editor: MonacoEditor.IStandaloneCodeEditor,
  monaco: MonacoApi,
  deps: FixProblemEditorDeps,
): { dispose: () => void; setHasMarker: (value: boolean) => void } {
  const hasMarkerKey = editor.createContextKey<boolean>(
    "psforgeHasMarkerAtLine",
    false,
  );

  let fixInFlight = false;

  const runFixAtLine = async (line: number) => {
    if (!deps.isAiEnabled() || fixInFlight) return;
    const model = editor.getModel();
    const tab = deps.getTabMeta();
    if (!model || !tab) return;

    const markers = filterMarkersAtLine(
      monaco.editor.getModelMarkers({ resource: model.uri }),
      line,
    );
    const primary = pickPrimaryMarker(markers);
    if (!primary) {
      showAppToast("No problem on this line to fix.");
      return;
    }

    const { question, diagnostics } = buildFixProblemQuestion(
      markerToTarget(primary),
    );
    fixInFlight = true;
    showAppToast("Asking AI to fix this problem…");
    try {
      const response = await askAi(deps.getSettings(), {
        mode: "fix",
        question,
        scriptPath: tab.filePath || tab.title,
        script: model.getValue(),
        terminalOutput: "",
        diagnostics,
      });
      const code = response.code?.trim() ?? "";
      if (!code) {
        showAppToast(
          response.answer?.trim()
            ? `AI did not return a script: ${response.answer.trim().slice(0, 160)}`
            : "AI did not return a fixed script.",
        );
        return;
      }
      deps.applyFixedScript(tab.id, code);
      if (editor.getModel() === model) {
        model.setValue(code);
      }
      showAppToast(
        `Fixed with ${response.provider} · ${response.model}`,
      );
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      showAppToast(`Fix failed: ${message}`);
    } finally {
      fixInFlight = false;
    }
  };

  const action = editor.addAction({
    id: FIX_PROBLEM_ACTION_ID,
    label: "Fix Problem (AI)",
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 1.5,
    precondition: "psforgeAiEnabled && psforgeHasMarkerAtLine",
    run: (ed) => {
      const line =
        ed.getPosition()?.lineNumber ??
        ed.getSelection()?.startLineNumber ??
        null;
      if (!line || line < 1) return;
      void runFixAtLine(line);
    },
  });

  return {
    dispose: () => {
      action?.dispose();
      hasMarkerKey.set(false);
    },
    setHasMarker: (value: boolean) => {
      hasMarkerKey.set(value && deps.isAiEnabled());
    },
  };
}

/** Update the context key from a context-menu event position. */
export function updateFixProblemContextKey(
  monaco: MonacoApi,
  editor: MonacoEditor.IStandaloneCodeEditor,
  line: number | null,
  setHasMarker: (value: boolean) => void,
  isAiEnabled: () => boolean,
): void {
  if (!line || line < 1 || !isAiEnabled()) {
    setHasMarker(false);
    return;
  }
  const model = editor.getModel();
  if (!model) {
    setHasMarker(false);
    return;
  }
  const atLine = filterMarkersAtLine(
    monaco.editor.getModelMarkers({ resource: model.uri }),
    line,
  );
  setHasMarker(atLine.length > 0);
}
