import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch } from "react";
import type { AppState, Action } from "./store";
import { newTabId, untitledCounter } from "./store";
import type { EditorTab } from "./types";
import * as cmd from "./commands";
import { sanitizePastedTextWithSummary, FULL_PASTE_SANITIZE_OPTIONS } from "./sanitize-paste";
import { formatPasteSummaryMessage } from "./paste-summary";
import { showAppToast } from "./components/ToastStack";

type Options = {
  state: AppState;
  dispatch: Dispatch<Action>;
  writeTerminalNotice: (text: string, options?: { reveal?: boolean }) => Promise<void>;
  runScript: (options?: { newConsole?: boolean }) => Promise<void>;
};

export function useClipboardScript({ state, dispatch, writeTerminalNotice, runScript }: Options) {
  const busy = useRef(false);
  const pending = useRef<{ id: string; newConsole: boolean } | null>(null);
  useEffect(() => {
    const next = pending.current;
    if (!next || !state.tabs.some((tab) => tab.id === next.id)) return;
    pending.current = null;
    if (state.activeTabId !== next.id || state.isRunning) {
      busy.current = false;
      void writeTerminalNotice("[PSForge] Script pasted but not run: another script is active.", { reveal: true });
      return;
    }
    void runScript({ newConsole: next.newConsole })
      .catch(() => writeTerminalNotice("[PSForge] Pasted script could not be run.", { reveal: true }))
      .finally(() => { busy.current = false; });
  }, [state.tabs, state.activeTabId, state.isRunning, runScript, writeTerminalNotice]);

  const pasteFromClipboardAsNewScript = useCallback(
    async (options?: { runInNewConsole?: boolean }) => {
      if (busy.current || state.isRunning) {
        showAppToast("Wait for the current script or paste to finish, then Paste + Run again.");
        return;
      }
      if (!state.selectedPsPath) {
        const message =
          "[PSForge] No PowerShell host selected. Choose a host in the toolbar, then paste again.";
        showAppToast(message);
        void writeTerminalNotice(message, { reveal: true });
        return;
      }
      busy.current = true;
      try {
        let clip = "";
        try {
          clip = await readText();
        } catch {
          void writeTerminalNotice(
            "[PSForge] Could not read the clipboard. Allow clipboard access and try again.",
            { reveal: true },
          );
          return;
        }
        if (!clip.trim()) {
          showAppToast("Clipboard is empty.");
          return;
        }

        const { text: cleaned, summary } = sanitizePastedTextWithSummary(
          clip,
          FULL_PASTE_SANITIZE_OPTIONS,
        );
        showAppToast(formatPasteSummaryMessage(summary));
        let formatted = cleaned;
        try {
          formatted = await cmd.formatScript(state.selectedPsPath, cleaned);
        } catch {
          // Formatting is optional; cleaned paste is still usable.
        }

        const id = newTabId();
        const tab: EditorTab = {
          id,
          title: `Untitled-${untitledCounter()}`,
          filePath: "",
          content: formatted,
          savedContent: "",
          encoding: "utf8",
          language: "powershell",
          isDirty: true,
          tabType: "code",
        };
        if (state.settings.runAfterPasteCleanFormat !== false) {
          pending.current = { id, newConsole: options?.runInNewConsole !== false };
        }
        dispatch({ type: "ADD_TAB", tab });
        const welcomeTab = state.tabs.find((t) => t.tabType === "welcome");
        if (welcomeTab) {
          dispatch({ type: "CLOSE_TAB", id: welcomeTab.id });
        }
      } finally {
        if (!pending.current) busy.current = false;
      }
    },
    [
      state.isRunning,
      state.selectedPsPath,
      state.tabs,
      state.settings.runAfterPasteCleanFormat,
      dispatch,
      writeTerminalNotice,
    ],
  );

  return pasteFromClipboardAsNewScript;
}
