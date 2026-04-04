/** PSForge main application component with full layout. */

import React, { useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import type {
  OutputLine,
  EditorTab,
  ScriptParameter,
  DebugBreakpoint,
  DebugLocal,
  DebugStackFrame,
  DebugWatch,
  PsVersion,
  UpdateStatus,
  VariableInfo,
} from "./types";

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
        // Emit explicit true to avoid ambiguity when args are rehydrated in
        // the backend host process.
        args.push(`-${param.name}:$true`);
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

// ---------------------------------------------------------------------------
// Debugger inspector helpers
// ---------------------------------------------------------------------------

const DEBUG_LOCALS_PREFIX = "<<PSF_DEBUG_LOCALS_JSON>>";
const DEBUG_STACK_PREFIX = "<<PSF_DEBUG_STACK_JSON>>";
const DEBUG_WATCH_PREFIX = "<<PSF_DEBUG_WATCH_JSON>>";
const SPLIT_RESIZER_HEIGHT_PX = 4;
const MIN_EDITOR_PANE_HEIGHT_PX = 180;
const MIN_BOTTOM_PANE_HEIGHT_PX = 150;
const HARD_MIN_SPLIT_PERCENT = 8;
const HARD_MAX_SPLIT_PERCENT = 92;
const SPLIT_EPSILON = 0.1;
const PS7_INSTALL_URL = "https://aka.ms/install-powershell";
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_STATUS_RESET_MS = 8_000;

const DEBUG_STACK_COMMAND =
  "$__psf_stack = Get-PSCallStack | ForEach-Object { " +
  "[PSCustomObject]@{ " +
  "functionName = if ([string]::IsNullOrWhiteSpace($_.FunctionName)) { '<script>' } else { $_.FunctionName }; " +
  "location = if ($_.ScriptName) { \"$($_.ScriptName):$($_.ScriptLineNumber)\" } else { 'Interactive' }; " +
  "command = if ($_.Command) { $_.Command } else { '' } " +
  "} }; " +
  `Write-Host '${DEBUG_STACK_PREFIX}' + ($__psf_stack | ConvertTo-Json -Compress -Depth 4)`;

function escapeForSingleQuotedPsLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeFrameIndex(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function directoryFromFilePath(filePath: string): string {
  const lastSeparator = filePath.lastIndexOf("\\");
  return lastSeparator > 0 ? filePath.slice(0, lastSeparator) : "";
}

function resolveExecutionWorkDir(
  activeTab: EditorTab,
  stateWorkingDir: string,
  workingDirMode: "file" | "custom",
  customWorkingDir: string,
): string {
  if (workingDirMode === "custom" && customWorkingDir.trim()) {
    return customWorkingDir.trim();
  }

  const fileDir = activeTab.filePath
    ? directoryFromFilePath(activeTab.filePath)
    : "";

  return stateWorkingDir || fileDir || "C:\\";
}

function resolveFallbackWorkDir(activeTab: EditorTab): string {
  return (
    (activeTab.filePath ? directoryFromFilePath(activeTab.filePath) : "") ||
    "C:\\"
  );
}

function isInvalidWorkingDirError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "INVALID_WORKING_DIR"
  );
}

function extractInvokeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; code?: unknown };
    const message =
      typeof record.message === "string" ? record.message.trim() : "";
    const code = typeof record.code === "string" ? record.code.trim() : "";
    if (message && code) {
      return `${message} (${code})`;
    }
    if (message) {
      return message;
    }
    if (code) {
      return code;
    }
  }
  return String(error);
}

function buildDebugLocalsCommand(frameIndex: number): string {
  const scope = normalizeFrameIndex(frameIndex);
  return (
    `$__psf_scope = ${scope}; ` +
    "$__psf_locals = Get-Variable -Scope $__psf_scope -ErrorAction SilentlyContinue | ForEach-Object { " +
    "[PSCustomObject]@{ " +
    "name = $_.Name; " +
    "typeName = if ($null -eq $_.Value) { 'null' } else { $_.Value.GetType().FullName }; " +
    "value = ($_.Value | Out-String).Trim(); " +
    'scope = "Frame:$__psf_scope" ' +
    "} }; " +
    `Write-Host '${DEBUG_LOCALS_PREFIX}' + ($__psf_locals | ConvertTo-Json -Compress -Depth 4)`
  );
}

