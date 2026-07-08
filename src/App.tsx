/** PSForge main application component with full layout. */

import React, { useEffect, useCallback, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
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
  isPssaErrorSeverity,
  resolveExecutionWorkDir,
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
} from "./scratch-utils";
import { mergeRecentFilePaths } from "./script-utils";
import { findProjectConfig, applyProjectConfig } from "./project-config";
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
  OutputLine,
  EditorTab,
  ScriptRunRecord,
  AppSettings,
  ScriptParameter,
  DebugBreakpoint,
  DebugLocal,
  DebugStackFrame,
  DebugWatch,
  PsVersion,
  PssaDiagnostic,
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
    // SecureString password fields preserve leading/trailing whitespace; for
    // every other type we trim because PS would do the same on parse.
    const typeName = param.typeName.toLowerCase();
    const isSecure =
      typeName === "securestring" ||
      typeName === "system.security.securestring";
    const trimmed = isSecure ? raw : raw.trim();
    const lower = trimmed.toLowerCase();
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

    if (isSecure) {
      // SecureString parameters: encode the plain value as base64 and tag it
      // with a sentinel prefix the backend wrapper recognises and converts to
      // a real [SecureString] before splatting. Without this, PowerShell's
      // parameter binder rejects the plain string with a "Cannot convert"
      // error and the script never starts. Base64 protects against shell
      // metacharacters, embedded `:` (the colon-form arg tokenizer splits
      // there), and bidi/control bytes that could break the wrapper.
      const utf8 =
        typeof TextEncoder !== "undefined"
          ? new TextEncoder().encode(trimmed)
          : Uint8Array.from(unescape(encodeURIComponent(trimmed)), (ch) =>
              ch.charCodeAt(0),
            );
      let binary = "";
      for (let i = 0; i < utf8.length; i++) {
        binary += String.fromCharCode(utf8[i]);
      }
      const encoded = typeof btoa === "function" ? btoa(binary) : binary;
      args.push(`-${param.name}:__psforge_securestring__${encoded}`);
      continue;
    }

    // Colon-form boolean emission only for genuinely boolean-typed params.
    // For anything else (e.g. [string]$Mode) the literal text "true" must
    // pass through unmodified — the backend coerces `-Name:$true` to a real
    // boolean, which would silently rewrite the user's string to "True".
    const isBool =
      typeName === "bool" ||
      typeName === "boolean" ||
      typeName === "system.boolean";
    if (isBool && (lower === "true" || lower === "false")) {
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

type AvailableAppUpdate = NonNullable<
  Awaited<ReturnType<typeof checkForAppUpdate>>
>;

const DEBUG_STACK_COMMAND =
  "$__psf_stack = Get-PSCallStack | ForEach-Object { " +
  "[PSCustomObject]@{ " +
  "functionName = if ([string]::IsNullOrWhiteSpace($_.FunctionName)) { '<script>' } else { $_.FunctionName }; " +
  "location = if ($_.ScriptName) { \"$($_.ScriptName):$($_.ScriptLineNumber)\" } else { 'Interactive' }; " +
  "command = if ($_.Command) { $_.Command } else { '' } " +
  "} }; " +
  // The concatenation must be wrapped in parens: in PowerShell argument mode
  // a bare `+` is passed to Write-Host as a separate argument, emitting
  // "<prefix> + <json>" which the marker parser rejects.
  `Write-Host ('${DEBUG_STACK_PREFIX}' + ($__psf_stack | ConvertTo-Json -Compress -Depth 4))`;

function escapeForSingleQuotedPsLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeFrameIndex(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Cross-platform fallback when the active tab has no usable directory. */
function platformHomeFallback(): string {
  // navigator.platform is deprecated but still the cheapest signal in a
  // browser/WebView. We only use it to pick a sensible "where do scripts run
  // when there is no file" default; the choice is non-load-bearing.
  if (typeof navigator !== "undefined" && /win/i.test(navigator.platform)) {
    return "C:\\";
  }
  return "/";
}

function resolveFallbackWorkDir(activeTab: EditorTab): string {
  return (
    (activeTab.filePath ? dirname(activeTab.filePath) : "") ||
    platformHomeFallback()
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
    `Write-Host ('${DEBUG_LOCALS_PREFIX}' + ($__psf_locals | ConvertTo-Json -Compress -Depth 4))`
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
    `Write-Host ('${DEBUG_WATCH_PREFIX}' + ($__psf_payload | ConvertTo-Json -Compress -Depth 4))`
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
  const scratchDirRef = useRef("");
  const scratchSaveTimersRef = useRef<Map<string, number>>(new Map());
  const scratchRecoveryCheckedRef = useRef(false);
  const runWorkingDirOverrideRef = useRef<string | null>(null);
  const [pssaGatePrompt, setPssaGatePrompt] = React.useState<{
    errors: PssaDiagnostic[];
    resolve: (proceed: boolean) => void;
  } | null>(null);
  const [closeScratchPrompt, setCloseScratchPrompt] = React.useState<{
    tab: EditorTab;
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

  // Live mirrors of the debug pause state. The break handlers below call
  // refreshDebugInspector in the SAME tick as the SET_DEBUG_STATE dispatch;
  // a state-closure guard would still see the pre-dispatch values and no-op
  // on every single pause, so the inspector never auto-populated (S6-14).
  // The handlers update these refs synchronously alongside the dispatch.
  const isDebuggingRef = useRef(state.isDebugging);
  const debugPausedRef = useRef(state.debugPaused);
  useEffect(() => {
    isDebuggingRef.current = state.isDebugging;
  }, [state.isDebugging]);
  useEffect(() => {
    debugPausedRef.current = state.debugPaused;
  }, [state.debugPaused]);

  const evaluateDebugWatch = useCallback(
    async (expression: string, frameIndex?: number) => {
      const expr = expression.trim();
      if (!expr || !isDebuggingRef.current || !debugPausedRef.current) return;
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
    [dispatch],
  );

  const refreshDebugInspector = useCallback(async (frameIndex?: number) => {
    if (!isDebuggingRef.current || !debugPausedRef.current) return;
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
  }, []);

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

      void writeTerminalNotice(event.payload.text, { reveal: false });

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
      // for continue/step commands. Require the prompt's trailing ">>" too:
      // a bare substring match let ordinary script output like
      // `Write-Host "[DBG]: cache miss"` flip the UI into a fake paused state
      // and queue inspector commands into the still-running script's stdin
      // (S6-18). The real prompt is `[DBG]: PS C:\...>>` (or the nested
      // `[DBG]: [Process:..]: ... >>` variants), all ending in ">>".
      if (/\[DBG\]:.*>>/.test(trimmed)) {
        // Sync refs first: the dispatch won't be visible until the next
        // render, but refreshDebugInspector's guard runs right now (S6-14).
        isDebuggingRef.current = true;
        debugPausedRef.current = true;
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
      // Variable/Command breakpoints have no line number (the marker carries
      // 0). The pause is still real — the process is blocked at the debug
      // prompt — so always flip the UI into paused state; only the source
      // line highlight/navigation needs a valid line.
      const line = event.payload;
      const hasLine = Number.isFinite(line) && line >= 1;
      debugLocationRef.current = hasLine ? { line, column: 1 } : null;
      // Sync refs first so the immediate refresh below passes its guard (S6-14).
      isDebuggingRef.current = true;
      debugPausedRef.current = true;
      dispatch({
        type: "SET_DEBUG_STATE",
        isDebugging: true,
        debugPaused: true,
        debugLine: hasLine ? line : null,
        debugColumn: hasLine ? 1 : null,
      });
      dispatch({ type: "SET_DEBUG_SELECTED_FRAME", frameIndex: 0 });
      dispatch({ type: "SET_BOTTOM_TAB", tab: "debugger" });
      void refreshDebugInspector(0);
      if (hasLine) {
        const nav = (window as unknown as Record<string, unknown>)
          .__psforge_navigateTo as
          | ((targetLine: number, targetColumn: number) => void)
          | undefined;
        nav?.(line, 1);
      }
    });

    const unlistenComplete = listen<number>("ps-complete", (event) => {
      const code = event.payload;
      if (code !== 0) {
        void writeTerminalNotice(`[PSForge] Process exited with code ${code}`, {
          reveal: false,
        });
      }
      // Clear the synchronous run guard so subsequent runs are possible.
      runGuardRef.current = false;
      debugSessionRef.current = false;
      isDebuggingRef.current = false;
      debugPausedRef.current = false;
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
  }, [dispatch, refreshDebugInspector, writeTerminalNotice]);

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
        // File open failed -- log for diagnostics but don't crash.
        console.error("openFile failed:", err);
      }
    },
    [state.tabs, state.settings, dispatch],
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

  /** True when the tab's backing file on disk no longer matches the content
   *  PSForge last loaded or saved — i.e. it was modified externally (git
   *  pull, another editor) and a blind save would clobber those changes
   *  (S6-10). Missing/unreadable files return false: nothing to clobber. */
  const fileChangedOnDisk = useCallback(
    async (tab: EditorTab): Promise<boolean> => {
      if (!tab.filePath) return false;
      try {
        const onDisk = await cmd.readFileContent(tab.filePath);
        return onDisk.content !== tab.savedContent;
      } catch {
        return false;
      }
    },
    [],
  );

  const saveTab = useCallback(
    async (
      tab: EditorTab,
    ): Promise<{ saved: boolean; cancelled: boolean; path?: string }> => {
      // A scratch backing path is internal, not a user-chosen save location:
      // saving must offer Save As, never silently write the UUID file, retitle
      // the tab to it, or push it into recent files (S6-8).
      const scratchDir = scratchDirRef.current;
      const isScratchPath =
        !!scratchDir && !!tab.filePath && isScratchBackedTab(tab, scratchDir);
      let filePath = isScratchPath ? "" : tab.filePath;

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

      // Saving over the file we originally loaded: refuse to silently clobber
      // changes made outside PSForge (S6-10). Save As to a different path is
      // covered by the OS dialog's own overwrite confirmation.
      if (filePath === tab.filePath && (await fileChangedOnDisk(tab))) {
        let overwrite = false;
        try {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          overwrite = await confirm(
            `"${basename(filePath)}" has changed on disk since it was opened in PSForge.\n\nOverwrite the external changes?`,
            {
              title: "PSForge",
              kind: "warning",
              okLabel: "Overwrite",
              cancelLabel: "Cancel",
            },
          );
        } catch {
          overwrite = false;
        }
        if (!overwrite) return { saved: false, cancelled: true };
      }

      try {
        const saveWarning = await cmd.saveFileContent(
          filePath,
          tab.content,
          tab.encoding,
        );
        let savedBaseline = tab.content;
        if (saveWarning) {
          void writeTerminalNotice(`[PSForge] ${saveWarning}`, { reveal: true });
          // A lossy encode (e.g. emoji saved as windows1252) means the bytes
          // on disk no longer decode back to the buffer; keeping the buffer as
          // the baseline would make fileChangedOnDisk flag our own save as an
          // external change on every future save (S6-16).
          try {
            savedBaseline = (await cmd.readFileContent(filePath)).content;
          } catch {
            // Keep the buffer baseline; worst case is the old behavior.
          }
        }
        const fileName = basename(filePath);
        dispatch({
          type: "UPDATE_TAB",
          id: tab.id,
          changes: {
            filePath,
            title: fileName,
            savedContent: savedBaseline,
            isDirty: false,
          },
        });

        // Update working directory to the most recently saved file location.
        const dir = dirname(filePath);
        if (dir) {
          dispatch({ type: "SET_WORKING_DIR", dir });
        }

        // The content now lives at a user-chosen path; drop the scratch file
        // so it can't resurface as a bogus recovery candidate on a later
        // launch (mirrors finalizeCloseTab's save-as cleanup).
        if (isScratchPath && tab.filePath !== filePath) {
          try {
            await cmd.deleteScratchFile(tab.filePath);
          } catch {
            // best-effort cleanup
          }
        }

        return { saved: true, cancelled: false, path: filePath };
      } catch (err) {
        console.error(`saveTab failed for "${tab.title}":`, err);
        return { saved: false, cancelled: false };
      }
    },
    [dispatch, fileChangedOnDisk],
  );

  const saveCurrentFile = useCallback(async () => {
    if (!activeTab || activeTab.tabType === "welcome") return;
    const result = await saveTab(activeTab);
    if (!result.saved || !result.path) return;

    const recent = mergeRecentFilePaths(
      state.settings.recentFiles,
      [result.path],
      state.settings.maxRecentFiles ?? 20,
    );
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, recentFiles: recent },
    });
  }, [activeTab, saveTab, state.settings, dispatch]);

  const saveAllFiles = useCallback(async () => {
    // Save all code tabs that are dirty OR have no user-chosen path. A scratch
    // backing path is internal, so scratch-backed tabs count as unsaved even
    // when auto-save has marked them clean (S6-8).
    const scratchDir = scratchDirRef.current;
    const hasUserPath = (tab: EditorTab) =>
      !!tab.filePath && !(scratchDir && isScratchBackedTab(tab, scratchDir));
    const targets = state.tabs.filter(
      (tab) => tab.tabType !== "welcome" && (tab.isDirty || !hasUserPath(tab)),
    );
    if (targets.length === 0) return;

    // Save existing-path tabs first so one unsaved-tab Save-As cancel does not
    // prevent already-named files from being written.
    const withPath = targets.filter(hasUserPath);
    const withoutPath = targets.filter((tab) => !hasUserPath(tab));
    const orderedTargets = [...withPath, ...withoutPath];

    const savedPaths: string[] = [];
    for (const tab of orderedTargets) {
      const result = await saveTab(tab);
      // Cancelling the Save-As dialog for one untitled tab should not abort
      // the rest of the batch. Skip the cancelled tab and keep going so users
      // never lose 4 saves because they cancelled the 1 prompt for an
      // untitled scratch buffer.
      if (result.cancelled) continue;
      if (result.saved && result.path) {
        savedPaths.push(result.path);
      }
    }

    if (savedPaths.length > 0) {
      const recent = mergeRecentFilePaths(
        state.settings.recentFiles,
        [...savedPaths].reverse(),
        state.settings.maxRecentFiles ?? 20,
      );
      dispatch({
        type: "SET_SETTINGS",
        settings: { ...state.settings, recentFiles: recent },
      });
    }
  }, [state.tabs, state.settings, saveTab, dispatch]);

  const finalizeCloseTab = useCallback(
    async (tab: EditorTab, choice: CloseScratchChoice): Promise<boolean> => {
      const scratchDir = scratchDirRef.current;
      const scratchPath =
        scratchDir && (isUntitledScratchCandidate(tab) || isScratchBackedTab(tab, scratchDir))
          ? tab.filePath || scratchPathForTab(scratchDir, tab.id)
          : tab.filePath;

      if (choice === "cancel") return false;

      // Cancel any pending scratch auto-save for this tab so a late debounced
      // write can't resurrect content the user is discarding/closing (S3-16).
      const pendingTimer = scratchSaveTimersRef.current.get(tab.id);
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        scratchSaveTimersRef.current.delete(tab.id);
      }

      if (choice === "save-as") {
        const result = await saveTab(tab);
        if (!result.saved) return false;
        if (scratchPath && result.path && result.path !== scratchPath) {
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

      if (state.tabs.length > 1) {
        dispatch({ type: "CLOSE_TAB", id: tab.id });
      }
      return true;
    },
    [dispatch, saveTab, state.tabs.length],
  );

  const requestCloseTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab || state.tabs.length <= 1) return false;

      const scratchDir = scratchDirRef.current;
      const isScratchTab =
        tab.isDirty &&
        (isUntitledScratchCandidate(tab) ||
          (scratchDir ? isScratchBackedTab(tab, scratchDir) : false));

      if (isScratchTab) {
        return new Promise((resolve) => {
          setCloseScratchPrompt({
            tab,
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

  const runScript = useCallback(async () => {
    // BUG-NEW-2 fix: welcome tabs have no runnable content; guard here so
    // F5 does not submit an empty script. The Run button is also disabled
    // for welcome tabs (see Toolbar.tsx).
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome" || state.isRunning) {
      return;
    }

    dispatch({ type: "SET_BOTTOM_TAB", tab: "terminal" });

    if (!state.selectedPsPath) {
      await writeTerminalNotice(
        "[PSForge] Run failed: no PowerShell executable is selected.",
        { reveal: true },
      );
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

    // Identity of the tab actually being executed, captured up front so the
    // completion callback can't mislabel the run when the user switches tabs
    // while the script is running (S6-3). Updated below if auto-save-on-run
    // assigns a scratch path to a previously untitled tab.
    let recordScriptPath = tab.filePath;
    const recordTabTitle = tab.title;

    // Auto-save before running when the setting is enabled (Rule 11 -- pre-flight).
    if (state.settings.autoSaveOnRun && tab.isDirty) {
      let savePath = tab.filePath;
      if (!savePath && state.settings.autoSaveScratchScripts !== false) {
        const scratchDir = scratchDirRef.current;
        if (scratchDir) {
          savePath = scratchPathForTab(scratchDir, tab.id);
        }
      }
      // Auto-save must not silently clobber external edits either (S6-10);
      // skip the save (the run still uses the in-memory buffer) and tell the
      // user why the tab is still dirty.
      if (
        savePath &&
        savePath === tab.filePath &&
        (await fileChangedOnDisk(tab))
      ) {
        void writeTerminalNotice(
          `[PSForge] Auto-save skipped: "${basename(savePath)}" changed on disk since it was opened. Save manually to resolve.`,
          { reveal: false },
        );
        savePath = "";
      }
      if (savePath) {
        try {
          const saveWarning = await cmd.saveFileContent(
            savePath,
            tab.content,
            tab.encoding,
          );
          let savedBaseline = tab.content;
          if (saveWarning) {
            void writeTerminalNotice(`[PSForge] ${saveWarning}`, {
              reveal: true,
            });
            // Re-read after a lossy encode so the baseline matches disk and
            // fileChangedOnDisk doesn't flag our own save (S6-16).
            try {
              savedBaseline = (await cmd.readFileContent(savePath)).content;
            } catch {
              // Keep the buffer baseline.
            }
          }
          dispatch({
            type: "UPDATE_TAB",
            id: tab.id,
            changes: {
              // Keep the friendly title; a scratch save is an internal backing
              // store, not a user-chosen save location (S3-17).
              filePath: savePath,
              savedContent: savedBaseline,
              isDirty: false,
            },
          });
          recordScriptPath = savePath;
        } catch {
          // Save failed -- continue running with unsaved content
        }
      }
    }

    // Snapshot execution parameters before any async gap so closures below
    // always use the values that were active at the moment Run was pressed.
    const psPath = state.selectedPsPath;
    const scriptContent = tab.content;

    // Determine working directory early (needed even if param dialog cancels).
    const workDir = resolveExecutionWorkDirWithOverride(
      tab,
      state.workingDir,
      state.settings,
      platformHomeFallback,
      runWorkingDirOverrideRef.current ?? undefined,
    );
    runWorkingDirOverrideRef.current = null;

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

      // The backend skips parameter inspection silently for scripts >32 KB
      // (Windows env-var size limit). If the script clearly declares a
      // `param(` block but the inspector returned nothing, surface a hint
      // so the user understands why the prompt didn't appear and is not
      // confused by a cryptic PowerShell binding error mid-run.
      if (allParams.length === 0 && /\bparam\s*\(/i.test(scriptContent)) {
        if (scriptContent.length > 32_000) {
          void writeTerminalNotice(
            "[PSForge] Script is too large to inspect parameters before running. " +
              "Mandatory parameters will not be prompted for; supply them in the script or via splatting.",
            { reveal: false },
          );
        }
      }

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

    const pssaErrors = (state.problems[tab.id] ?? []).filter((d) =>
      isPssaErrorSeverity(d.severity),
    );
    const pssaGate = state.settings.pssaRunGate ?? "warn";
    if (
      pssaErrors.length > 0 &&
      state.settings.enablePssa !== false &&
      pssaGate !== "off"
    ) {
      if (pssaGate === "block") {
        runGuardRef.current = false;
        await writeTerminalNotice(
          `[PSForge] Run blocked: ${pssaErrors.length} PSScriptAnalyzer error(s). See Reference → Problems.`,
          { reveal: true },
        );
        dispatch({
          type: "SET_BOTTOM_TAB",
          tab: "reference",
          referenceSubview: "problems",
        });
        return;
      }
      const runAnyway = await new Promise<boolean>((resolve) => {
        setPssaGatePrompt({ errors: pssaErrors, resolve });
      });
      setPssaGatePrompt(null);
      if (!runAnyway) {
        runGuardRef.current = false;
        return;
      }
    }

    dispatch({ type: "SET_VARIABLES", variables: [] });
    dispatch({ type: "SET_LAST_RUN_RESULT", result: null });
    dispatch({ type: "SET_RUNNING", running: true });

    const executeInTerminal = async (workingDir: string) => {
      const command = await cmd.prepareTerminalScriptCommand(
        psPath,
        scriptContent,
        workingDir,
        state.settings.executionPolicy,
        scriptArgs,
      );
      // The "copy last run output" baseline is captured inside the terminal
      // via a reflow/eviction-safe marker at run start (S3-13).
      return runCommandInTerminal(command, {
        clearBeforeRun: state.settings.clearOutputOnRun !== false,
        reveal: true,
      });
    };

    const runStartedAt = performance.now();
    const recordRunOutcome = (
      exitCode: number | null,
      workingDirForRecord: string,
    ) => {
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - runStartedAt),
      );
      dispatch({
        type: "SET_LAST_RUN_RESULT",
        result: { exitCode, durationMs },
      });
      dispatch({
        type: "APPEND_RUN_RECORD",
        record: {
          scriptPath: recordScriptPath,
          tabTitle: recordTabTitle,
          exitCode,
          durationMs,
          runAt: new Date().toISOString(),
          workingDir: workingDirForRecord,
        },
      });
    };

    try {
      const exitCode = await executeInTerminal(workDir);
      recordRunOutcome(exitCode, workDir);
    } catch (err) {
      if (
        state.settings.workingDirMode !== "custom" &&
        state.settings.workingDirMode !== "pinned" &&
        isInvalidWorkingDirError(err)
      ) {
        const fallbackWorkDir = resolveFallbackWorkDir(tab);
        if (fallbackWorkDir !== workDir) {
          await writeTerminalNotice(
            `[PSForge] Working directory "${workDir}" is unavailable; retrying from "${fallbackWorkDir}".`,
            { reveal: true },
          );
          dispatch({ type: "SET_WORKING_DIR", dir: fallbackWorkDir });
          try {
            const exitCode = await executeInTerminal(fallbackWorkDir);
            recordRunOutcome(exitCode, fallbackWorkDir);
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
      }

      console.error("runScript failed:", err);
      const message = extractInvokeErrorMessage(err);
      await writeTerminalNotice(`[PSForge] Run failed: ${message}`, {
        reveal: true,
      });
      recordRunOutcome(null, workDir);
    } finally {
      runGuardRef.current = false;
      dispatch({ type: "SET_RUNNING", running: false });
    }
  }, [
    state.isRunning,
    state.selectedPsPath,
    state.workingDir,
    state.settings,
    state.problems,
    setParamPrompt,
    dispatch,
    runCommandInTerminal,
    writeTerminalNotice,
    fileChangedOnDisk,
  ]);

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
          const tab: EditorTab = {
            id: candidate.tabId,
            title: basename(candidate.path),
            filePath: candidate.path,
            content: file.content,
            savedContent: file.content,
            encoding: file.encoding,
            language: "powershell",
            isDirty: false,
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

  const startDebugSession = useCallback(async () => {
    if (!activeTab || activeTab.tabType === "welcome" || state.isRunning) {
      return;
    }

    if (!state.selectedPsPath) {
      await writeTerminalNotice(
        "[PSForge] Debug failed: no PowerShell executable is selected.",
        { reveal: true },
      );
      return;
    }

    if (runGuardRef.current) return;
    runGuardRef.current = true;
    debugSessionRef.current = true;
    debugLocationRef.current = null;

    // Auto-save before debugging when enabled. Same external-change guard as
    // runScript's auto-save: never silently clobber edits made outside
    // PSForge — skip the save and debug the in-memory buffer (S6-17).
    if (
      state.settings.autoSaveOnRun &&
      activeTab.isDirty &&
      activeTab.filePath
    ) {
      if (await fileChangedOnDisk(activeTab)) {
        void writeTerminalNotice(
          `[PSForge] Auto-save skipped: "${basename(activeTab.filePath)}" changed on disk since it was opened. Save manually to resolve.`,
          { reveal: false },
        );
      } else {
        try {
          const saveWarning = await cmd.saveFileContent(
            activeTab.filePath,
            activeTab.content,
            activeTab.encoding,
          );
          let savedBaseline = activeTab.content;
          if (saveWarning) {
            void writeTerminalNotice(`[PSForge] ${saveWarning}`, {
              reveal: true,
            });
            // Re-read after a lossy encode so the baseline matches disk (S6-16).
            try {
              savedBaseline = (await cmd.readFileContent(activeTab.filePath))
                .content;
            } catch {
              // Keep the buffer baseline.
            }
          }
          dispatch({
            type: "UPDATE_TAB",
            id: activeTab.id,
            changes: { savedContent: savedBaseline, isDirty: false },
          });
        } catch {
          // Save failed -- continue with in-memory content.
        }
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
      state.settings.pinnedRunDir ?? "",
      platformHomeFallback,
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
    dispatch({ type: "SET_LAST_RUN_RESULT", result: null });
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
          await writeTerminalNotice(
            `[PSForge] Working directory "${workDir}" is unavailable; retrying debug session from "${fallbackWorkDir}".`,
            { reveal: true },
          );
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
      await writeTerminalNotice(`[PSForge] Debug failed: ${message}`, {
        reveal: true,
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
    writeTerminalNotice,
    fileChangedOnDisk,
  ]);

  /** Shared continue/step dispatcher. The pause refs are synced alongside
   *  every dispatch: the error path calls refreshDebugInspector in the same
   *  tick as its re-pause dispatch, so a state/effect-lagged ref would still
   *  read paused=false and the refresh would silently no-op (S6-15 — same
   *  mechanism S6-14 fixed at the breakpoint-hit sites). */
  const sendDebugCommand = useCallback(
    async (send: () => Promise<void>) => {
      if (!isDebuggingRef.current || !debugPausedRef.current) return;
      debugPausedRef.current = false;
      dispatch({ type: "SET_DEBUG_STATE", debugPaused: false });
      dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
      try {
        await send();
      } catch {
        debugPausedRef.current = true;
        dispatch({ type: "SET_DEBUG_STATE", debugPaused: true });
        void refreshDebugInspector();
      }
    },
    [dispatch, refreshDebugInspector],
  );

  const debugContinue = useCallback(
    () => sendDebugCommand(cmd.debugContinue),
    [sendDebugCommand],
  );
  const debugStepOver = useCallback(
    () => sendDebugCommand(cmd.debugStepOver),
    [sendDebugCommand],
  );
  const debugStepInto = useCallback(
    () => sendDebugCommand(cmd.debugStepInto),
    [sendDebugCommand],
  );
  const debugStepOut = useCallback(
    () => sendDebugCommand(cmd.debugStepOut),
    [sendDebugCommand],
  );

  const runOrDebugScript = useCallback(() => {
    if (state.isDebugging && state.debugPaused) {
      void debugContinue();
      return;
    }

    // Read the live active tab via ref, not the closed-over `activeTab`.
    // pasteFromClipboardAsNewScript schedules this via setTimeout right after
    // adding a new tab, so the closure's `activeTab` is still the previous
    // (Welcome) tab and would otherwise early-return, never auto-running the
    // pasted script (S3-3). runScript/startDebugSession already use the ref.
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome") return;
    const breakpoints = state.breakpoints[tab.id] ?? [];
    if (breakpoints.length > 0) {
      void startDebugSession();
      return;
    }
    void runScript();
  }, [
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
    if (debugSessionRef.current || state.isDebugging) {
      // Await the backend kill so we can report failures rather than silently
      // claiming "not running" while the process keeps streaming output. The
      // run state itself is driven by `ps-complete`, but we only flip the
      // debug-paused flag immediately so the inspector clears.
      void cmd.stopScript().catch(async (err) => {
        const message = extractInvokeErrorMessage(err);
        await writeTerminalNotice(
          `[PSForge] Stop request failed: ${message}. The script may still be running.`,
          { reveal: true },
        );
      });
      // Clear inspector immediately so the UI looks responsive; the Running
      // / Debugging flags wait for the actual exit event so we never lie
      // about the process state.
      dispatch({ type: "SET_DEBUG_STATE", debugPaused: false });
      dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
      return;
    }

    interruptTerminalCommand();
  }, [dispatch, interruptTerminalCommand, state.isDebugging, writeTerminalNotice]);

  const runSelection = useCallback(async () => {
    // Guard: welcome tabs have no Monaco editor, so stale selection from a
    // prior tab must not be submitted (mirrors the runScript guard).
    if (!activeTab || activeTab.tabType === "welcome" || state.isRunning)
      return;

    dispatch({ type: "SET_BOTTOM_TAB", tab: "terminal" });

    if (!state.selectedPsPath) {
      await writeTerminalNotice(
        "[PSForge] Selection run failed: no PowerShell executable is selected.",
        { reveal: true },
      );
      return;
    }

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

    dispatch({ type: "SET_VARIABLES", variables: [] });
    dispatch({ type: "SET_LAST_RUN_RESULT", result: null });
    dispatch({ type: "SET_RUNNING", running: true });

    const workDir = resolveExecutionWorkDir(
      activeTab,
      state.workingDir,
      state.settings.workingDirMode,
      state.settings.customWorkingDir,
      state.settings.pinnedRunDir ?? "",
      platformHomeFallback,
    );

    try {
      const command = await cmd.prepareTerminalScriptCommand(
        psPath,
        runText,
        workDir,
        state.settings.executionPolicy,
      );
      await runCommandInTerminal(command, {
        clearBeforeRun: state.settings.clearOutputOnRun !== false,
        reveal: true,
      });
    } catch (err) {
      if (
        state.settings.workingDirMode !== "custom" &&
        isInvalidWorkingDirError(err)
      ) {
        const fallbackWorkDir = resolveFallbackWorkDir(activeTab);
        if (fallbackWorkDir !== workDir) {
          await writeTerminalNotice(
            `[PSForge] Working directory "${workDir}" is unavailable; retrying selection from "${fallbackWorkDir}".`,
            { reveal: true },
          );
          dispatch({ type: "SET_WORKING_DIR", dir: fallbackWorkDir });
          try {
            const retryCommand = await cmd.prepareTerminalScriptCommand(
              psPath,
              runText,
              fallbackWorkDir,
              state.settings.executionPolicy,
            );
            await runCommandInTerminal(retryCommand, {
              clearBeforeRun: state.settings.clearOutputOnRun !== false,
              reveal: true,
            });
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
      }

      console.error("runSelection failed:", err);
      const message = extractInvokeErrorMessage(err);
      await writeTerminalNotice(`[PSForge] Selection run failed: ${message}`, {
        reveal: true,
      });
    } finally {
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
    runCommandInTerminal,
    writeTerminalNotice,
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
    w.__psforge_requestCloseTab = (tabId: string) => requestCloseTab(tabId);
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
                  : await finalizeCloseTab(closeScratchPrompt.tab, choice);
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
