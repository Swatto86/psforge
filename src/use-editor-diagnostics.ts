/** Runs editor diagnostics at app level (independent of Monaco mount timing). */

import { useEffect, useRef, type Dispatch } from "react";
import { analyzeScript } from "./commands";
import type { EditorTab } from "./types";
import type { Action } from "./store";

export function useEditorDiagnostics(opts: {
  enabled: boolean;
  selectedPsPath: string;
  activeTab: EditorTab | undefined;
  dispatch: Dispatch<Action>;
}): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const contentRef = useRef<string | null>(null);
  const activeTabIdRef = useRef<string | undefined>(opts.activeTab?.id);

  useEffect(() => {
    activeTabIdRef.current = opts.activeTab?.id;
  }, [opts.activeTab?.id]);

  useEffect(() => {
    contentRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [opts.activeTab?.id]);

  useEffect(() => {
    const tab = opts.activeTab;
    if (!opts.enabled || !tab || tab.tabType === "welcome") return;

    const psPath = opts.selectedPsPath.trim();
    if (!psPath) return;

    const contentChanged =
      contentRef.current !== null && contentRef.current !== tab.content;
    contentRef.current = tab.content;

    const capturedTabId = tab.id;
    const debounceMs = contentChanged ? 300 : 0;
    const requestId = ++requestIdRef.current;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      analyzeScript(psPath, tab.content)
        .then((diagnostics) => {
          if (requestId !== requestIdRef.current) return;
          if (activeTabIdRef.current !== capturedTabId) return;
          opts.dispatch({
            type: "SET_PROBLEMS",
            tabId: capturedTabId,
            diagnostics,
          });
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          if (activeTabIdRef.current !== capturedTabId) return;
          opts.dispatch({
            type: "SET_PROBLEMS",
            tabId: capturedTabId,
            diagnostics: [],
          });
        });
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [
    opts.enabled,
    opts.selectedPsPath,
    opts.activeTab?.id,
    opts.activeTab?.content,
    opts.dispatch,
  ]);
}
