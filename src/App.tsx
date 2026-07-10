/** PSForge main application component with full layout. */

import React, { useEffect, useCallback, useRef } from "react";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkForAppUpdate } from "@tauri-apps/plugin-updater";
import { AppProvider, useAppState, newTabId, untitledCounter } from "./store";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar";
import { EditorPane } from "./components/EditorPane";
import { OutputPane } from "./components/OutputPane";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardShortcutPanel } from "./components/KeyboardShortcutPanel";
import { AboutDialog } from "./components/AboutDialog";
import { ScriptSigningDialog } from "./components/ScriptSigningDialog";
import { ParamPromptDialog } from "./components/ParamPromptDialog";
import * as cmd from "./commands";
import { basename, dirname } from "./path-utils";
import {
  getBookmarksForPath,
  getBreakpointsForPath,
  setBookmarksForPath,
  setBreakpointsForPath,
} from "./path-state-store";
import {
  FULL_PASTE_SANITIZE_OPTIONS,
  sanitizePastedTextWithSummary,
} from "./sanitize-paste";
import { formatPasteSummaryMessage } from "./paste-summary";
import { copyDebugBundleWithRunOutput } from "./debug-bundle";
import { showAppToast, ToastStack } from "./components/ToastStack";
import {
  extractInvokeErrorMessage,
  platformHomeFallback,
  resolveExecutionWorkDirWithOverride,
} from "./run-utils";
import {
  copyLastRunOutputToClipboard,
  copyTerminalOutputToClipboard,
} from "./terminal-utils";
import {
  scratchPathForTab,
  isScratchBackedTab,
  isUntitledScratchCandidate,
  recoveredScratchTitle,
} from "./scratch-utils";
import { mergeRecentFilePaths } from "./script-utils";
import { findProjectConfig, applyProjectConfig } from "./project-config";
import { useExecutionActions } from "./use-execution-actions";
import { PssaRunGateDialog } from "./components/PssaRunGateDialog";
import {
  ScratchRecoveryDialog,
  type ScratchRecoveryCandidate,
} from "./components/ScratchRecoveryDialog";
import {
  CloseScratchDialog,
  type CloseScratchChoice,
} from "./components/CloseScratchDialog";
import type {
  EditorTab,
  ScriptRunRecord,
  AppSettings,
  PsVersion,
  UpdateStatus,
} from "./types";

// Expose the startup reveal function injected by public/preload.js.
declare global {
  interface Window {
    /** Called once by React after first mount to remove the FOUC loading mask. */
    __psforgeReveal?: () => void;
  }
}

const SPLIT_RESIZER_HEIGHT_PX = 4;
const MIN_EDITOR_PANE_HEIGHT_PX = 180;
const MIN_BOTTOM_PANE_HEIGHT_PX = 150;
const HARD_MIN_SPLIT_PERCENT = 8;
const HARD_MAX_SPLIT_PERCENT = 92;
const SPLIT_EPSILON = 0.1;
const PS7_INSTALL_URL = "https://aka.ms/install-powershell";
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_STATUS_RESET_MS = 8_000;

type AvailableAppUpdate = NonNullable<
  Awaited<ReturnType<typeof checkForAppUpdate>>
>;

function clampSplitPercentForHeight(
  percent: number,
  containerHeight: number,
): number {
  const safePercent = Number.isFinite(percent) ? percent : 65;
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    return Math.max(
      HARD_MIN_SPLIT_PERCENT,
      Math.min(HARD_MAX_SPLIT_PERCENT, safePercent),
    );
  }
  const availableHeight = Math.max(
    1,
    containerHeight - SPLIT_RESIZER_HEIGHT_PX,
  );
  const minPercent = Math.max(
    HARD_MIN_SPLIT_PERCENT,
    (MIN_EDITOR_PANE_HEIGHT_PX / availableHeight) * 100,
  );
  const maxPercent = Math.min(
    HARD_MAX_SPLIT_PERCENT,
    100 - (MIN_BOTTOM_PANE_HEIGHT_PX / availableHeight) * 100,
  );
  if (minPercent > maxPercent) {
    return 50;
  }
  return Math.max(minPercent, Math.min(maxPercent, safePercent));
}

function isPs7OrNewer(version: PsVersion): boolean {
  const path = version.path.toLowerCase();
  if (path.endsWith("\\pwsh.exe") || path.endsWith("/pwsh.exe")) return true;
  const major = Number.parseInt(version.version, 10);
  if (Number.isFinite(major) && major >= 7) return true;
  return version.name.toLowerCase().includes("powershell 7");
}

