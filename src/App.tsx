/** PSForge main application component with full layout. */

import React, { useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
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
import type { OutputLine, EditorTab, ScriptParameter } from "./types";

// Expose the startup reveal function injected by public/preload.js.
declare global {
  interface Window {
    /** Called once by React after first mount to remove the FOUC loading mask. */
    __psforgeReveal?: () => void;
  }
}

// ---------------------------------------------------------------------------
// Parameter injection helpers
// ---------------------------------------------------------------------------

/**
 * Builds native PowerShell script arguments from prompt values.
 *
 * We pass these args after `-File` so PowerShell binds them against the
 * script's own param() block. This preserves script parse semantics
 * (including begin/process/end blocks) by executing the original script text
 * unchanged.
 */
function buildScriptArgs(
  params: ScriptParameter[],
  paramValues: Record<string, string>,
): string[] {
  const args: string[] = [];
  for (const param of params) {
    const raw = paramValues[param.name] ?? "";
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    const typeName = param.typeName.toLowerCase();
    const isSwitch =
      typeName === "switchparameter" ||
      typeName.endsWith(".switchparameter") ||
      typeName === "switch";

    if (isSwitch) {
      if (lower === "false" || lower === "0" || lower === "no") {
        args.push(`-${param.name}:$false`);
      } else {
        // Empty input from the prompt means "present" for switches.
        args.push(`-${param.name}`);
      }
      continue;
    }

    if (lower === "true" || lower === "false") {
      args.push(`-${param.name}:$${lower}`);
      continue;
    }

    args.push(`-${param.name}`);
    args.push(trimmed);
  }
  return args;
}

/** Inner app that has access to the store. */
function AppInner() {
  const { state, dispatch, activeTab } = useAppState();
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitPercent, setSplitPercent] = React.useState(
    state.settings.splitPosition,
  );
  const isDragging = useRef(false);
  /** Tracks the live split position during a drag so onMouseUp reads the
   *  final position, not the stale value captured at drag-start. */
  const splitPercentRef = useRef(state.settings.splitPosition);
  /** Synchronous guard against double-execution.
   *  React state updates from dispatch are asynchronous, so a rapid second
   *  F5 press can read stale `state.isRunning === false` from the closure.
   *  This ref is set to `true` synchronously before dispatch, preventing the
   *  second invocation from passing the guard check. */
  const runGuardRef = useRef(false);

  /**
   * Pending parameter-prompt state.  When a script has mandatory parameters
   * without defaults, runScript populates this before setting isRunning so
   * the ParamPromptDialog appears.  The resolve callback advances or cancels
   * the run; this keeps the control flow linear inside runScript.
   */
  const [paramPrompt, setParamPrompt] = React.useState<{
    params: ScriptParameter[];
    resolve: (values: Record<string, string> | null) => void;
  } | null>(null);

  // Remove the startup loading mask once React has successfully mounted.
  // This completes the white-flash prevention sequence started by preload.js
  // and the `html.psforge-loading body { opacity: 0 }` CSS rule in index.html.
  useEffect(() => {
    if (typeof window.__psforgeReveal === "function") {
      window.__psforgeReveal();
    }
  }, []);

  // Open the file passed as a CLI argument when the app was launched via a
  // Windows file-type association (e.g. double-click on a .ps1 file in Explorer).
  // Called once on mount; getLaunchPath() returns null for normal launches.
  useEffect(() => {
    cmd
      .getLaunchPath()
      .then((path) => {
        if (path) void openFile(path);
      })
      .catch((err) => console.error("getLaunchPath failed:", err));
    // openFile is stable (useCallback with stable deps on mount); run once only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for ps-output events from Rust backend
  useEffect(() => {
    const unlisten = listen<OutputLine>("ps-output", (event) => {
      dispatch({ type: "ADD_OUTPUT", line: event.payload });
    });

    // Show exit code in output for non-zero exits so the user knows the script
    // failed even if the error message was already scrolled past.
    const unlistenComplete = listen<number>("ps-complete", (event) => {
      const code = event.payload;
      if (code !== 0) {
        dispatch({
          type: "ADD_OUTPUT",
          line: {
            stream: "stderr",
            text: `Process exited with code ${code}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
          },
        });
      }
      // Clear the synchronous run guard so subsequent runs are possible.
      runGuardRef.current = false;
      dispatch({ type: "SET_RUNNING", running: false });
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
    };
  }, [dispatch]);

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
        const fileName = selected.split("\\").pop() || selected;
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

        // Set working directory to file's directory.
        const dir = selected.substring(0, selected.lastIndexOf("\\"));
        if (dir) dispatch({ type: "SET_WORKING_DIR", dir });

        // Update recent files list, respecting maxRecentFiles setting.
        const maxRecent = state.settings.maxRecentFiles ?? 20;
        const recent = [
          selected,
          ...state.settings.recentFiles.filter((f) => f !== selected),
        ].slice(0, maxRecent);
        dispatch({
          type: "SET_SETTINGS",
          settings: { ...state.settings, recentFiles: recent },
        });
      } catch (err) {
        // File open failed -- log for diagnostics but don't crash.
        console.error("openFile failed:", err);
      }
    },
    [state.tabs, state.settings, dispatch],
  );

  // Register window globals so WelcomePane and other components can trigger
  // file-open actions without prop-threading through the full component tree.
  // Must be declared after openFile to satisfy declaration order rules.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_openFile = () => void openFile();
    w.__psforge_openFileByPath = (p: string) => void openFile(p);
    /** Expose dispatch for E2E tests that need to trigger state changes
     *  (e.g. open the signing dialog on a tab without a saved file path). */
    w.__psforge_dispatch = dispatch;
    /**
     * E2E test helper: reset the variables inspector to an empty state.
     * Allows tests to establish a known-empty condition without restarting
     * the app when the full test suite runs in a shared browser session.
     */
    w.__psforge_reset_variables = () =>
      dispatch({ type: "SET_VARIABLES", variables: [] });
    return () => {
      delete w.__psforge_openFile;
      delete w.__psforge_openFileByPath;
      delete w.__psforge_dispatch;
      delete w.__psforge_reset_variables;
    };
  }, [openFile, dispatch]);

  const mergeRecentFiles = useCallback(
    (existing: string[], savedPaths: string[]) => {
      const maxRecent = state.settings.maxRecentFiles ?? 20;
      let next = [...existing];
      for (const path of savedPaths) {
        next = [path, ...next.filter((f) => f !== path)];
      }
      return next.slice(0, maxRecent);
    },
    [state.settings.maxRecentFiles],
  );

  const saveTab = useCallback(
    async (tab: EditorTab): Promise<{ saved: boolean; cancelled: boolean; path?: string }> => {
      let filePath = tab.filePath;

      if (!filePath) {
        // Save As dialog for untitled tabs.
        try {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const selected = await save({
            filters: [
              {
                name: "PowerShell Files",
                extensions: ["ps1", "psm1", "psd1", "ps1xml", "pssc", "cdxml"],
              },
              { name: "All Files", extensions: ["*"] },
            ],
          });
          if (selected) {
            filePath = selected;
          } else {
            return { saved: false, cancelled: true };
          }
        } catch {
          return { saved: false, cancelled: true };
        }
      }

      try {
        await cmd.saveFileContent(filePath, tab.content, tab.encoding);
        const fileName = filePath.split("\\").pop() || filePath;
        dispatch({
          type: "UPDATE_TAB",
          id: tab.id,
          changes: {
            filePath,
            title: fileName,
            savedContent: tab.content,
            isDirty: false,
          },
        });

        // Update working directory to the most recently saved file location.
        const dir = filePath.substring(0, filePath.lastIndexOf("\\"));
        if (dir) {
          dispatch({ type: "SET_WORKING_DIR", dir });
        }

        return { saved: true, cancelled: false, path: filePath };
      } catch (err) {
        console.error(`saveTab failed for "${tab.title}":`, err);
        return { saved: false, cancelled: false };
      }
    },
    [dispatch],
  );

  const saveCurrentFile = useCallback(async () => {
    if (!activeTab || activeTab.tabType === "welcome") return;
    const result = await saveTab(activeTab);
    if (!result.saved || !result.path) return;

    const recent = mergeRecentFiles(state.settings.recentFiles, [result.path]);
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, recentFiles: recent },
    });
  }, [activeTab, saveTab, mergeRecentFiles, state.settings, dispatch]);

  const saveAllFiles = useCallback(async () => {
    // Save all code tabs that are dirty OR unsaved (untitled).
    const targets = state.tabs.filter(
      (tab) => tab.tabType !== "welcome" && (tab.isDirty || !tab.filePath),
    );
    if (targets.length === 0) return;

    // Save existing-path tabs first so one unsaved-tab Save-As cancel does not
    // prevent already-named files from being written.
    const withPath = targets.filter((tab) => !!tab.filePath);
    const withoutPath = targets.filter((tab) => !tab.filePath);
    const orderedTargets = [...withPath, ...withoutPath];

    const savedPaths: string[] = [];
    for (const tab of orderedTargets) {
      const result = await saveTab(tab);
      if (result.cancelled) {
        break;
      }
      if (result.saved && result.path) {
        savedPaths.push(result.path);
      }
    }

    if (savedPaths.length > 0) {
      const recent = mergeRecentFiles(state.settings.recentFiles, savedPaths);
      dispatch({
        type: "SET_SETTINGS",
        settings: { ...state.settings, recentFiles: recent },
      });
    }
  }, [state.tabs, state.settings, saveTab, mergeRecentFiles, dispatch]);

  /** Close the active tab, mirroring tab-bar close confirmation semantics. */
  const closeActiveTab = useCallback(() => {
    if (!activeTab || state.tabs.length <= 1) return;
    if (activeTab.isDirty) {
      const confirmed = window.confirm(
        `"${activeTab.title}" has unsaved changes.\n\nClose without saving?`,
      );
      if (!confirmed) return;
    }
    dispatch({ type: "CLOSE_TAB", id: activeTab.id });
  }, [activeTab, state.tabs.length, dispatch]);

  /** Activate the next/previous tab by offset (+1 next, -1 previous). */
  const activateRelativeTab = useCallback(
    (offset: number) => {
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      if (currentIndex === -1) return;
      const nextIndex =
        (currentIndex + offset + state.tabs.length) % state.tabs.length;
      dispatch({ type: "SET_ACTIVE_TAB", id: state.tabs[nextIndex].id });
    },
    [state.tabs, state.activeTabId, dispatch],
  );

  const runScript = useCallback(async () => {
    // BUG-NEW-2 fix: welcome tabs have no runnable content; guard here so
    // F5 does not submit an empty script. The Run button is also disabled
    // for welcome tabs (see Toolbar.tsx).
    if (!activeTab || activeTab.tabType === "welcome" || state.isRunning) {
      return;
    }

    if (!state.selectedPsPath) {
      dispatch({
        type: "ADD_OUTPUT",
        line: {
          stream: "stderr",
          text: "Run failed: no PowerShell executable is selected.",
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      });
      return;
    }

    // Synchronous guard: prevents a rapid second F5 from slipping through
    // before React applies the SET_RUNNING dispatch from the first invocation.
    if (runGuardRef.current) return;
    runGuardRef.current = true;

    // Auto-save before running when the setting is enabled (Rule 11 -- pre-flight).
    if (
      state.settings.autoSaveOnRun &&
      activeTab.isDirty &&
      activeTab.filePath
    ) {
      try {
        await cmd.saveFileContent(
          activeTab.filePath,
          activeTab.content,
          activeTab.encoding,
        );
        dispatch({
          type: "UPDATE_TAB",
          id: activeTab.id,
          changes: { savedContent: activeTab.content, isDirty: false },
        });
      } catch {
        // Save failed -- continue running with unsaved content
      }
    }

    // Snapshot execution parameters before any async gap so closures below
    // always use the values that were active at the moment Run was pressed.
    const psPath = state.selectedPsPath;
    const scriptContent = activeTab.content;

    // Determine working directory early (needed even if param dialog cancels).
    let workDir: string;
    if (
      state.settings.workingDirMode === "custom" &&
      state.settings.customWorkingDir
    ) {
      workDir = state.settings.customWorkingDir;
    } else {
      workDir =
        state.workingDir ||
        (activeTab.filePath
          ? activeTab.filePath.substring(
              0,
              activeTab.filePath.lastIndexOf("\\"),
            )
          : "C:\\") ||
        "C:\\";
    }

    // ------------------------------------------------------------------
    // Mandatory-parameter pre-flight (Rule 17).
    // Before starting execution, inspect the script's param() block.  If
    // any mandatory parameters lack defaults, show the ParamPromptDialog
    // so the user can supply values rather than letting the script fail
    // with a cryptic "missing mandatory parameter" error.
    // ------------------------------------------------------------------
    let scriptArgs: string[] = [];
    try {
      const allParams = await cmd.getScriptParameters(psPath, scriptContent);
      const required = allParams.filter((p) => p.isMandatory && !p.hasDefault);

      if (required.length > 0) {
        // Wait for the user to either supply values or cancel.
        const paramValues = await new Promise<Record<string, string> | null>(
          (resolve) => {
            setParamPrompt({ params: required, resolve });
          },
        );
        // Always clear the dialog state once the promise resolves.
        setParamPrompt(null);

        if (paramValues === null) {
          // User cancelled -- abort the run and release the guard.
          runGuardRef.current = false;
          return;
        }

        // Execute the original script text unchanged and pass parameters as
        // native PowerShell script arguments (after -File).
        scriptArgs = buildScriptArgs(required, paramValues);
      }
    } catch {
      // Parameter detection failed (e.g. no PS process, timeout).
      // Degrade gracefully: run the script as-is and let PS handle it.
    }

    // Clear output before marking as running so the user never sees
    // "Running..." overlaid on the previous run's output (ISE parity).
    if (state.settings.clearOutputOnRun !== false) {
      dispatch({ type: "CLEAR_OUTPUT" });
    }
    dispatch({ type: "SET_RUNNING", running: true });

    try {
      await cmd.executeScript(
        psPath,
        scriptContent,
        workDir,
        state.settings.executionPolicy,
        scriptArgs,
      );

      // Populate the Variables tab by re-running the *original* script in
      // a fresh process.  Fire-and-forget so a failure here never prevents
      // the run from completing cleanly.
      cmd
        .getVariablesAfterRun(psPath, scriptContent, workDir)
        .then((vars) => dispatch({ type: "SET_VARIABLES", variables: vars }))
        .catch(() => {});
    } catch (err) {
      console.error("runScript failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      dispatch({
        type: "ADD_OUTPUT",
        line: {
          stream: "stderr",
          text: `Run failed: ${message}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      });
      runGuardRef.current = false;
      dispatch({ type: "SET_RUNNING", running: false });
    }
  }, [
    activeTab,
    state.isRunning,
    state.selectedPsPath,
    state.workingDir,
    state.settings.autoSaveOnRun,
    state.settings.clearOutputOnRun,
    state.settings.workingDirMode,
    state.settings.customWorkingDir,
    state.settings.executionPolicy,
    setParamPrompt,
    dispatch,
  ]);

  const runSelection = useCallback(async () => {
    // Guard: welcome tabs have no Monaco editor, so stale selection from a
    // prior tab must not be submitted (mirrors the runScript guard).
    if (
      !activeTab ||
      activeTab.tabType === "welcome" ||
      state.isRunning ||
      !state.selectedPsPath
    )
      return;

    // Synchronous ref guard prevents double-execution from rapid keypresses
    // (React state updates are async, so state.isRunning alone is racy).
    if (runGuardRef.current) return;
    runGuardRef.current = true;

    // Get run text from Monaco: selected text when available, otherwise
    // the current line (PowerShell ISE F8 behavior).
    const runText = (
      (window as unknown as Record<string, unknown>)
        .__psforge_getRunText as (() => string) | undefined
    )?.() ??
      ((window as unknown as Record<string, unknown>)
        .__psforge_selection as string | undefined) ??
      "";
    if (!runText.trim()) {
      runGuardRef.current = false;
      return;
    }

    // Snapshot mutable values before async gap.
    const psPath = state.selectedPsPath;

    dispatch({ type: "SET_RUNNING", running: true });

    let workDir: string;
    if (
      state.settings.workingDirMode === "custom" &&
      state.settings.customWorkingDir
    ) {
      workDir = state.settings.customWorkingDir;
    } else {
      workDir = state.workingDir || "C:\\";
    }

    try {
      await cmd.executeSelection(
        psPath,
        runText,
        workDir,
        state.settings.executionPolicy,
      );
    } catch (err) {
      console.error("runSelection failed:", err);
      runGuardRef.current = false;
      dispatch({ type: "SET_RUNNING", running: false });
    }
  }, [
    activeTab,
    state.isRunning,
    state.selectedPsPath,
    state.workingDir,
    state.settings.workingDirMode,
    state.settings.customWorkingDir,
    state.settings.executionPolicy,
    dispatch,
  ]);

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
    }
  }, [activeTab, state.selectedPsPath, dispatch]);

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
    if (!w) return;
    const escapeHtml = (value: string) =>
      value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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
  }, [activeTab]);

  // Keyboard shortcuts
  // Placed AFTER all useCallback declarations so TypeScript can see each
  // captured function's type.  The dependency array keeps the listener
  // stable: it is only replaced when one of the captured values changes,
  // not on every render (which would cause constant DOM listener churn).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+N: New tab
      if (e.ctrlKey && e.key === "n") {
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
      if (e.ctrlKey && e.key === "o") {
        e.preventDefault();
        openFile();
      }

      // Ctrl+S: Save current file
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveCurrentFile();
      }

      // Ctrl+Shift+S: Save all files (ISE parity)
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveAllFiles();
      }

      // F5: Run script
      if (e.key === "F5" && !e.ctrlKey) {
        e.preventDefault();
        runScript();
      }

      // F8: Run selection, or current line when no selection (ISE behavior)
      if (e.key === "F8") {
        e.preventDefault();
        runSelection();
      }

      // Ctrl+Break: Stop running script
      // NOTE: Ctrl+C is intentionally NOT intercepted here because it must
      // remain available for clipboard copy at all times.  Ctrl+Break is the
      // canonical ISE stop shortcut and does not conflict with copy.
      if (e.ctrlKey && e.key === "Pause") {
        e.preventDefault();
        cmd.stopScript().catch(() => {});
        dispatch({ type: "SET_RUNNING", running: false });
      }

      // Ctrl+Shift+P: Command palette
      if (e.ctrlKey && e.shiftKey && e.key === "P") {
        e.preventDefault();
        dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "all" });
      }

      // Ctrl+W: close active tab.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeActiveTab();
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: cycle through open tabs.
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        activateRelativeTab(e.shiftKey ? -1 : 1);
      }

      // Ctrl+J: ISE-style snippets picker
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "snippets" });
      }

      // F1: Keyboard shortcut reference panel
      if (e.key === "F1") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_SHORTCUT_PANEL" });
      }

      // Ctrl+,: Settings
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_SETTINGS" });
      }

      // Ctrl+B: Toggle sidebar
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_SIDEBAR" });
      }

      // Ctrl+H: Find & Replace (focus Monaco and trigger built-in action)
      if (e.ctrlKey && e.key === "h") {
        e.preventDefault();
        const trigger = (window as unknown as Record<string, unknown>)
          .__psforge_triggerFindReplace as (() => void) | undefined;
        trigger?.();
      }

      // Shift+Alt+F: Format document with Invoke-Formatter
      if (e.shiftKey && e.altKey && e.key === "F") {
        e.preventDefault();
        void formatCurrentScript();
      }

      // Ctrl+G: Go to line (focus Monaco and trigger built-in action)
      if (e.ctrlKey && e.key === "g") {
        e.preventDefault();
        const trigger = (window as unknown as Record<string, unknown>)
          .__psforge_triggerGoToLine as (() => void) | undefined;
        trigger?.();
      }

      // Ctrl+= or Ctrl+Plus: Increase editor/UI font size
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        const next = Math.min(72, (state.settings.fontSize ?? 14) + 1);
        dispatch({
          type: "SET_SETTINGS",
          settings: { ...state.settings, fontSize: next },
        });
      }

      // Ctrl+- (Minus): Decrease editor/UI font size
      if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        const next = Math.max(8, (state.settings.fontSize ?? 14) - 1);
        dispatch({
          type: "SET_SETTINGS",
          settings: { ...state.settings, fontSize: next },
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
    state.settings,
    dispatch,
    openFile,
    saveCurrentFile,
    saveAllFiles,
    closeActiveTab,
    activateRelativeTab,
    runScript,
    runSelection,
    formatCurrentScript,
  ]);

  // Sync local state from persisted settings the first time they load from
  // disk.  Without this, split/sidebar always start at DEFAULT_SETTINGS values.
  useEffect(() => {
    if (!state.settingsLoaded) return;
    setSplitPercent(state.settings.splitPosition);
    splitPercentRef.current = state.settings.splitPosition;
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
  }, [state.settingsLoaded]);

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

  // Vertical split drag handler
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current || !splitRef.current) return;
        const rect = splitRef.current.getBoundingClientRect();
        const pct = ((ev.clientY - rect.top) / rect.height) * 100;
        const clamped = Math.max(20, Math.min(80, pct));
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
      className="flex flex-col h-full w-full no-select"
      onDragOver={(e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        // Tauri exposes the native file system path on the File object.
        const path = (file as File & { path?: string }).path;
        if (path) void openFile(path);
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
        onSave={() => void saveCurrentFile()}
        onSaveAll={() => void saveAllFiles()}
        onRun={runScript}
        onStop={() => {
          cmd.stopScript().catch(() => {});
          dispatch({ type: "SET_RUNNING", running: false });
        }}
        onFormat={formatCurrentScript}
        onFindReplace={() => {
          const trigger = (window as unknown as Record<string, unknown>)
            .__psforge_triggerFindReplace as (() => void) | undefined;
          trigger?.();
        }}
        onOpenProfile={() => void openProfile()}
        onPrint={printScript}
        onSign={() => dispatch({ type: "TOGGLE_SIGNING_DIALOG" })}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {state.sidebarVisible && state.sidebarPosition === "left" && (
          <Sidebar />
        )}

        {/* Editor + Output */}
        <div ref={splitRef} className="flex flex-col flex-1 overflow-hidden">
          {/* Tab bar */}
          <TabBar />

          {/* Editor pane */}
          <div
            data-testid="editor-container"
            style={{ height: `${splitPercent}%` }}
            className="relative overflow-hidden"
          >
            <EditorPane />
          </div>

          {/* Resizer */}
          <div className="resizer-h" onMouseDown={onMouseDown} />

          {/* Bottom panel */}
          <div
            style={{ height: `${100 - splitPercent}%` }}
            className="overflow-hidden"
          >
            <OutputPane />
          </div>
        </div>

        {state.sidebarVisible && state.sidebarPosition === "right" && (
          <Sidebar />
        )}
      </div>

      {/* Status bar */}
      <StatusBar />

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