function buildWatchEvalCommand(expression: string, frameIndex: number): string {
  const escaped = escapeForSingleQuotedPsLiteral(expression);
  const scope = normalizeFrameIndex(frameIndex);
  return (
    `$__psf_scope = ${scope}; ` +
    `$__psf_expr = '${escaped}'; ` +
    "try { " +
    "  $__psf_watch_vars = @(Get-Variable -Scope $__psf_scope -ErrorAction SilentlyContinue | ForEach-Object { New-Object System.Management.Automation.PSVariable -ArgumentList $_.Name, $_.Value }); " +
    "  $__psf_watch_value = ([scriptblock]::Create($__psf_expr)).InvokeWithContext($null, $__psf_watch_vars, $null); " +
    "  $__psf_payload = [PSCustomObject]@{ expression = $__psf_expr; value = ($__psf_watch_value | Out-String).Trim(); error = '' }; " +
    "} catch { " +
    "  $__psf_payload = [PSCustomObject]@{ expression = $__psf_expr; value = ''; error = $_.Exception.Message }; " +
    "} " +
    `Write-Host '${DEBUG_WATCH_PREFIX}' + ($__psf_payload | ConvertTo-Json -Compress -Depth 4)`
  );
}

function parseMarkerJson<T>(line: string, prefix: string): T | T[] | null {
  if (!line.startsWith(prefix)) return null;
  const json = line.slice(prefix.length).trim();
  if (!json) return null;
  try {
    return JSON.parse(json) as T | T[];
  } catch {
    return null;
  }
}