/** Inner app that has access to the store. */
function AppInner() {
  const { state, dispatch, activeTab } = useAppState();
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitPercent, setSplitPercent] = React.useState(
    state.settings.splitPosition,
  );
  const [showPs7Banner, setShowPs7Banner] = React.useState(false);
  const [ps7BannerDismissedSession, setPs7BannerDismissedSession] =
    React.useState(false);
  const [psVersionRefreshInFlight, setPsVersionRefreshInFlight] =
    React.useState(false);
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatus>({
    phase: "idle",
  });
  const isDragging = useRef(false);
  /** Tracks the live split position during a drag so onMouseUp reads the
   *  final position, not the stale value captured at drag-start. */
  const splitPercentRef = useRef(state.settings.splitPosition);
  const activeTabRef = useRef<EditorTab | undefined>(activeTab);
  const cursorLineRef = useRef(state.cursorLine);
  const bookmarksRef = useRef(state.bookmarks);
  const availableUpdateRef =
    useRef<Awaited<ReturnType<typeof checkForAppUpdate>>>(null);
  const updateStatusResetTimerRef = useRef<number | null>(null);
  const autoUpdateCheckStartedRef = useRef(false);
  const scratchDirRef = useRef("");
  const scratchSaveTimersRef = useRef<Map<string, number>>(new Map());
  const scratchRecoveryCheckedRef = useRef(false);
  const runWorkingDirOverrideRef = useRef<string | null>(null);
  const [closeScratchPrompt, setCloseScratchPrompt] = React.useState<{
    tab: EditorTab;
    allowCloseLast: boolean;
    resolve: (closed: boolean) => void;
  } | null>(null);
  const [scratchRecoveryCandidates, setScratchRecoveryCandidates] =
    React.useState<ScratchRecoveryCandidate[] | null>(null);
  const clampSplitForCurrentLayout = useCallback(
    (nextPercent: number): number => {
      const containerHeight =
        splitRef.current?.getBoundingClientRect().height ?? window.innerHeight;
      const clamped = clampSplitPercentForHeight(nextPercent, containerHeight);
      setSplitPercent(clamped);
      splitPercentRef.current = clamped;
      return clamped;
    },
    [],
  );

  const hasPs7 = state.psVersions.some(isPs7OrNewer);

  const refreshPsVersions = useCallback(async () => {
    if (psVersionRefreshInFlight) return;
    setPsVersionRefreshInFlight(true);
    try {
      const versions = await cmd.getPsVersions();
      dispatch({ type: "SET_PS_VERSIONS", versions });

      let nextPath = "";
      if (versions.length > 0) {
        if (
          state.settings.defaultPsVersion &&
          state.settings.defaultPsVersion !== "auto"
        ) {
          const preferred = versions.find(
            (v) => v.path === state.settings.defaultPsVersion,
          );
          if (preferred) {
            nextPath = preferred.path;
          } else if (versions.some((v) => v.path === state.selectedPsPath)) {
            nextPath = state.selectedPsPath;
          } else {
            nextPath = versions[0].path;
          }
        } else {
          // Auto mode: always pick the highest-priority discovered shell.
          nextPath = versions[0].path;
        }
      }
      dispatch({ type: "SET_SELECTED_PS", path: nextPath });
    } catch {
      // Best-effort refresh; keep current shell selection on failure.
    } finally {
      setPsVersionRefreshInFlight(false);
    }
  }, [
    psVersionRefreshInFlight,
    dispatch,
    state.settings.defaultPsVersion,
    state.selectedPsPath,
  ]);

  useEffect(() => {
    if (!state.settingsLoaded) return;
    const onlyWindowsPowerShell = state.psVersions.length > 0 && !hasPs7;
    if (
      !onlyWindowsPowerShell ||
      state.settings.showPs7InstallReminder === false
    ) {
      setShowPs7Banner(false);
      setPs7BannerDismissedSession(false);
      return;
    }
    setShowPs7Banner(!ps7BannerDismissedSession);
  }, [
    state.settingsLoaded,
    state.psVersions,
    state.settings.showPs7InstallReminder,
    hasPs7,
    ps7BannerDismissedSession,
  ]);

  const openPs7InstallPage = useCallback(() => {
    setPs7BannerDismissedSession(true);
    setShowPs7Banner(false);
    openUrl(PS7_INSTALL_URL).catch(() => {});
  }, []);

  const dismissPs7BannerForSession = useCallback(() => {
    setPs7BannerDismissedSession(true);
    setShowPs7Banner(false);
  }, []);

  const disablePs7Reminder = useCallback(() => {
    setPs7BannerDismissedSession(true);
    setShowPs7Banner(false);
    const updated = {
      ...state.settings,
      showPs7InstallReminder: false,
    };
    dispatch({ type: "SET_SETTINGS", settings: updated });
    cmd.saveSettings(updated).catch(() => {});
  }, [dispatch, state.settings]);

  const clearPendingUpdate = useCallback(() => {
    const pending = availableUpdateRef.current;
    availableUpdateRef.current = null;
    if (pending) {
      void pending.close().catch(() => {});
    }
  }, []);

  const clearUpdateStatusResetTimer = useCallback(() => {
    if (updateStatusResetTimerRef.current !== null) {
      window.clearTimeout(updateStatusResetTimerRef.current);
      updateStatusResetTimerRef.current = null;
    }
  }, []);

  const scheduleUpdateStatusReset = useCallback(() => {
    clearUpdateStatusResetTimer();
    updateStatusResetTimerRef.current = window.setTimeout(() => {
      setUpdateStatus((prev) =>
        prev.phase === "upToDate" || prev.phase === "error"
          ? { phase: "idle" }
          : prev,
      );
      updateStatusResetTimerRef.current = null;
    }, UPDATE_STATUS_RESET_MS);
  }, [clearUpdateStatusResetTimer]);

  useEffect(() => {
    return () => {
      clearUpdateStatusResetTimer();
      clearPendingUpdate();
    };
  }, [clearPendingUpdate, clearUpdateStatusResetTimer]);

  const downloadAndInstallUpdate = useCallback(
    async (update: AvailableAppUpdate) => {
      clearUpdateStatusResetTimer();
      let downloadedBytes = 0;
      let totalBytes = 0;
      setUpdateStatus({
        phase: "downloading",
        version: update.version,
        downloadedBytes,
        totalBytes,
      });

      try {
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              downloadedBytes = 0;
              totalBytes = event.data.contentLength ?? 0;
              setUpdateStatus({
                phase: "downloading",
                version: update.version,
                downloadedBytes,
                totalBytes,
              });
              break;
            case "Progress":
              downloadedBytes += event.data.chunkLength;
              setUpdateStatus({
                phase: "downloading",
                version: update.version,
                downloadedBytes,
                totalBytes,
              });
              break;
            case "Finished":
              setUpdateStatus({ phase: "installing", version: update.version });
              break;
          }
        });

        clearPendingUpdate();
        setUpdateStatus({ phase: "installing", version: update.version });
        await relaunch();
      } catch (err) {
        clearPendingUpdate();
        setUpdateStatus({
          phase: "error",
          message: extractInvokeErrorMessage(err),
        });
        scheduleUpdateStatusReset();
      }
    },
    [clearPendingUpdate, clearUpdateStatusResetTimer, scheduleUpdateStatusReset],
  );

  const checkForUpdates = useCallback(
    async (initiatedByUser: boolean) => {
      if (
        updateStatus.phase === "checking" ||
        updateStatus.phase === "downloading" ||
        updateStatus.phase === "installing"
      ) {
        return;
      }

      clearUpdateStatusResetTimer();
      setUpdateStatus({ phase: "checking" });

      try {
        const update = await checkForAppUpdate({
          timeout: UPDATE_CHECK_TIMEOUT_MS,
        });
        clearPendingUpdate();
        availableUpdateRef.current = update;

        if (!update) {
          if (initiatedByUser) {
            setUpdateStatus({ phase: "upToDate" });
            scheduleUpdateStatusReset();
          } else {
            setUpdateStatus({ phase: "idle" });
          }
          return;
        }

        if (!initiatedByUser) {
          void downloadAndInstallUpdate(update);
          return;
        }

        setUpdateStatus({
          phase: "available",
          version: update.version,
          notes: update.body ?? "",
          date: update.date,
        });
      } catch (err) {
        clearPendingUpdate();
        const message = extractInvokeErrorMessage(err);
        if (initiatedByUser) {
          setUpdateStatus({ phase: "error", message });
          scheduleUpdateStatusReset();
        } else {
          console.warn("Automatic update check failed:", err);
          setUpdateStatus({ phase: "idle" });
        }
      }
    },
    [
      clearPendingUpdate,
      clearUpdateStatusResetTimer,
      downloadAndInstallUpdate,
      scheduleUpdateStatusReset,
      updateStatus.phase,
    ],
  );

  const installAvailableUpdate = useCallback(async () => {
    const update = availableUpdateRef.current;
    if (!update) return;

    const releaseNotes = update.body?.trim();
    const confirmLines = [
      `PSForge ${update.version} is available.`,
      "",
      "Install it now?",
      "",
      "PSForge will download the signed installer from GitHub Releases.",
      "The app will restart automatically when the update finishes.",
    ];
    if (releaseNotes) {
      confirmLines.push("", "Release notes:", releaseNotes);
    }

    let confirmed = false;
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      confirmed = await confirm(confirmLines.join("\n"), {
        title: "PSForge Update",
        kind: "info",
        okLabel: "Install",
        cancelLabel: "Later",
      });
    } catch {
      confirmed = false;
    }
    if (!confirmed) return;

    await downloadAndInstallUpdate(update);
  }, [downloadAndInstallUpdate]);

  useEffect(() => {
    if (autoUpdateCheckStartedRef.current) return;
    if (!state.settingsLoaded) return;
    if (import.meta.env.DEV) return;
    if (state.settings.checkForUpdatesOnStartup === false) return;

    autoUpdateCheckStartedRef.current = true;
    void checkForUpdates(false);
  }, [
    checkForUpdates,
    state.settings.checkForUpdatesOnStartup,
    state.settingsLoaded,
  ]);

  useEffect(() => {
    cursorLineRef.current = state.cursorLine;
  }, [state.cursorLine]);

  useEffect(() => {
    bookmarksRef.current = state.bookmarks;
  }, [state.bookmarks]);

  const runCommandInTerminal = useCallback(
    async (
      command: string,
      options?: {
        clearBeforeRun?: boolean;
        reveal?: boolean;
      },
    ) => {
      const runFn = (window as unknown as Record<string, unknown>)
        .__psforge_terminal_run_command as
        | ((
            scriptCommand: string,
            runOptions?: {
              clearBeforeRun?: boolean;
              reveal?: boolean;
            },
          ) => Promise<number | null>)
        | undefined;
      if (!runFn) {
        throw new Error("Integrated terminal bridge is not ready.");
      }
      return runFn(command, options);
    },
    [],
  );

  const writeTerminalNotice = useCallback(
    async (text: string, options?: { reveal?: boolean }) => {
      const writeFn = (window as unknown as Record<string, unknown>)
        .__psforge_terminal_write_notice as
        | ((
            terminalText: string,
            writeOptions?: { reveal?: boolean },
          ) => Promise<void>)
        | undefined;
      if (!writeFn) return;
      await writeFn(text.endsWith("\n") ? text : `${text}\n`, options);
    },
    [],
  );

  const interruptTerminalCommand = useCallback(() => {
    const interruptFn = (window as unknown as Record<string, unknown>)
      .__psforge_terminal_interrupt as (() => void) | undefined;
    interruptFn?.();
  }, []);

  // Remove the startup loading mask once React has successfully mounted.
  // This completes the white-flash prevention sequence started by preload.js
  // and the `html.psforge-loading body { opacity: 0 }` CSS rule in index.html.
  // We also emit `psforge-ready` on the Tauri event bus so the Rust setup
  // hook can show the OS window in response to actual paint readiness rather
  // than a hard-coded 200 ms timer (which is either too short on slow boxes
  // or wastes time on fast ones).
  useEffect(() => {
    if (typeof window.__psforgeReveal === "function") {
      window.__psforgeReveal();
    }
    void emit("psforge-ready").catch(() => {
      // Best-effort signal. If this fails the safety-net timer in lib.rs
      // will reveal the window after 3 s.
    });
  }, []);

  const openFile = useCallback(
    async (specificPath?: string) => {
      try {
        let selected: string | null = specificPath ?? null;

        if (!selected) {
          // No specific path provided -- open the system file picker.
          const { open } = await import("@tauri-apps/plugin-dialog");
          const result = await open({
            multiple: false,
            filters: [
              {
                name: "PowerShell Files",
                extensions: ["ps1", "psm1", "psd1", "ps1xml", "pssc", "cdxml"],
              },
              { name: "All Files", extensions: ["*"] },
            ],
          });
          if (result && typeof result === "string") {
            selected = result;
          }
        }

        if (!selected) return;

        // Activate the tab if the file is already open.
        const existing = state.tabs.find((t) => t.filePath === selected);
        if (existing) {
          dispatch({ type: "SET_ACTIVE_TAB", id: existing.id });
          return;
        }

        const fileData = await cmd.readFileContent(selected);
        const fileName = basename(selected);
        const id = newTabId();
        const tab: EditorTab = {
          id,
          title: fileName,
          filePath: selected,
          content: fileData.content,
          savedContent: fileData.content,
          encoding: fileData.encoding,
          language: "powershell",
          isDirty: false,
          tabType: "code",
        };
        dispatch({ type: "ADD_TAB", tab });

        // Reattach bookmarks/breakpoints saved for this file path during a
        // previous session. The path-keyed store survives close/reopen of
        // file-backed tabs, where the original tab-id-keyed state is wiped
        // by CLOSE_TAB. Lookup is case-insensitive on Windows so the same
        // file accessed through differently-cased paths shares one set.
        const restoredBookmarks = getBookmarksForPath(selected);
        if (restoredBookmarks && restoredBookmarks.length > 0) {
          dispatch({
            type: "SET_BOOKMARKS",
            tabId: id,
            lines: restoredBookmarks,
          });
        }
        const restoredBreakpoints = getBreakpointsForPath(selected);
        if (restoredBreakpoints && restoredBreakpoints.length > 0) {
          dispatch({
            type: "SET_BREAKPOINTS",
            tabId: id,
            breakpoints: restoredBreakpoints,
          });
        }

        // Surface backend decode warnings (odd-byte UTF-16, Windows-1252
        // fallback) via the integrated terminal so the user can choose to
        // re-save in UTF-8 if the legacy encoding will cause issues.
        if (fileData.warning) {
          void writeTerminalNotice(
            `[PSForge] ${fileName}: ${fileData.warning}`,
            { reveal: false },
          );
        }

        // Set working directory to file's directory.
        const dir = dirname(selected);
        if (dir) dispatch({ type: "SET_WORKING_DIR", dir });

        let nextSettings = { ...state.settings };
        const project = await findProjectConfig(selected);
        if (project) {
          nextSettings = applyProjectConfig(nextSettings, project.config);
        }

        // Update recent files list, respecting maxRecentFiles setting.
        const maxRecent = nextSettings.maxRecentFiles ?? 20;
        const recent = mergeRecentFilePaths(
          nextSettings.recentFiles,
          [selected],
          maxRecent,
        );
        dispatch({
          type: "SET_SETTINGS",
          settings: { ...nextSettings, recentFiles: recent },
        });
      } catch (err) {
        console.error("openFile failed:", err);
        void writeTerminalNotice(
          `[PSForge] Open failed: ${extractInvokeErrorMessage(err)}`,
          { reveal: true },
        );
      }
    },
    [state.tabs, state.settings, dispatch, writeTerminalNotice],
  );

  // Open the file passed as a CLI argument when the app was launched via a
  // Windows file-type association (e.g. double-click on a .ps1 file in Explorer).
  // Gated on settingsLoaded: openFile dispatches SET_SETTINGS derived from the
  // settings its closure captured, so running it before the real settings load
  // would clobber them with defaults (and the debounced save would persist
  // that). The ref latches so it still runs exactly once.
  const launchPathHandledRef = useRef(false);
  useEffect(() => {
    if (launchPathHandledRef.current || !state.settingsLoaded) return;
    launchPathHandledRef.current = true;
    cmd
      .getLaunchPath()
      .then((path) => {
        if (path) void openFile(path);
      })
      .catch((err) => console.error("getLaunchPath failed:", err));
  }, [state.settingsLoaded, openFile]);

  const openScriptFolder = useCallback(async () => {
    try {
      const { open, message } = await import("@tauri-apps/plugin-dialog");
      const { readDir } = await import("@tauri-apps/plugin-fs");
      const selected = await open({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") return;

      const base = selected.replace(/[/\\]+$/, "");
      const entries = await readDir(selected);
      const scriptPaths = entries
        .filter((entry) => entry.isFile)
        .map((entry) => `${base}/${entry.name}`.replace(/\\/g, "/"))
        .filter((path) => /\.(ps1|psm1|psd1)$/i.test(path))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      if (scriptPaths.length === 0) {
        await message(
          "No PowerShell scripts (.ps1, .psm1, .psd1) were found in that folder.",
          { title: "Open Folder", kind: "info" },
        );
        return;
      }

      for (const path of scriptPaths.slice(0, 12)) {
        await openFile(path);
      }
      if (scriptPaths.length > 12) {
        await writeTerminalNotice(
          `[PSForge] Opened the first 12 scripts from the folder (${scriptPaths.length} total).`,
          { reveal: false },
        );
      }
      dispatch({ type: "SET_WORKING_DIR", dir: selected });

      const project = await findProjectConfig(
        scriptPaths[0] ?? `${base}/.psforge.json`,
      );
      if (project) {
        dispatch({
          type: "SET_SETTINGS",
          settings: applyProjectConfig(state.settings, project.config),
        });
      }
    } catch (err) {
      console.error("openScriptFolder failed:", err);
      await writeTerminalNotice(
        `[PSForge] Open folder failed: ${extractInvokeErrorMessage(err)}`,
        { reveal: true },
      );
    }
  }, [openFile, dispatch, writeTerminalNotice, state.settings]);

  /** Open (or focus) the Welcome tab so users can restore onboarding content. */
  const openWelcomePage = useCallback(() => {
    const existing = state.tabs.find((t) => t.tabType === "welcome");
    if (existing) {
      dispatch({ type: "SET_ACTIVE_TAB", id: existing.id });
      return;
    }

    const id = newTabId();
    dispatch({
      type: "ADD_TAB",
      tab: {
        id,
        title: "Welcome",
        filePath: "",
        content: "",
        savedContent: "",
        encoding: "utf8",
        language: "markdown",
        isDirty: false,
        tabType: "welcome",
      },
    });
  }, [state.tabs, dispatch]);

  // Register window globals so WelcomePane and other components can trigger
  // file-open actions without prop-threading through the full component tree.
  // Must be declared after openFile to satisfy declaration order rules.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    // User-facing helpers: the WelcomePane and CommandPalette read these.
    w.__psforge_openFile = () => void openFile();
    w.__psforge_openFileByPath = (p: string) => void openFile(p);
    w.__psforge_openFolder = () => void openScriptFolder();
    w.__psforge_openWelcome = () => openWelcomePage();
    // E2E-only helpers. We expose `dispatch` and `reset_variables` only in
    // dev builds so production users cannot stumble onto them via the
    // WebView devtools or accidentally come to depend on a hook surface
    // that is meant for the test harness alone.
    if (import.meta.env.DEV) {
      w.__psforge_dispatch = dispatch;
      w.__psforge_reset_variables = () =>
        dispatch({ type: "SET_VARIABLES", variables: [] });
    }
    return () => {
      delete w.__psforge_openFile;
      delete w.__psforge_openFileByPath;
      delete w.__psforge_openWelcome;
      delete w.__psforge_dispatch;
      delete w.__psforge_reset_variables;
    };
  }, [openFile, openWelcomePage, dispatch]);

  const {
    paramPrompt,
    pssaGatePrompt,
    saveTab,
    saveCurrentFile,
    saveAllFiles,
    runScript,
    startDebugSession,
    runOrDebugScript,
    runSelection,
    stopExecution,
    debugContinue,
    debugStepOver,
    debugStepInto,
    debugStepOut,
    evaluateDebugWatch,
    refreshDebugInspector,
    selectDebugFrame,
  } = useExecutionActions({
    state,
    dispatch,
    activeTab,
    activeTabRef,
    scratchDirRef,
    runWorkingDirOverrideRef,
    runCommandInTerminal,
    writeTerminalNotice,
    interruptTerminalCommand,
  });

  const finalizeCloseTab = useCallback(
    async (
      tab: EditorTab,
      choice: CloseScratchChoice,
      allowCloseLast: boolean,
    ): Promise<boolean> => {
      const scratchDir = scratchDirRef.current;
      const scratchPath =
        scratchDir && (isUntitledScratchCandidate(tab) || isScratchBackedTab(tab, scratchDir))
          ? tab.filePath || scratchPathForTab(scratchDir, tab.id)
          : tab.filePath;

      if (choice === "cancel") return false;

      // Keep the pending scratch auto-save alive while Save As is open. If the
      // user cancels the picker (or the save fails), the tab remains open and
      // still needs its recovery copy updated.
      let savedPath: string | undefined;
      if (choice === "save-as") {
        const result = await saveTab(tab);
        if (!result.saved) return false;
        savedPath = result.path;
      }

      // Cancel any pending scratch auto-save for this tab so a late debounced
      // write can't resurrect content the user is discarding/closing (S3-16).
      const pendingTimer = scratchSaveTimersRef.current.get(tab.id);
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        scratchSaveTimersRef.current.delete(tab.id);
      }

      if (choice === "save-as") {
        if (scratchPath && savedPath && savedPath !== scratchPath) {
          try {
            await cmd.deleteScratchFile(scratchPath);
          } catch {
            // best-effort cleanup
          }
        }
      } else if (choice === "discard" && scratchPath) {
        try {
          await cmd.deleteScratchFile(scratchPath);
        } catch {
          // ignore missing scratch file
        }
      }

      if (state.tabs.length > 1 || allowCloseLast) {
        dispatch({ type: "CLOSE_TAB", id: tab.id });
      }
      return true;
    },
    [dispatch, saveTab, state.tabs.length],
  );

  const requestCloseTab = useCallback(
    async (tabId: string, allowCloseLast = false): Promise<boolean> => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab || (!allowCloseLast && state.tabs.length <= 1)) return false;

      const scratchDir = scratchDirRef.current;
      const isScratchTab =
        tab.isDirty &&
        (isUntitledScratchCandidate(tab) ||
          (scratchDir ? isScratchBackedTab(tab, scratchDir) : false));

      if (isScratchTab) {
        return new Promise((resolve) => {
          setCloseScratchPrompt({
            tab,
            allowCloseLast,
            resolve: (closed) => resolve(closed),
          });
        });
      }

      if (tab.isDirty) {
        const confirmMessage = `"${tab.title}" has unsaved changes.\n\nClose without saving?`;
        let confirmed = false;
        try {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          confirmed = await confirm(confirmMessage, {
            title: "PSForge",
            kind: "warning",
            okLabel: "Close",
            cancelLabel: "Cancel",
          });
        } catch {
          confirmed = false;
        }
        if (!confirmed) return false;
      }

      dispatch({ type: "CLOSE_TAB", id: tab.id });
      return true;
    },
    [dispatch, state.tabs],
  );

  /** Close the active tab, mirroring tab-bar close confirmation semantics. */
  const closeActiveTab = useCallback(async () => {
    if (!activeTab || state.tabs.length <= 1) return;
    await requestCloseTab(activeTab.id);
  }, [activeTab, state.tabs.length, requestCloseTab]);

  /** Activate the next/previous tab by offset (+1 next, -1 previous). */
  const activateRelativeTab = useCallback(
    (offset: number) => {
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex(
        (t) => t.id === state.activeTabId,
      );
      if (currentIndex === -1) return;
      const nextIndex =
        (currentIndex + offset + state.tabs.length) % state.tabs.length;
      dispatch({ type: "SET_ACTIVE_TAB", id: state.tabs[nextIndex].id });
    },
    [state.tabs, state.activeTabId, dispatch],
  );

  const rerunFromRecord = useCallback(
    async (run: ScriptRunRecord) => {
      if (run.scriptPath) {
        await openFile(run.scriptPath);
      } else {
        const match = state.tabs.find(
          (t) => t.tabType !== "welcome" && t.title === run.tabTitle,
        );
        if (match) {
          dispatch({ type: "SET_ACTIVE_TAB", id: match.id });
        }
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      if (run.workingDir?.trim()) {
        runWorkingDirOverrideRef.current = run.workingDir.trim();
      }
      await runScript();
    },
    [openFile, runScript, state.tabs, dispatch],
  );

  const clearRecentRuns = useCallback(() => {
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, recentRuns: [] },
    });
  }, [dispatch, state.settings]);

  const copyDebugBundle = useCallback(async () => {
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome") {
      void writeTerminalNotice(
        "[PSForge] Open a script tab before copying a debug bundle.",
        { reveal: false },
      );
      return;
    }
    const workDir = resolveExecutionWorkDirWithOverride(
      tab,
      state.workingDir,
      state.settings,
      platformHomeFallback,
    );
    const copied = await copyDebugBundleWithRunOutput({
      tab,
      lastRun: state.lastRunResult,
      workingDir: workDir,
      problems: state.problems[tab.id] ?? [],
      getRunOutput: () => "",
    });
    if (copied) {
      showAppToast("Debug bundle copied — paste into your AI chat.");
    } else {
      void writeTerminalNotice(
        "[PSForge] Nothing to copy yet. Run the script with F5 first.",
        { reveal: true },
      );
    }
  }, [
    state.workingDir,
    state.settings,
    state.lastRunResult,
    state.problems,
    writeTerminalNotice,
  ]);

  const recoverScratchFiles = useCallback(
    async (selected: ScratchRecoveryCandidate[]) => {
      for (const candidate of selected) {
        const existing = state.tabs.find((t) => t.id === candidate.tabId);
        if (existing) {
          dispatch({ type: "SET_ACTIVE_TAB", id: existing.id });
          continue;
        }
        try {
          const file = await cmd.readFileContent(candidate.path);
          // Keep a friendly Untitled-N title; scratch path is internal backing
          // only (same rule as auto-save / TabBar display, S3-17).
          const tab: EditorTab = {
            id: candidate.tabId,
            title: recoveredScratchTitle(untitledCounter()),
            filePath: candidate.path,
            content: file.content,
            savedContent: file.content,
            encoding: file.encoding,
            language: "powershell",
            isDirty: true,
            tabType: "code",
          };
          dispatch({ type: "ADD_TAB", tab });
        } catch {
          // Surface the failure instead of silently dropping the candidate, so
          // the user isn't left with a confirm that appears to do nothing (S3-31).
          void writeTerminalNotice(
            `[PSForge] Could not recover scratch file: ${basename(candidate.path)}`,
            { reveal: false },
          );
        }
      }
      setScratchRecoveryCandidates(null);
    },
    [dispatch, state.tabs, writeTerminalNotice],
  );

  /** Format the active script using PSScriptAnalyzer Invoke-Formatter (Shift+Alt+F). */
  const formatCurrentScript = useCallback(async () => {
    if (!activeTab || activeTab.tabType === "welcome" || !state.selectedPsPath)
      return;
    try {
      const formatted = await cmd.formatScript(
        state.selectedPsPath,
        activeTab.content,
      );
      if (formatted !== activeTab.content) {
        dispatch({
          type: "UPDATE_TAB",
          id: activeTab.id,
          changes: {
            content: formatted,
            isDirty: formatted !== activeTab.savedContent,
          },
        });
      }
    } catch (err) {
      console.error("formatCurrentScript failed:", err);
      void writeTerminalNotice(
        `[PSForge] Format failed: ${extractInvokeErrorMessage(err)}`,
        { reveal: true },
      );
    }
  }, [activeTab, state.selectedPsPath, dispatch, writeTerminalNotice]);

  /**
   * Read clipboard, clean web/terminal junk, insert at the selection, then
   * format the whole script with Invoke-Formatter (Ctrl+Shift+Alt+V).
   */
  const pasteCleanAndFormat = useCallback(async () => {
    if (!activeTab || activeTab.tabType === "welcome" || !state.selectedPsPath) {
      return;
    }
    let clip = "";
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      void writeTerminalNotice(
        "[PSForge] Could not read the clipboard. Allow clipboard access or paste with Ctrl+V (clean on paste is still applied).",
        { reveal: true },
      );
      return;
    }
    if (!clip.trim()) return;

    const { text: cleaned, summary } = sanitizePastedTextWithSummary(
      clip,
      FULL_PASTE_SANITIZE_OPTIONS,
    );
    showAppToast(formatPasteSummaryMessage(summary));
    const w = window as unknown as Record<string, unknown>;
    const insert = w.__psforge_insertTextAtSelection as
      | ((text: string) => boolean)
      | undefined;
    if (!insert?.(cleaned)) return;

    const buffer =
      (w.__psforge_getEditorText as (() => string) | undefined)?.() ??
      activeTab.content;
    try {
      const formatted = await cmd.formatScript(state.selectedPsPath, buffer);
      if (formatted !== buffer) {
        dispatch({
          type: "UPDATE_TAB",
          id: activeTab.id,
          changes: {
            content: formatted,
            isDirty: formatted !== activeTab.savedContent,
          },
        });
      }
    } catch (err) {
      console.error("pasteCleanAndFormat failed:", err);
      void writeTerminalNotice(
        "[PSForge] Paste was cleaned but formatting failed. Install PSScriptAnalyzer or use Shift+Alt+F.",
        { reveal: true },
      );
    }

    if (state.settings.runAfterPasteCleanFormat !== false) {
      runOrDebugScript();
    }
  }, [
    activeTab,
    state.selectedPsPath,
    state.settings.runAfterPasteCleanFormat,
    dispatch,
    writeTerminalNotice,
    runOrDebugScript,
  ]);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_pasteCleanAndFormat = () => {
      void pasteCleanAndFormat();
    };
    return () => {
      delete w.__psforge_pasteCleanAndFormat;
    };
  }, [pasteCleanAndFormat]);

  const pasteFromClipboardAsNewScript = useCallback(async () => {
    if (!state.selectedPsPath) return;
    let clip = "";
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      void writeTerminalNotice(
        "[PSForge] Could not read the clipboard. Allow clipboard access and try again.",
        { reveal: true },
      );
      return;
    }
    if (!clip.trim()) return;

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
    dispatch({ type: "ADD_TAB", tab });
    const welcomeTab = state.tabs.find((t) => t.tabType === "welcome");
    if (welcomeTab) {
      dispatch({ type: "CLOSE_TAB", id: welcomeTab.id });
    }

    if (state.settings.runAfterPasteCleanFormat !== false) {
      window.setTimeout(() => runOrDebugScript(), 50);
    }
  }, [
    state.selectedPsPath,
    state.tabs,
    state.settings.runAfterPasteCleanFormat,
    dispatch,
    writeTerminalNotice,
    runOrDebugScript,
  ]);

  useEffect(() => {
    void cmd.getScratchDir().then((dir) => {
      scratchDirRef.current = dir;
      dispatch({ type: "SET_SCRATCH_DIR", dir });
    });
  }, [dispatch]);

  useEffect(() => {
    if (!state.settingsLoaded || scratchRecoveryCheckedRef.current) return;
    scratchRecoveryCheckedRef.current = true;

    void (async () => {
      try {
        const files = await cmd.listScratchFiles();
        const openIds = new Set(state.tabs.map((t) => t.id));
        const orphans = files
          .filter((f) => !openIds.has(f.tabId))
          .map((f) => ({ tabId: f.tabId, path: f.path }));
        if (orphans.length > 0) {
          setScratchRecoveryCandidates(orphans);
        }
      } catch {
        // scratch recovery is best-effort
      }
    })();
  }, [state.settingsLoaded, state.tabs]);

  useEffect(() => {
    if (
      !state.settingsLoaded ||
      state.settings.autoSaveScratchScripts === false
    ) {
      return;
    }
    const scratchDir = scratchDirRef.current;
    if (!scratchDir) return;

    const activeCandidates = new Set<string>();
    for (const tab of state.tabs) {
      if (tab.tabType === "welcome" || !tab.isDirty) continue;
      // Untitled tabs and tabs already backed by a scratch file both need
      // continuous protection; skipping any tab with a filePath made the
      // auto-save a one-shot — everything typed after the first save was
      // never written to disk again (S6-1).
      if (tab.filePath && !isScratchBackedTab(tab, scratchDir)) continue;
      activeCandidates.add(tab.id);

      const existing = scratchSaveTimersRef.current.get(tab.id);
      if (existing) window.clearTimeout(existing);

      const timer = window.setTimeout(() => {
        scratchSaveTimersRef.current.delete(tab.id);
        const path = scratchPathForTab(scratchDir, tab.id);
        void cmd
          .saveFileContent(path, tab.content, tab.encoding)
          .then(() => {
            dispatch({
              type: "UPDATE_TAB",
              id: tab.id,
              changes: {
                // Do NOT overwrite the friendly "Untitled-N" title with the
                // UUID-based scratch filename — this is an internal backing
                // store, not a user-chosen save location (S3-17).
                filePath: path,
                savedContent: tab.content,
                isDirty: false,
              },
            });
          })
          .catch(() => {});
      }, 1200);
      scratchSaveTimersRef.current.set(tab.id, timer);
    }

    // Cancel timers for tabs that are no longer autosave candidates (closed,
    // discarded, or reverted to clean) so a discarded scratch is not written
    // to disk after the fact and resurrected on next launch (S3-16).
    for (const [id, timer] of scratchSaveTimersRef.current) {
      if (!activeCandidates.has(id)) {
        window.clearTimeout(timer);
        scratchSaveTimersRef.current.delete(id);
      }
    }
  }, [
    state.tabs,
    state.settings.autoSaveScratchScripts,
    state.settingsLoaded,
    dispatch,
  ]);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_pasteFromClipboardAsNewScript = () => {
      void pasteFromClipboardAsNewScript();
    };
    w.__psforge_copy_terminal_output = async () => {
      const copied = await copyTerminalOutputToClipboard();
      if (!copied) {
        void writeTerminalNotice(
          "[PSForge] Nothing to copy from the terminal.",
          { reveal: false },
        );
      }
    };
    w.__psforge_copy_last_run_output = async () => {
      const copied = await copyLastRunOutputToClipboard();
      if (!copied) {
        void writeTerminalNotice(
          "[PSForge] No run output to copy yet. Run a script with F5 first.",
          { reveal: false },
        );
      }
    };
    w.__psforge_requestCloseTab = (tabId: string, allowCloseLast?: boolean) =>
      requestCloseTab(tabId, allowCloseLast);
    w.__psforge_rerunFromRecord = (run: ScriptRunRecord) => {
      void rerunFromRecord(run);
    };
    w.__psforge_clearRecentRuns = () => clearRecentRuns();
    w.__psforge_openRunDirectory = (dir: string) => {
      if (dir.trim()) void cmd.revealInExplorer(dir.trim());
    };
    w.__psforge_copy_debug_bundle = () => {
      void copyDebugBundle();
    };
    return () => {
      delete w.__psforge_pasteFromClipboardAsNewScript;
      delete w.__psforge_copy_terminal_output;
      delete w.__psforge_copy_last_run_output;
      delete w.__psforge_requestCloseTab;
      delete w.__psforge_rerunFromRecord;
      delete w.__psforge_clearRecentRuns;
      delete w.__psforge_openRunDirectory;
      delete w.__psforge_copy_debug_bundle;
    };
  }, [
    pasteFromClipboardAsNewScript,
    writeTerminalNotice,
    requestCloseTab,
    rerunFromRecord,
    clearRecentRuns,
    copyDebugBundle,
  ]);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_afterPasteSanitized = () => {
      if (state.settings.runAfterSanitizedPaste === true) {
        runOrDebugScript();
      }
    };
    return () => {
      delete w.__psforge_afterPasteSanitized;
    };
  }, [runOrDebugScript, state.settings.runAfterSanitizedPaste]);


  /** Open the current user's $PROFILE script for editing, creating it if absent. */
  const openProfile = useCallback(async () => {
    if (!state.selectedPsPath) return;
    try {
      const profilePath = await cmd.getPsProfilePath(state.selectedPsPath);
      // Ensure the profile file exists before opening (getPsProfilePath creates the dir).
      try {
        await cmd.readFileContent(profilePath);
      } catch {
        // File doesn't exist yet -- create an empty profile script.
        await cmd.saveFileContent(profilePath, "", "utf8");
      }
      await openFile(profilePath);
    } catch (err) {
      console.error("openProfile failed:", err);
    }
  }, [state.selectedPsPath, openFile]);

  /** Print the active script content in a new browser window. */
  const printScript = useCallback(() => {
    if (!activeTab || !activeTab.content) return;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) {
      // window.open returns null when the WebView blocks the popup
      // (rare but possible under strict Chromium flags). Surface it via
      // the integrated terminal so the user is not left wondering why
      // nothing happened when they hit Print.
      void writeTerminalNotice(
        "[PSForge] Could not open the print preview window. " +
          "If the issue persists, copy the script to another editor and print from there.",
        { reveal: true },
      );
      return;
    }
    const escapeHtml = (value: string) =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escaped = escapeHtml(activeTab.content);
    const title = activeTab.title || "Script";
    const safeTitle = escapeHtml(title);
    w.document.write(
      `<!DOCTYPE html><html><head><title>${safeTitle}</title>` +
        `<style>body{font-family:Consolas,'Courier New',monospace;font-size:10pt;` +
        `margin:2cm}pre{white-space:pre-wrap;word-break:break-all}` +
        `@page{margin:2cm}h2{font-size:12pt;margin-bottom:8px}</style>` +
        `</head><body><h2>${safeTitle}</h2><pre>${escaped}</pre></body></html>`,
    );
    w.document.close();
    w.print();
  }, [activeTab, writeTerminalNotice]);

  const toggleBookmarkAtCursor = useCallback(() => {
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome") return;
    dispatch({
      type: "TOGGLE_BOOKMARK",
      tabId: tab.id,
      line: Math.max(1, cursorLineRef.current || 1),
    });
  }, [dispatch]);

  const jumpToBookmark = useCallback((direction: 1 | -1) => {
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome") return;
    const lines = bookmarksRef.current[tab.id] ?? [];
    if (lines.length === 0) return;

    const currentLine = Math.max(1, cursorLineRef.current || 1);
    let targetLine = lines[0];
    if (direction > 0) {
      targetLine = lines.find((line) => line > currentLine) ?? lines[0];
    } else {
      targetLine =
        [...lines].reverse().find((line) => line < currentLine) ??
        lines[lines.length - 1];
    }

    const nav = (window as unknown as Record<string, unknown>)
      .__psforge_navigateTo as
      | ((line: number, column: number) => void)
      | undefined;
    nav?.(targetLine, 1);
  }, []);

  // Keyboard shortcuts
  // Placed AFTER all useCallback declarations so TypeScript can see each
  // captured function's type.  The dependency array keeps the listener
  // stable: it is only replaced when one of the captured values changes,
  // not on every render (which would cause constant DOM listener churn).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Normalise letter shortcuts for Caps Lock. With Caps Lock on,
      // `e.key` for "n" becomes "N", so direct character comparisons
      // (e.key === "n") silently fail to match. Compare against the
      // lower-cased value below for every alphabetic shortcut.
      const keyLower = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Ctrl+N: New tab
      if (e.ctrlKey && keyLower === "n") {
        e.preventDefault();
        const id = newTabId();
        const tab: EditorTab = {
          id,
          title: `Untitled-${untitledCounter()}`,
          filePath: "",
          content: "",
          savedContent: "",
          encoding: "utf8",
          language: "powershell",
          isDirty: false,
          tabType: "code",
        };
        dispatch({ type: "ADD_TAB", tab });
      }

      // Ctrl+O: Open file
      if (e.ctrlKey && keyLower === "o") {
        e.preventDefault();
        openFile();
      }

      // Ctrl+S: Save current file
      if (e.ctrlKey && !e.shiftKey && keyLower === "s") {
        e.preventDefault();
        void saveCurrentFile();
      }

      // Ctrl+Shift+S: Save all files (ISE parity)
      if (e.ctrlKey && e.shiftKey && keyLower === "s") {
        e.preventDefault();
        void saveAllFiles();
      }

      // F5: Run script (or start debug if the active tab has breakpoints)
      if (e.key === "F5" && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        runOrDebugScript();
      }

      // Shift+F5: Stop current run/debug session
      if (e.key === "F5" && e.shiftKey) {
        e.preventDefault();
        stopExecution();
      }

      // F10/F11/Shift+F11: Debug step controls while paused.
      if (e.key === "F10") {
        e.preventDefault();
        void debugStepOver();
      }
      if (e.key === "F11" && !e.shiftKey) {
        e.preventDefault();
        void debugStepInto();
      }
      if (e.key === "F11" && e.shiftKey) {
        e.preventDefault();
        void debugStepOut();
      }

      // F8: Run selection, or current line when no selection (ISE behavior)
      if (e.key === "F8") {
        e.preventDefault();
        runSelection();
      }

      // F9: Toggle line breakpoint at the current cursor location.
      if (e.key === "F9" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const tab = activeTabRef.current;
        if (!tab || tab.tabType === "welcome") return;
        dispatch({
          type: "TOGGLE_BREAKPOINT",
          tabId: tab.id,
          line: Math.max(1, cursorLineRef.current || 1),
        });
        dispatch({ type: "SET_BOTTOM_TAB", tab: "debugger" });
      }

      // Ctrl+F2: Toggle bookmark on the current line.
      if (e.key === "F2" && e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleBookmarkAtCursor();
      }

      // F2 / Shift+F2: Jump to next/previous bookmark.
      if (e.key === "F2" && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        jumpToBookmark(e.shiftKey ? -1 : 1);
      }

      // Ctrl+Break: Stop running script
      // NOTE: Ctrl+C is intentionally NOT intercepted here because it must
      // remain available for clipboard copy at all times.  Ctrl+Break is the
      // canonical ISE stop shortcut and does not conflict with copy.
      if (e.ctrlKey && e.key === "Pause") {
        e.preventDefault();
        stopExecution();
      }

      // Ctrl+Shift+P: Command palette
      if (e.ctrlKey && e.shiftKey && keyLower === "p") {
        e.preventDefault();
        dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "all" });
      }

      // Ctrl+W: close active tab.
      if (e.ctrlKey && !e.shiftKey && keyLower === "w") {
        e.preventDefault();
        void closeActiveTab();
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: cycle through open tabs.
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        activateRelativeTab(e.shiftKey ? -1 : 1);
      }

      // Ctrl+J: ISE-style snippets picker
      if (e.ctrlKey && !e.shiftKey && !e.altKey && keyLower === "j") {
        e.preventDefault();
        dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "snippets" });
      }

      // Ctrl+Shift+C: Open Show Command tab.
      if (e.ctrlKey && e.shiftKey && keyLower === "c") {
        e.preventDefault();
        dispatch({ type: "SET_BOTTOM_TAB", tab: "show-command" });
      }

      // F1: Context-sensitive help for selected token/command.
      if (e.key === "F1" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const query =
          (
            (window as unknown as Record<string, unknown>)
              .__psforge_getHelpQuery as (() => string) | undefined
          )?.() ?? "";
        dispatch({ type: "SET_BOTTOM_TAB", tab: "help" });
        window.dispatchEvent(
          new CustomEvent("psforge-help-request", { detail: { query } }),
        );
      }

      // Ctrl+F1: Keyboard shortcut reference panel
      if (e.key === "F1" && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_SHORTCUT_PANEL" });
      }

      // Ctrl+,: Settings
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_SETTINGS" });
      }

      // Ctrl+B: Toggle sidebar
      if (e.ctrlKey && keyLower === "b") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_SIDEBAR" });
      }

      // Ctrl+H: Find & Replace (focus Monaco and trigger built-in action)
      if (e.ctrlKey && keyLower === "h") {
        e.preventDefault();
        const trigger = (window as unknown as Record<string, unknown>)
          .__psforge_triggerFindReplace as (() => void) | undefined;
        trigger?.();
      }

      // Shift+Alt+F: Format document with Invoke-Formatter
      if (e.shiftKey && e.altKey && keyLower === "f") {
        e.preventDefault();
        void formatCurrentScript();
      }

      // Ctrl+Shift+Alt+V: Paste from clipboard, clean, then format.
      // On the Welcome tab (or with no tab) the paste lands in a new script tab.
      if (e.ctrlKey && e.shiftKey && e.altKey && keyLower === "v") {
        e.preventDefault();
        if (!activeTab || activeTab.tabType === "welcome") {
          void pasteFromClipboardAsNewScript();
        } else {
          void pasteCleanAndFormat();
        }
      }

      // Ctrl+G: Go to line (focus Monaco and trigger built-in action)
      if (e.ctrlKey && keyLower === "g") {
        e.preventDefault();
        const trigger = (window as unknown as Record<string, unknown>)
          .__psforge_triggerGoToLine as (() => void) | undefined;
        trigger?.();
      }

      // Ctrl+= or Ctrl+Plus: Increase editor font size. linkEditorOutputFonts
      // governs font FAMILY only, not size, so the terminal size is left alone
      // (S3-20) — consistent with the status-bar +/- control.
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        const next = Math.min(72, (state.settings.fontSize ?? 14) + 1);
        dispatch({
          type: "SET_SETTINGS",
          settings: {
            ...state.settings,
            fontSize: next,
          },
        });
      }

      // Ctrl+- (Minus): Decrease editor font size (terminal size untouched, S3-20).
      if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        const next = Math.max(8, (state.settings.fontSize ?? 14) - 1);
        dispatch({
          type: "SET_SETTINGS",
          settings: {
            ...state.settings,
            fontSize: next,
          },
        });
      }
    };

    // Use capture phase so shortcuts (notably F1) are seen even when focus is
    // inside Monaco or a nested interactive element.
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [
    state.tabs.length,
    state.isRunning,
    state.isDebugging,
    state.debugPaused,
    state.settings,
    dispatch,
    openFile,
    saveCurrentFile,
    saveAllFiles,
    closeActiveTab,
    activateRelativeTab,
    runOrDebugScript,
    debugContinue,
    debugStepOver,
    debugStepInto,
    debugStepOut,
    stopExecution,
    runSelection,
    formatCurrentScript,
    pasteCleanAndFormat,
    pasteFromClipboardAsNewScript,
    activeTab,
    toggleBookmarkAtCursor,
    jumpToBookmark,
  ]);

  // Mirror tab-keyed bookmarks/breakpoints to the path-keyed store for every
  // file-backed tab. This keeps a path-indexed copy in sync so closing the
  // tab and opening the same file later (within or across sessions) restores
  // the markers. Tabs without `filePath` are intentionally skipped — there's
  // no stable identity to key against.
  //
  // The "seen tabs" refs are a defence-in-depth guard: we skip the mirror on
  // the very first effect run for each tab id so that an ADD_TAB which (in
  // some pathological future React batching scenario) lands in a different
  // render tick from its sibling SET_BOOKMARKS / SET_BREAKPOINTS restoration
  // cannot overwrite valid path-store data with the empty initial state.
  // Subsequent runs mirror normally — including legitimate clears (toggling
  // off the last bookmark) which then also delete the path-store entry.
  // Each mirror gets its own ref because the two effects run independently
  // and one shouldn't be able to "see" the other into skipping its work.
  const seenBookmarkTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const tab of state.tabs) {
      if (!tab.filePath) continue;
      const lines = state.bookmarks[tab.id] ?? [];
      if (!seenBookmarkTabsRef.current.has(tab.id)) {
        seenBookmarkTabsRef.current.add(tab.id);
        // First sighting: skip the mirror only if it would clobber existing
        // path-store data with empty live state (defends against a future
        // batching change where ADD_TAB renders before the openFile flow's
        // SET_BOOKMARKS restoration). Non-empty live state on first sight
        // is still mirrored — that's the Save As path, where an untitled
        // tab with bookmarks just gained a filePath and should immediately
        // start persisting under it.
        if (lines.length === 0) {
          const existing = getBookmarksForPath(tab.filePath);
          if (existing && existing.length > 0) continue;
        }
      }
      setBookmarksForPath(tab.filePath, lines);
    }
  }, [state.tabs, state.bookmarks]);

  const seenBreakpointTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const tab of state.tabs) {
      if (!tab.filePath) continue;
      const breakpoints = state.breakpoints[tab.id] ?? [];
      if (!seenBreakpointTabsRef.current.has(tab.id)) {
        seenBreakpointTabsRef.current.add(tab.id);
        if (breakpoints.length === 0) {
          const existing = getBreakpointsForPath(tab.filePath);
          if (existing && existing.length > 0) continue;
        }
      }
      setBreakpointsForPath(tab.filePath, breakpoints);
    }
  }, [state.tabs, state.breakpoints]);

  // Sync local state from persisted settings the first time they load from
  // disk.  Without this, split/sidebar always start at DEFAULT_SETTINGS values.
  useEffect(() => {
    if (!state.settingsLoaded) return;
    clampSplitForCurrentLayout(state.settings.splitPosition);
    // Restore sidebar visibility and position from persisted settings.
    if (!state.settings.sidebarVisible && state.sidebarVisible) {
      dispatch({ type: "TOGGLE_SIDEBAR" });
    } else if (state.settings.sidebarVisible && !state.sidebarVisible) {
      dispatch({ type: "TOGGLE_SIDEBAR" });
    }
    if (
      state.settings.sidebarPosition &&
      state.settings.sidebarPosition !== state.sidebarPosition
    ) {
      dispatch({
        type: "SET_SIDEBAR_POSITION",
        position: state.settings.sidebarPosition as "left" | "right",
      });
    }
    // Only run once when settingsLoaded transitions to true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.settingsLoaded, clampSplitForCurrentLayout]);

  // Persist sidebar visibility and position whenever they change.
  // Save is done immediately (bypassing the 1-second debounce) so that the
  // state is never lost even if the user closes the app right after toggling.
  useEffect(() => {
    if (!state.settingsLoaded) return;
    if (
      state.settings.sidebarVisible === state.sidebarVisible &&
      state.settings.sidebarPosition === state.sidebarPosition
    )
      return;
    const updated = {
      ...state.settings,
      sidebarVisible: state.sidebarVisible,
      sidebarPosition: state.sidebarPosition,
    };
    dispatch({ type: "SET_SETTINGS", settings: updated });
    // Immediate (non-debounced) write so layout state survives a fast exit.
    cmd.saveSettings(updated).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sidebarVisible, state.sidebarPosition]);

  // BUG-NEW-4 fix: track latest settings in a ref so onMouseUp always reads
  // the most-current settings, not the snapshot captured when onMouseDown was
  // last created.  Without this, a concurrent debounced-settings-save that
  // completes during a drag would be silently overwritten on mouse-up.
  const currentSettingsRef = useRef(state.settings);
  currentSettingsRef.current = state.settings;

  useEffect(() => {
    const container = splitRef.current;
    if (!container) return;
    if (typeof ResizeObserver === "undefined") return;
    let rafId: number | null = null;
    let lastObservedHeight = 0;
    const reconcile = () => {
      rafId = null;
      const rect = container.getBoundingClientRect();
      // Only act when the container height materially changed; otherwise the
      // ResizeObserver can fire because of our own setSplitPercent (which
      // re-renders sibling panes and re-triggers the observer), creating a
      // visible jitter loop on some Chromium versions.
      if (Math.abs(rect.height - lastObservedHeight) < 0.5) return;
      lastObservedHeight = rect.height;
      const current = splitPercentRef.current;
      const clamped = clampSplitPercentForHeight(current, rect.height);
      if (Math.abs(clamped - current) > SPLIT_EPSILON) {
        setSplitPercent(clamped);
        splitPercentRef.current = clamped;
      }
    };
    const scheduleReconcile = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(reconcile);
    };
    // Force the first reconcile regardless of last-observed height.
    lastObservedHeight = 0;
    scheduleReconcile();
    const observer = new ResizeObserver(scheduleReconcile);
    observer.observe(container);
    window.addEventListener("resize", scheduleReconcile);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", scheduleReconcile);
    };
  }, []);

  // Vertical split drag handler
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current || !splitRef.current) return;
        const rect = splitRef.current.getBoundingClientRect();
        const pct = ((ev.clientY - rect.top) / rect.height) * 100;
        const clamped = clampSplitPercentForHeight(pct, rect.height);
        setSplitPercent(clamped);
        // Keep the ref current so onMouseUp reads the final position, not the
        // stale value captured when onMouseDown was invoked.
        splitPercentRef.current = clamped;
      };

      const onMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        // Read both refs (always current) to avoid using any stale closure values.
        dispatch({
          type: "SET_SETTINGS",
          settings: {
            ...currentSettingsRef.current,
            splitPosition: splitPercentRef.current,
          },
        });
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    // state.settings removed from deps: we read currentSettingsRef.current in
    // onMouseUp so the callback does not need to be recreated on every settings
    // change (which would happen on every output line, cursor move, etc.).
    [dispatch],
  );

  return (
    <div
      data-testid="app-root"
      className="flex flex-col h-full w-full min-h-0 min-w-0 no-select"
      onDragOver={(e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Tauri exposes the native file system path on each File object.
        // Open every dropped file so dragging a selection of scripts in
        // (the obvious power-user gesture) doesn't silently skip all but
        // the first. Files are opened sequentially to keep the recent-files
        // list and tab order deterministic.
        const files = Array.from(e.dataTransfer.files) as Array<
          File & { path?: string }
        >;
        const paths = files
          .map((f) => f.path)
          .filter((p): p is string => typeof p === "string" && !!p);
        if (paths.length === 0) return;
        (async () => {
          for (const path of paths) {
            await openFile(path);
          }
        })().catch(() => {});
      }}
    >
      {/* Toolbar */}
      <Toolbar
        onNew={() => {
          const id = newTabId();
          dispatch({
            type: "ADD_TAB",
            tab: {
              id,
              title: `Untitled-${untitledCounter()}`,
              filePath: "",
              content: "",
              savedContent: "",
              encoding: "utf8",
              language: "powershell",
              isDirty: false,
              tabType: "code",
            },
          });
        }}
        onOpen={() => void openFile()}
        onOpenRecent={(path) => void openFile(path)}
        onOpenFolder={() => void openScriptFolder()}
        onSave={() => void saveCurrentFile()}
        onSaveAll={() => void saveAllFiles()}
        onRun={runOrDebugScript}
        onDebugStart={startDebugSession}
        onDebugContinue={debugContinue}
        onStop={stopExecution}
        onFormat={formatCurrentScript}
        onPasteScript={() => {
          // From the Welcome tab (or no tab) the paste lands in a fresh script
          // tab; with a code tab open it pastes into the current selection.
          if (!activeTab || activeTab.tabType === "welcome") {
            void pasteFromClipboardAsNewScript();
          } else {
            void pasteCleanAndFormat();
          }
        }}
        onCopyDebugBundle={() => void copyDebugBundle()}
        onFindReplace={() => {
          const trigger = (window as unknown as Record<string, unknown>)
            .__psforge_triggerFindReplace as (() => void) | undefined;
          trigger?.();
        }}
        onOpenProfile={() => void openProfile()}
        onPrint={printScript}
        onSign={() => dispatch({ type: "TOGGLE_SIGNING_DIALOG" })}
        onCheckForUpdates={() => void checkForUpdates(true)}
      />

      {showPs7Banner && (
        <div
          data-testid="ps7-install-banner"
          className="flex items-center justify-between gap-3 px-3 py-2"
          style={{
            backgroundColor: "var(--bg-secondary)",
            borderTop: "1px solid var(--border-primary)",
            borderBottom: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
            fontFamily: "var(--ui-font-family)",
            fontSize: "var(--ui-font-size-sm)",
          }}
        >
          <div className="min-w-0">
            <div style={{ fontWeight: 600 }}>
              PowerShell 7 not detected. PSForge is using Windows PowerShell
              5.1.
            </div>
            <div style={{ color: "var(--text-secondary)" }}>
              Install PS7 for better module compatibility, performance, and
              modern features.
            </div>
          </div>
          <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
            <button onClick={openPs7InstallPage} className="btn btn-primary btn-sm">
              Install
            </button>
            <button
              onClick={() => void refreshPsVersions()}
              disabled={psVersionRefreshInFlight}
              className="btn btn-ghost btn-sm"
              style={{ border: "1px solid var(--border-primary)" }}
            >
              {psVersionRefreshInFlight ? "Rescanning..." : "Rescan"}
            </button>
            <button
              onClick={dismissPs7BannerForSession}
              className="btn btn-ghost btn-sm"
              style={{ border: "1px solid var(--border-primary)" }}
            >
              Not now
            </button>
            <button
              onClick={disablePs7Reminder}
              className="btn btn-ghost btn-sm"
              style={{ border: "1px solid var(--border-primary)" }}
            >
              Don&apos;t remind again
            </button>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        {state.sidebarVisible && state.sidebarPosition === "left" && (
          <Sidebar />
        )}

        {/* Editor + Output */}
        <div
          ref={splitRef}
          className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden"
        >
          {/* Tab bar */}
          <TabBar />

          {/* Editor pane */}
          <div
            data-testid="editor-container"
            style={{ height: `${splitPercent}%` }}
            className="relative min-h-0 overflow-hidden"
          >
            <EditorPane />
          </div>

          {/* Resizer */}
          <div className="resizer-h" onMouseDown={onMouseDown} />

          {/* Bottom panel */}
          <div
            style={{ height: `${100 - splitPercent}%` }}
            className="min-h-0 overflow-hidden"
          >
            <OutputPane
              onDebugStart={startDebugSession}
              onDebugContinue={debugContinue}
              onDebugStepOver={debugStepOver}
              onDebugStepInto={debugStepInto}
              onDebugStepOut={debugStepOut}
              onDebugSelectFrame={(frameIndex) =>
                void selectDebugFrame(frameIndex)
              }
              onDebugRefreshInspector={() => void refreshDebugInspector()}
              onDebugEvaluateWatch={(expression) =>
                void evaluateDebugWatch(expression)
              }
              onStop={stopExecution}
            />
          </div>
        </div>

        {state.sidebarVisible && state.sidebarPosition === "right" && (
          <Sidebar />
        )}
      </div>

      {/* Status bar */}
      <StatusBar
        updateStatus={updateStatus}
        onCheckForUpdates={() => void checkForUpdates(true)}
        onInstallUpdate={() => void installAvailableUpdate()}
      />

      {/* Modals */}
      {state.settingsOpen && <SettingsPanel />}
      {state.commandPaletteOpen && <CommandPalette />}
      <KeyboardShortcutPanel />
      {state.showAbout && <AboutDialog />}
      {state.showSigningDialog && <ScriptSigningDialog />}
      {/* Mandatory-parameter prompt -- shown before a run when the script
          declares params that need values (Rule 17 pre-flight). */}
      {paramPrompt && (
        <ParamPromptDialog
          params={paramPrompt.params}
          onConfirm={(values) => paramPrompt.resolve(values)}
          onCancel={() => paramPrompt.resolve(null)}
        />
      )}
      {pssaGatePrompt && (
        <PssaRunGateDialog
          errors={pssaGatePrompt.errors}
          onRunAnyway={() => pssaGatePrompt.resolve(true)}
          onCancel={() => pssaGatePrompt.resolve(false)}
          onViewProblems={() => {
            dispatch({
              type: "SET_BOTTOM_TAB",
              tab: "reference",
              referenceSubview: "problems",
            });
            pssaGatePrompt.resolve(false);
          }}
        />
      )}
      {closeScratchPrompt && (
        <CloseScratchDialog
          tabTitle={closeScratchPrompt.tab.title}
          onChoice={(choice) => {
            void (async () => {
              const closed =
                choice === "cancel"
                  ? false
                  : await finalizeCloseTab(
                      closeScratchPrompt.tab,
                      choice,
                      closeScratchPrompt.allowCloseLast,
                    );
              closeScratchPrompt.resolve(closed);
              setCloseScratchPrompt(null);
            })();
          }}
        />
      )}
      {scratchRecoveryCandidates && scratchRecoveryCandidates.length > 0 && (
        <ScratchRecoveryDialog
          candidates={scratchRecoveryCandidates}
          onRecover={(selected) => void recoverScratchFiles(selected)}
          onDismiss={() => setScratchRecoveryCandidates(null)}
        />
      )}
      <ToastStack />
    </div>
  );
}

/** Root App component wrapping everything in the store provider. */
export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
