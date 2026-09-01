/** PSForge Integrated Terminal: console tabs and the app-wide terminal bridge. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ITheme } from "@xterm/xterm";
import { useAppState } from "../store";
import * as cmd from "../commands";
import { installWindowBridge } from "../terminal-utils";
import { highlightPs } from "../terminal/ps-highlight";
import {
  enterPsSessionCommand,
  validateRemoteTarget,
} from "../terminal/remote-console";
import { terminalThemeFromCss } from "../terminal/xterm-theme";
import {
  parseWindowsTerminalAppearance,
  resolveConsoleFontFamily,
  windowsTerminalSchemeToXtermTheme,
  type WindowsTerminalAppearance,
} from "../terminal/windows-terminal-theme";
import {
  TerminalSession,
  type TerminalSessionHandle,
} from "./TerminalSession";
import { TerminalRemoteDialog } from "./TerminalRemoteDialog";
import { TerminalTabStrip } from "./TerminalTabStrip";

interface ConsoleTabModel {
  id: string;
  title: string;
  shellPath: string;
  loadProfile: boolean;
  startupCommand?: string;
}

type RunOptions = {
  clearBeforeRun?: boolean;
  reveal?: boolean;
  newConsole?: boolean;
};

/** Longest a console may take to come up before a run gives up. */
const READY_TIMEOUT_MS = 30000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function TerminalPane() {
  const { state, dispatch } = useAppState();
  const tabCounterRef = useRef(1);
  const sessionRefs = useRef<Record<string, TerminalSessionHandle | null>>({});
  const [wtAppearance, setWtAppearance] =
    useState<WindowsTerminalAppearance | null>(null);
  const [tabs, setTabs] = useState<ConsoleTabModel[]>(() => [
    {
      id: "console-1",
      title: "Console 1",
      shellPath: state.selectedPsPath || "",
      loadProfile: state.settings.terminalLoadProfile !== false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState("console-1");
  const [showRemoteDialog, setShowRemoteDialog] = useState(false);
  const [remoteTarget, setRemoteTarget] = useState("");
  const [remoteValidationError, setRemoteValidationError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void cmd
      .readWindowsTerminalSettings()
      .then((text) => {
        if (cancelled || !text) return;
        setWtAppearance(parseWindowsTerminalAppearance(text));
      })
      .catch(() => {
        // Terminal not installed or settings unreadable — keep CSS theme.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const consoleTheme = useMemo((): ITheme => {
    if (wtAppearance?.scheme) {
      return windowsTerminalSchemeToXtermTheme(wtAppearance.scheme);
    }
    return terminalThemeFromCss();
  }, [wtAppearance, state.settings.theme]);

  const consoleFontFamily = resolveConsoleFontFamily(
    wtAppearance?.fontFace,
    state.settings.outputFontFamily,
  );
  const consoleFontSize =
    wtAppearance?.fontSize ?? state.settings.outputFontSize ?? 13;

  const getActiveHandle = () => sessionRefs.current[activeTabId] ?? null;

  /** Console tab that ran the most recent F5/paste-run script. "Copy Last
   *  Run", the debug bundle, and the AI run-context must read THAT tab —
   *  reading whichever sub-tab is currently active silently returns the
   *  wrong terminal's content after the user opens/switches tabs (S6-20). */
  const lastRunTabIdRef = useRef<string | null>(null);
  const getRunHandle = () =>
    lastRunTabIdRef.current
      ? (sessionRefs.current[lastRunTabIdRef.current] ?? null)
      : null;

  const newTabModel = useCallback((): ConsoleTabModel => {
    tabCounterRef.current += 1;
    return {
      id: `console-${tabCounterRef.current}`,
      title: `Console ${tabCounterRef.current}`,
      shellPath: state.selectedPsPath || "",
      loadProfile: state.settings.terminalLoadProfile !== false,
    };
  }, [state.selectedPsPath, state.settings.terminalLoadProfile]);

  const createLocalTab = useCallback(() => {
    const tab = newTabModel();
    dispatch({ type: "SET_BOTTOM_TAB", tab: "terminal" });
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab.id;
  }, [dispatch, newTabModel]);

  const createRemoteTab = (target: string) => {
    const tab: ConsoleTabModel = {
      ...newTabModel(),
      title: `Remote: ${target}`,
      startupCommand: enterPsSessionCommand(target),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  };

  const openRemoteDialog = () => {
    setRemoteTarget("");
    setRemoteValidationError("");
    setShowRemoteDialog(true);
  };

  const closeRemoteDialog = useCallback(() => {
    setShowRemoteDialog(false);
    setRemoteTarget("");
    setRemoteValidationError("");
  }, []);

  const confirmRemoteDialog = useCallback(() => {
    const target = remoteTarget.trim();
    const validationError = validateRemoteTarget(target);
    if (validationError) {
      setRemoteValidationError(validationError);
      return;
    }
    createRemoteTab(target);
    closeRemoteDialog();
    // createRemoteTab is recreated every render; the values it reads are
    // captured here through remoteTarget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeRemoteDialog, remoteTarget]);

  const closeTab = (id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const index = prev.findIndex((tab) => tab.id === id);
      if (index === -1) return prev;
      const next = prev.filter((tab) => tab.id !== id);
      if (activeTabId === id) {
        const fallback = next[Math.min(index, next.length - 1)];
        if (fallback) setActiveTabId(fallback.id);
      }
      delete sessionRefs.current[id];
      return next;
    });
  };

  /** A local (non-remote) console to run in: current, existing, or new. */
  const ensureLocalExecutionTab = useCallback(() => {
    const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
    if (active && !active.startupCommand) return active.id;

    const existingLocal = tabs.find((tab) => !tab.startupCommand) ?? null;
    if (existingLocal) return existingLocal.id;

    const tab = newTabModel();
    setTabs((prev) => [...prev, tab]);
    return tab.id;
  }, [activeTabId, newTabModel, tabs]);

  const waitForReadyHandle = useCallback(async (tabId: string) => {
    const timeoutAt = Date.now() + READY_TIMEOUT_MS;
    let restartRequested = false;

    while (Date.now() < timeoutAt) {
      const handle = sessionRefs.current[tabId] ?? null;
      if (handle?.isReady()) return handle;
      if (handle && !restartRequested) {
        handle.restart();
        restartRequested = true;
      }
      await sleep(100);
    }

    throw new Error("Integrated terminal did not become ready.");
  }, []);

  /** Reveal a console tab and wait for its PowerShell session to come up. */
  const prepareTab = useCallback(
    async (tabId: string, reveal: boolean) => {
      if (reveal) {
        dispatch({ type: "SET_BOTTOM_TAB", tab: "terminal" });
        setActiveTabId(tabId);
      }
      await sleep(0);
      return waitForReadyHandle(tabId);
    },
    [dispatch, waitForReadyHandle],
  );

  const runCommandInLocalTerminal = useCallback(
    async (command: string, options?: RunOptions) => {
      const tabId = options?.newConsole
        ? createLocalTab()
        : ensureLocalExecutionTab();
      const reveal = options?.reveal !== false;

      let handle = await prepareTab(tabId, reveal);
      // New consoles already start blank; only wipe+restart when reusing a tab.
      if (options?.clearBeforeRun && !options?.newConsole) {
        // Full Clear (wipe + restart) so F5 starts on a blank console with a
        // fresh PowerShell session, not leftover scrollback.
        handle.clear();
        handle = await waitForReadyHandle(tabId);
      }
      // Mark the run-start baseline AFTER any clear, right before the command
      // starts, via a reflow/eviction-safe xterm marker (S3-13).
      handle.markRunStart(command);
      lastRunTabIdRef.current = tabId;
      if (reveal) handle.focus();
      return handle.exec(command);
    },
    [createLocalTab, ensureLocalExecutionTab, prepareTab, waitForReadyHandle],
  );

  const writeNoticeToLocalTerminal = useCallback(
    async (text: string, options?: { reveal?: boolean }) => {
      if (!text) return;
      const reveal = options?.reveal === true;
      const handle = await prepareTab(ensureLocalExecutionTab(), reveal);
      handle.writeLocal(text);
      if (reveal) handle.focus();
    },
    [ensureLocalExecutionTab, prepareTab],
  );

  const pasteToLocalTerminal = useCallback(
    async (text: string, options?: { reveal?: boolean }) => {
      if (!text) return;
      const reveal = options?.reveal !== false;
      const handle = await prepareTab(ensureLocalExecutionTab(), reveal);
      handle.pasteText(text);
      if (reveal) handle.focus();
    },
    [ensureLocalExecutionTab, prepareTab],
  );

  useEffect(() => {
    return installWindowBridge({
      __psforge_terminal_clear: () => getActiveHandle()?.clear(),
      __psforge_terminal_focus: () => getActiveHandle()?.focus(),
      __psforge_terminal_run_command: (command: string, options?: RunOptions) =>
        runCommandInLocalTerminal(command, options),
      __psforge_terminal_restart: () => getActiveHandle()?.restart(),
      // "Copy Output" semantics: the console the user is looking at.
      __psforge_terminal_get_content: (lineCount?: number) =>
        getActiveHandle()?.getContent(lineCount) ?? "",
      __psforge_terminal_get_selection: () =>
        getActiveHandle()?.getSelection() ?? "",
      // Run-output semantics (Copy Last Run, debug bundle, AI context): the tab
      // that ran the script — including the marker-evicted no-count fallback,
      // which previously leaked back to the active tab (S6-20 round 4). If the
      // run's tab was closed its output is gone: return "" rather than silently
      // reading a different terminal. Before any run, fall back to the active
      // tab (legacy "no baseline → whole scrollback" behavior).
      __psforge_terminal_get_run_content: (lineCount?: number) => {
        const runTabId = lastRunTabIdRef.current;
        if (runTabId) {
          return sessionRefs.current[runTabId]?.getContent(lineCount) ?? "";
        }
        return getActiveHandle()?.getContent(lineCount) ?? "";
      },
      __psforge_terminal_get_run_output_line_count: () =>
        getRunHandle()?.getRunOutputLineCount() ?? null,
      __psforge_terminal_get_run_script_output: () =>
        getRunHandle()?.getRunScriptOutput() ?? null,
      __psforge_terminal_is_ready: () => getActiveHandle()?.isReady() ?? false,
      __psforge_terminal_submit_current_input: () =>
        getActiveHandle()?.submitCurrentInput(),
      __psforge_terminal_write_notice: (
        text: string,
        options?: { reveal?: boolean },
      ) => writeNoticeToLocalTerminal(text, options),
      __psforge_terminal_paste: (
        text: string,
        options?: { reveal?: boolean },
      ) => pasteToLocalTerminal(text, options),
      // Stop (Shift+F5) must hit the console that is executing the F5 run, not
      // whichever console sub-tab is currently visible (same class as S6-20).
      __psforge_terminal_interrupt: () => {
        const runHandle = getRunHandle();
        if (runHandle) {
          runHandle.resetInput();
          return;
        }
        getActiveHandle()?.resetInput();
      },
      __psforge_terminal_reset_input: () => getActiveHandle()?.resetInput(),
      __psforge_highlight_ps: highlightPs,
    });
  }, [
    activeTabId,
    runCommandInLocalTerminal,
    writeNoticeToLocalTerminal,
    pasteToLocalTerminal,
  ]);

  useEffect(() => {
    if (state.bottomPanelTab !== "terminal") return;
    const frame = requestAnimationFrame(() => {
      getActiveHandle()?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state.bottomPanelTab, activeTabId]);

  return (
    <div className="flex flex-col h-full" data-testid="terminal-multi-root">
      <TerminalTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={closeTab}
        onAddLocal={() => {
          createLocalTab();
        }}
        onAddRemote={openRemoteDialog}
        onClear={() => getActiveHandle()?.clear()}
      />

      {showRemoteDialog && (
        <TerminalRemoteDialog
          target={remoteTarget}
          validationError={remoteValidationError}
          onTargetChange={(target) => {
            setRemoteTarget(target);
            setRemoteValidationError("");
          }}
          onCancel={closeRemoteDialog}
          onConfirm={confirmRemoteDialog}
        />
      )}

      <div className="flex-1 min-h-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              display: tab.id === activeTabId ? "flex" : "none",
              width: "100%",
              height: "100%",
            }}
          >
            <TerminalSession
              ref={(instance) => {
                sessionRefs.current[tab.id] = instance;
              }}
              active={tab.id === activeTabId}
              shellPath={tab.shellPath}
              loadProfile={tab.loadProfile}
              startupCommand={tab.startupCommand}
              theme={consoleTheme}
              fontFamily={consoleFontFamily}
              fontSize={consoleFontSize}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