function asArray<T>(value: T | T[] | null): T[] {
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeBreakpointForDebug(
  breakpoint: DebugBreakpoint,
): DebugBreakpoint | null {
  const line =
    typeof breakpoint.line === "number" &&
    Number.isInteger(breakpoint.line) &&
    breakpoint.line >= 1
      ? breakpoint.line
      : undefined;
  const variableRaw =
    typeof breakpoint.variable === "string"
      ? breakpoint.variable.trim().replace(/^\$/, "")
      : "";
  const variable = variableRaw.length > 0 ? variableRaw : undefined;
  const targetCommandRaw =
    typeof breakpoint.targetCommand === "string"
      ? breakpoint.targetCommand.trim()
      : "";
  const targetCommand =
    targetCommandRaw.length > 0 ? targetCommandRaw : undefined;
  if (
    line === undefined &&
    variable === undefined &&
    targetCommand === undefined
  ) {
    return null;
  }

  const condition =
    typeof breakpoint.condition === "string" && breakpoint.condition.trim()
      ? breakpoint.condition.trim()
      : undefined;
  const command =
    typeof breakpoint.command === "string" && breakpoint.command.trim()
      ? breakpoint.command.trim()
      : undefined;
  const hitCount =
    typeof breakpoint.hitCount === "number" &&
    Number.isInteger(breakpoint.hitCount) &&
    breakpoint.hitCount >= 1
      ? breakpoint.hitCount
      : undefined;
  const mode =
    breakpoint.mode === "Read" || breakpoint.mode === "Write"
      ? breakpoint.mode
      : "ReadWrite";
  return { line, variable, targetCommand, mode, condition, hitCount, command };
}

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
  /** Synchronous guard against double-execution.
   *  React state updates from dispatch are asynchronous, so a rapid second
   *  F5 press can read stale `state.isRunning === false` from the closure.
   *  This ref is set to `true` synchronously before dispatch, preventing the
   *  second invocation from passing the guard check. */
  const runGuardRef = useRef(false);
  /** Tracks whether the active process was started in debugger mode. */
  const debugSessionRef = useRef(false);
  /** Last known debugger stop location, updated from debug markers/output. */
  const debugLocationRef = useRef<{ line: number; column: number } | null>(
    null,
  );
  const activeTabRef = useRef<EditorTab | undefined>(activeTab);
  const cursorLineRef = useRef(state.cursorLine);
  const bookmarksRef = useRef(state.bookmarks);
  const availableUpdateRef =
    useRef<Awaited<ReturnType<typeof checkForAppUpdate>>>(null);
  const updateStatusResetTimerRef = useRef<number | null>(null);
  const autoUpdateCheckStartedRef = useRef(false);
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
      "On Windows the app will close automatically while the update is applied.",
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

      try {
        const { message } = await import("@tauri-apps/plugin-dialog");
        await message(
          "The update package has been installed. If PSForge does not restart automatically, launch it again to finish applying the update.",
          {
            title: "PSForge Update",
            kind: "info",
          },
        );
      } catch {
        // Best effort only; Windows usually exits before this path executes.
      }
    } catch (err) {
      clearPendingUpdate();
      setUpdateStatus({
        phase: "error",
        message: extractInvokeErrorMessage(err),
      });
      scheduleUpdateStatusReset();
    }
  }, [
    clearPendingUpdate,
    clearUpdateStatusResetTimer,
    scheduleUpdateStatusReset,
  ]);

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
    if (state.debugLine && state.debugColumn) {
      debugLocationRef.current = {
        line: state.debugLine,
        column: state.debugColumn,
      };
    } else {
      debugLocationRef.current = null;
    }
  }, [state.debugLine, state.debugColumn]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    cursorLineRef.current = state.cursorLine;
  }, [state.cursorLine]);

  useEffect(() => {
    bookmarksRef.current = state.bookmarks;
  }, [state.bookmarks]);

  const debugWatchesRef = useRef<DebugWatch[]>(state.debugWatches);
  const debugSelectedFrameRef = useRef<number>(state.debugSelectedFrame);
  useEffect(() => {
    debugWatchesRef.current = state.debugWatches;
  }, [state.debugWatches]);
  useEffect(() => {
    debugSelectedFrameRef.current = normalizeFrameIndex(
      state.debugSelectedFrame,
    );
  }, [state.debugSelectedFrame]);

  const evaluateDebugWatch = useCallback(
    async (expression: string, frameIndex?: number) => {
      const expr = expression.trim();
      if (!expr || !state.isDebugging || !state.debugPaused) return;
      const scope = normalizeFrameIndex(
        frameIndex ?? debugSelectedFrameRef.current,
      );
      try {
        await cmd.sendStdin(buildWatchEvalCommand(expr, scope));
      } catch {
        dispatch({
          type: "UPDATE_DEBUG_WATCH",
          watch: { expression: expr, value: "", error: "Evaluation failed." },
        });
      }
    },
    [state.isDebugging, state.debugPaused, dispatch],
  );

  const refreshDebugInspector = useCallback(
    async (frameIndex?: number) => {
      if (!state.isDebugging || !state.debugPaused) return;
      const scope = normalizeFrameIndex(
        frameIndex ?? debugSelectedFrameRef.current,
      );
      try {
        await cmd.sendStdin(buildDebugLocalsCommand(scope));
        await cmd.sendStdin(DEBUG_STACK_COMMAND);
        for (const watch of debugWatchesRef.current) {
          const expr = watch.expression.trim();
          if (!expr) continue;
          await cmd.sendStdin(buildWatchEvalCommand(expr, scope));
        }
      } catch {
        // Best-effort only; debugger execution should continue.
      }
    },
    [state.isDebugging, state.debugPaused],
  );

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
      const trimmed = event.payload.text.trim();

      if (debugSessionRef.current) {
        const localsPayload = parseMarkerJson<Record<string, unknown>>(
          trimmed,
          DEBUG_LOCALS_PREFIX,
        );
        if (localsPayload !== null) {
          const locals: DebugLocal[] = asArray(localsPayload)
            .map((item) => ({
              name: typeof item.name === "string" ? item.name : "",
              typeName: typeof item.typeName === "string" ? item.typeName : "",
              value: typeof item.value === "string" ? item.value : "",
              scope: typeof item.scope === "string" ? item.scope : "",
            }))
            .filter((item) => item.name.length > 0);
          dispatch({ type: "SET_DEBUG_LOCALS", locals });
          return;
        }

        const stackPayload = parseMarkerJson<Record<string, unknown>>(
          trimmed,
          DEBUG_STACK_PREFIX,
        );
        if (stackPayload !== null) {
          const frames: DebugStackFrame[] = asArray(stackPayload).map(
            (item) => ({
              functionName:
                typeof item.functionName === "string"
                  ? item.functionName
                  : "<script>",
              location: typeof item.location === "string" ? item.location : "",
              command: typeof item.command === "string" ? item.command : "",
            }),
          );
          dispatch({ type: "SET_DEBUG_CALL_STACK", frames });
          return;
        }

        const watchPayload = parseMarkerJson<Record<string, unknown>>(
          trimmed,
          DEBUG_WATCH_PREFIX,
        );
        if (watchPayload !== null) {
          const entry = asArray(watchPayload)[0];
          if (entry) {
            dispatch({
              type: "UPDATE_DEBUG_WATCH",
              watch: {
                expression:
                  typeof entry.expression === "string" ? entry.expression : "",
                value: typeof entry.value === "string" ? entry.value : "",
                error: typeof entry.error === "string" ? entry.error : "",
              },
            });
          }
          return;
        }
      }

      dispatch({ type: "ADD_OUTPUT", line: event.payload });

      if (!debugSessionRef.current) return;

      const locationMatch = /At\s+(?:.+:)?(\d+)\s+char:(\d+)/i.exec(trimmed);
      if (locationMatch) {
        const line = parseInt(locationMatch[1], 10);
        const column = parseInt(locationMatch[2], 10);
        if (Number.isFinite(line) && line > 0) {
          const nextColumn = Number.isFinite(column) && column > 0 ? column : 1;
          debugLocationRef.current = { line, column: nextColumn };
          dispatch({
            type: "SET_DEBUG_STATE",
            debugLine: line,
            debugColumn: nextColumn,
          });
        }
      }

      // [DBG]: prompt indicates the PowerShell debugger is paused and ready
      // for continue/step commands.
      if (trimmed.includes("[DBG]:")) {
        dispatch({
          type: "SET_DEBUG_STATE",
          isDebugging: true,
          debugPaused: true,
        });
        dispatch({ type: "SET_DEBUG_SELECTED_FRAME", frameIndex: 0 });
        dispatch({ type: "SET_BOTTOM_TAB", tab: "debugger" });
        void refreshDebugInspector(0);
        const nav = (window as unknown as Record<string, unknown>)
          .__psforge_navigateTo as
          | ((line: number, column: number) => void)
          | undefined;
        const loc = debugLocationRef.current;
        if (loc) nav?.(loc.line, loc.column);
      }
    });

    const unlistenVariables = listen<VariableInfo[]>(
      "ps-variables",
      (event) => {
        dispatch({ type: "SET_VARIABLES", variables: event.payload });
      },
    );

    const unlistenDebugBreak = listen<number>("ps-debug-break", (event) => {
      if (!debugSessionRef.current) return;
      const line = event.payload;
      if (!Number.isFinite(line) || line < 1) return;
      debugLocationRef.current = { line, column: 1 };
      dispatch({
        type: "SET_DEBUG_STATE",
        isDebugging: true,
        debugPaused: true,
        debugLine: line,
        debugColumn: 1,
      });
      dispatch({ type: "SET_DEBUG_SELECTED_FRAME", frameIndex: 0 });
      dispatch({ type: "SET_BOTTOM_TAB", tab: "debugger" });
      void refreshDebugInspector(0);
      const nav = (window as unknown as Record<string, unknown>)
        .__psforge_navigateTo as
        | ((targetLine: number, targetColumn: number) => void)
        | undefined;
      nav?.(line, 1);
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
      debugSessionRef.current = false;
      dispatch({ type: "SET_RUNNING", running: false });
      dispatch({
        type: "SET_DEBUG_STATE",
        isDebugging: false,
        debugPaused: false,
        debugLine: null,
        debugColumn: null,
      });
      dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenVariables.then((fn) => fn());
      unlistenDebugBreak.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
    };
  }, [dispatch, refreshDebugInspector]);

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
    w.__psforge_openFile = () => void openFile();
    w.__psforge_openFileByPath = (p: string) => void openFile(p);
    w.__psforge_openWelcome = () => openWelcomePage();
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
      delete w.__psforge_openWelcome;
      delete w.__psforge_dispatch;
      delete w.__psforge_reset_variables;
    };
  }, [openFile, openWelcomePage, dispatch]);

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
    async (
      tab: EditorTab,
    ): Promise<{ saved: boolean; cancelled: boolean; path?: string }> => {
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
  const closeActiveTab = useCallback(async () => {
    if (!activeTab || state.tabs.length <= 1) return;
    if (activeTab.isDirty) {
      const confirmMessage = `"${activeTab.title}" has unsaved changes.\n\nClose without saving?`;
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
      if (!confirmed) return;
    }
    dispatch({ type: "CLOSE_TAB", id: activeTab.id });
  }, [activeTab, state.tabs.length, dispatch]);

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
    debugSessionRef.current = false;
    debugLocationRef.current = null;
    dispatch({
      type: "SET_DEBUG_STATE",
      isDebugging: false,
      debugPaused: false,
      debugLine: null,
      debugColumn: null,
    });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });

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
    const workDir = resolveExecutionWorkDir(
      activeTab,
      state.workingDir,
      state.settings.workingDirMode,
      state.settings.customWorkingDir,
    );

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
    dispatch({ type: "SET_VARIABLES", variables: [] });
    dispatch({ type: "SET_RUNNING", running: true });

    try {
      await cmd.executeScript(
        psPath,
        scriptContent,
        workDir,
        state.settings.executionPolicy,
        scriptArgs,
        state.settings.persistRunspaceBetweenRuns !== false,
      );
    } catch (err) {
      if (
        state.settings.workingDirMode !== "custom" &&
        isInvalidWorkingDirError(err)
      ) {
        const fallbackWorkDir = resolveFallbackWorkDir(activeTab);
        if (fallbackWorkDir !== workDir) {
          dispatch({
            type: "ADD_OUTPUT",
            line: {
              stream: "warning",
              text: `Working directory "${workDir}" is unavailable; retrying from "${fallbackWorkDir}".`,
              timestamp: String(Math.floor(Date.now() / 1000)),
            },
          });
          dispatch({ type: "SET_WORKING_DIR", dir: fallbackWorkDir });
          try {
            await cmd.executeScript(
              psPath,
              scriptContent,
              fallbackWorkDir,
              state.settings.executionPolicy,
              scriptArgs,
              state.settings.persistRunspaceBetweenRuns !== false,
            );
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
      }

      console.error("runScript failed:", err);
      const message = extractInvokeErrorMessage(err);
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
    state.settings.persistRunspaceBetweenRuns,
    setParamPrompt,
    dispatch,
  ]);

  const startDebugSession = useCallback(async () => {
    if (!activeTab || activeTab.tabType === "welcome" || state.isRunning) {
      return;
    }

    if (!state.selectedPsPath) {
      dispatch({
        type: "ADD_OUTPUT",
        line: {
          stream: "stderr",
          text: "Debug failed: no PowerShell executable is selected.",
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      });
      return;
    }

    if (runGuardRef.current) return;
    runGuardRef.current = true;
    debugSessionRef.current = true;
    debugLocationRef.current = null;

    // Auto-save before debugging when enabled.
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
        // Save failed -- continue with in-memory content.
      }
    }

    const psPath = state.selectedPsPath;
    const scriptContent = activeTab.content;
    const breakpoints: DebugBreakpoint[] = (
      state.breakpoints[activeTab.id] ?? []
    )
      .map((bp) => normalizeBreakpointForDebug(bp))
      .filter((bp): bp is DebugBreakpoint => bp !== null);

    const workDir = resolveExecutionWorkDir(
      activeTab,
      state.workingDir,
      state.settings.workingDirMode,
      state.settings.customWorkingDir,
    );

    let scriptArgs: string[] = [];
    try {
      const allParams = await cmd.getScriptParameters(psPath, scriptContent);
      const required = allParams.filter((p) => p.isMandatory && !p.hasDefault);
      if (required.length > 0) {
        const paramValues = await new Promise<Record<string, string> | null>(
          (resolve) => {
            setParamPrompt({ params: required, resolve });
          },
        );
        setParamPrompt(null);

        if (paramValues === null) {
          runGuardRef.current = false;
          debugSessionRef.current = false;
          dispatch({
            type: "SET_DEBUG_STATE",
            isDebugging: false,
            debugPaused: false,
            debugLine: null,
            debugColumn: null,
          });
          dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
          return;
        }
        scriptArgs = buildScriptArgs(required, paramValues);
      }
    } catch {
      // Graceful degradation: run debug without preflight params.
    }

    if (state.settings.clearOutputOnRun !== false) {
      dispatch({ type: "CLEAR_OUTPUT" });
    }
    dispatch({ type: "SET_BOTTOM_TAB", tab: "debugger" });
    dispatch({
      type: "SET_DEBUG_STATE",
      isDebugging: true,
      debugPaused: false,
      debugLine: null,
      debugColumn: null,
    });
    dispatch({ type: "SET_DEBUG_SELECTED_FRAME", frameIndex: 0 });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
    dispatch({ type: "SET_VARIABLES", variables: [] });
    dispatch({ type: "SET_RUNNING", running: true });

    try {
      await cmd.executeScriptDebug(
        psPath,
        scriptContent,
        workDir,
        state.settings.executionPolicy,
        breakpoints,
        scriptArgs,
        state.settings.persistRunspaceBetweenRuns !== false,
      );
    } catch (err) {
      if (
        state.settings.workingDirMode !== "custom" &&
        isInvalidWorkingDirError(err)
      ) {
        const fallbackWorkDir = resolveFallbackWorkDir(activeTab);
        if (fallbackWorkDir !== workDir) {
          dispatch({
            type: "ADD_OUTPUT",
            line: {
              stream: "warning",
              text: `Working directory "${workDir}" is unavailable; retrying debug session from "${fallbackWorkDir}".`,
              timestamp: String(Math.floor(Date.now() / 1000)),
            },
          });
          dispatch({ type: "SET_WORKING_DIR", dir: fallbackWorkDir });
          try {
            await cmd.executeScriptDebug(
              psPath,
              scriptContent,
              fallbackWorkDir,
              state.settings.executionPolicy,
              breakpoints,
              scriptArgs,
              state.settings.persistRunspaceBetweenRuns !== false,
            );
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
      }

      console.error("startDebugSession failed:", err);
      const message = extractInvokeErrorMessage(err);
      dispatch({
        type: "ADD_OUTPUT",
        line: {
          stream: "stderr",
          text: `Debug failed: ${message}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      });
      dispatch({ type: "SET_VARIABLES", variables: [] });
      runGuardRef.current = false;
      debugSessionRef.current = false;
      dispatch({ type: "SET_RUNNING", running: false });
      dispatch({
        type: "SET_DEBUG_STATE",
        isDebugging: false,
        debugPaused: false,
        debugLine: null,
        debugColumn: null,
      });
      dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
    }
  }, [
    activeTab,
    state.isRunning,
    state.selectedPsPath,
    state.breakpoints,
    state.workingDir,
    state.settings.autoSaveOnRun,
    state.settings.clearOutputOnRun,
    state.settings.workingDirMode,
    state.settings.customWorkingDir,
    state.settings.executionPolicy,
    state.settings.persistRunspaceBetweenRuns,
    setParamPrompt,
    dispatch,
  ]);

  const debugContinue = useCallback(async () => {
    if (!state.isDebugging || !state.debugPaused) return;
    dispatch({ type: "SET_DEBUG_STATE", debugPaused: false });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
    try {
      await cmd.debugContinue();
    } catch {
      dispatch({ type: "SET_DEBUG_STATE", debugPaused: true });
      void refreshDebugInspector();
    }
  }, [state.isDebugging, state.debugPaused, dispatch, refreshDebugInspector]);

  const debugStepOver = useCallback(async () => {
    if (!state.isDebugging || !state.debugPaused) return;
    dispatch({ type: "SET_DEBUG_STATE", debugPaused: false });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
    try {
      await cmd.debugStepOver();
    } catch {
      dispatch({ type: "SET_DEBUG_STATE", debugPaused: true });
      void refreshDebugInspector();
    }
  }, [state.isDebugging, state.debugPaused, dispatch, refreshDebugInspector]);

  const debugStepInto = useCallback(async () => {
    if (!state.isDebugging || !state.debugPaused) return;
    dispatch({ type: "SET_DEBUG_STATE", debugPaused: false });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
    try {
      await cmd.debugStepInto();
    } catch {
      dispatch({ type: "SET_DEBUG_STATE", debugPaused: true });
      void refreshDebugInspector();
    }
  }, [state.isDebugging, state.debugPaused, dispatch, refreshDebugInspector]);

  const debugStepOut = useCallback(async () => {
    if (!state.isDebugging || !state.debugPaused) return;
    dispatch({ type: "SET_DEBUG_STATE", debugPaused: false });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
    try {
      await cmd.debugStepOut();
    } catch {
      dispatch({ type: "SET_DEBUG_STATE", debugPaused: true });
      void refreshDebugInspector();
    }
  }, [state.isDebugging, state.debugPaused, dispatch, refreshDebugInspector]);

  const runOrDebugScript = useCallback(() => {
    if (state.isDebugging && state.debugPaused) {
      void debugContinue();
      return;
    }

    if (!activeTab || activeTab.tabType === "welcome") return;
    const breakpoints = state.breakpoints[activeTab.id] ?? [];
    if (breakpoints.length > 0) {
      void startDebugSession();
      return;
    }
    void runScript();
  }, [
    activeTab,
    state.breakpoints,
    state.isDebugging,
    state.debugPaused,
    debugContinue,
    startDebugSession,
    runScript,
  ]);

  const selectDebugFrame = useCallback(
    async (frameIndex: number) => {
      const next = normalizeFrameIndex(frameIndex);
      dispatch({ type: "SET_DEBUG_SELECTED_FRAME", frameIndex: next });
      if (!state.isDebugging) return;
      try {
        await cmd.debugSetFrame(next);
      } catch {
        // Non-fatal: inspector refresh still works via explicit scope.
      }
      if (state.debugPaused) {
        void refreshDebugInspector(next);
      }
    },
    [dispatch, state.isDebugging, state.debugPaused, refreshDebugInspector],
  );

  const stopExecution = useCallback(() => {
    cmd.stopScript().catch(() => {});
    runGuardRef.current = false;
    debugSessionRef.current = false;
    dispatch({ type: "SET_RUNNING", running: false });
    dispatch({
      type: "SET_DEBUG_STATE",
      isDebugging: false,
      debugPaused: false,
      debugLine: null,
      debugColumn: null,
    });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
  }, [dispatch]);

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
    const runText =
      (
        (window as unknown as Record<string, unknown>).__psforge_getRunText as
          | (() => string)
          | undefined
      )?.() ??
      ((window as unknown as Record<string, unknown>).__psforge_selection as
        | string
        | undefined) ??
      "";
    if (!runText.trim()) {
      runGuardRef.current = false;
      return;
    }

    // Snapshot mutable values before async gap.
    const psPath = state.selectedPsPath;

    dispatch({ type: "SET_RUNNING", running: true });

    const workDir = resolveExecutionWorkDir(
      activeTab,
      state.workingDir,
      state.settings.workingDirMode,
      state.settings.customWorkingDir,
    );

    try {
      await cmd.executeSelection(
        psPath,
        runText,
        workDir,
        state.settings.executionPolicy,
        state.settings.persistRunspaceBetweenRuns !== false,
      );
    } catch (err) {
      if (
        state.settings.workingDirMode !== "custom" &&
        isInvalidWorkingDirError(err)
      ) {
        const fallbackWorkDir = resolveFallbackWorkDir(activeTab);
        if (fallbackWorkDir !== workDir) {
          dispatch({
            type: "ADD_OUTPUT",
            line: {
              stream: "warning",
              text: `Working directory "${workDir}" is unavailable; retrying selection from "${fallbackWorkDir}".`,
              timestamp: String(Math.floor(Date.now() / 1000)),
            },
          });
          dispatch({ type: "SET_WORKING_DIR", dir: fallbackWorkDir });
          try {
            await cmd.executeSelection(
              psPath,
              runText,
              fallbackWorkDir,
              state.settings.executionPolicy,
              state.settings.persistRunspaceBetweenRuns !== false,
            );
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
      }

      console.error("runSelection failed:", err);
      const message = extractInvokeErrorMessage(err);
      dispatch({
        type: "ADD_OUTPUT",
        line: {
          stream: "stderr",
          text: `Selection run failed: ${message}`,
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
    state.settings.workingDirMode,
    state.settings.customWorkingDir,
    state.settings.executionPolicy,
    state.settings.persistRunspaceBetweenRuns,
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
  }, [activeTab]);

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
      if (e.ctrlKey && e.shiftKey && e.key === "P") {
        e.preventDefault();
        dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "all" });
      }

      // Ctrl+W: close active tab.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        void closeActiveTab();
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: cycle through open tabs.
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        activateRelativeTab(e.shiftKey ? -1 : 1);
      }

      // Ctrl+J: ISE-style snippets picker
      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "j"
      ) {
        e.preventDefault();
        dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "snippets" });
      }

      // Ctrl+Shift+C: Open Show Command tab.
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
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
    toggleBookmarkAtCursor,
    jumpToBookmark,
  ]);

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
    const reconcile = () => {
      rafId = null;
      const current = splitPercentRef.current;
      const clamped = clampSplitPercentForHeight(
        current,
        container.getBoundingClientRect().height,
      );
      if (Math.abs(clamped - current) > SPLIT_EPSILON) {
        setSplitPercent(clamped);
        splitPercentRef.current = clamped;
      }
    };
    const scheduleReconcile = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(reconcile);
    };
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
        onRun={runOrDebugScript}
        onDebugStart={startDebugSession}
        onDebugContinue={debugContinue}
        onDebugStepOver={debugStepOver}
        onDebugStepInto={debugStepInto}
        onDebugStepOut={debugStepOut}
        onStop={stopExecution}
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
            <button
              onClick={openPs7InstallPage}
              style={{
                backgroundColor: "var(--accent)",
                color: "#ffffff",
                border: "1px solid var(--accent)",
                borderRadius: "4px",
                padding: "4px 10px",
              }}
            >
              Install
            </button>
            <button
              onClick={() => void refreshPsVersions()}
              disabled={psVersionRefreshInFlight}
              style={{
                backgroundColor: "transparent",
                color: psVersionRefreshInFlight
                  ? "var(--text-muted)"
                  : "var(--text-secondary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                padding: "4px 10px",
                cursor: psVersionRefreshInFlight ? "default" : "pointer",
              }}
            >
              {psVersionRefreshInFlight ? "Rescanning..." : "Rescan"}
            </button>
            <button
              onClick={dismissPs7BannerForSession}
              style={{
                backgroundColor: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                padding: "4px 10px",
              }}
            >
              Not now
            </button>
            <button
              onClick={disablePs7Reminder}
              style={{
                backgroundColor: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "4px",
                padding: "4px 10px",
              }}
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
