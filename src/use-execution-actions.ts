import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "./commands";
import { basename, dirname } from "./path-utils";
import {
  extractInvokeErrorMessage,
  isPssaErrorSeverity,
  platformHomeFallback,
  resolveExecutionWorkDir,
  resolveExecutionWorkDirWithOverride,
} from "./run-utils";
import {
  buildDirectTerminalRunCommand,
  isSavedDiskScript,
} from "./direct-run";
import { isScratchBackedTab, scratchPathForTab } from "./scratch-utils";
import { hasScriptLevelParamBlock } from "./script-utils";
import type { Action, AppState } from "./store";
import type {
  DebugBreakpoint,
  DebugLocal,
  DebugStackFrame,
  DebugWatch,
  EditorTab,
  OutputLine,
  PssaDiagnostic,
  ScriptParameter,
  VariableInfo,
} from "./types";

const DEBUG_LOCALS_PREFIX = "<<PSF_DEBUG_LOCALS_JSON>>";
const DEBUG_STACK_PREFIX = "<<PSF_DEBUG_STACK_JSON>>";
const DEBUG_WATCH_PREFIX = "<<PSF_DEBUG_WATCH_JSON>>";

const DEBUG_STACK_COMMAND =
  "$__psf_stack = Get-PSCallStack | ForEach-Object { " +
  "[PSCustomObject]@{ " +
  "functionName = if ([string]::IsNullOrWhiteSpace($_.FunctionName)) { '<script>' } else { $_.FunctionName }; " +
  "location = if ($_.ScriptName) { \"$($_.ScriptName):$($_.ScriptLineNumber)\" } else { 'Interactive' }; " +
  "command = if ($_.Command) { $_.Command } else { '' } " +
  "} }; " +
  `Write-Host ('${DEBUG_STACK_PREFIX}' + ($__psf_stack | ConvertTo-Json -Compress -Depth 4))`;

type TerminalRunOptions = {
  clearBeforeRun?: boolean;
  reveal?: boolean;
};

type ParamPromptState = {
  params: ScriptParameter[];
  resolve: (values: Record<string, string> | null) => void;
} | null;

type PssaGatePromptState = {
  errors: PssaDiagnostic[];
  resolve: (proceed: boolean) => void;
} | null;

export type ExecutionActions = {
  paramPrompt: ParamPromptState;
  pssaGatePrompt: PssaGatePromptState;
  saveTab: (
    tab: EditorTab,
  ) => Promise<{ saved: boolean; cancelled: boolean; path?: string }>;
  saveCurrentFile: () => Promise<void>;
  saveAllFiles: () => Promise<void>;
  runScript: () => Promise<void>;
  startDebugSession: () => Promise<void>;
  runOrDebugScript: () => void;
  runSelection: () => Promise<void>;
  stopExecution: () => void;
  debugContinue: () => Promise<void>;
  debugStepOver: () => Promise<void>;
  debugStepInto: () => Promise<void>;
  debugStepOut: () => Promise<void>;
  evaluateDebugWatch: (
    expression: string,
    frameIndex?: number,
  ) => Promise<void>;
  refreshDebugInspector: (frameIndex?: number) => Promise<void>;
  selectDebugFrame: (frameIndex: number) => Promise<void>;
};

type UseExecutionActionsOptions = {
  state: AppState;
  dispatch: Dispatch<Action>;
  activeTab: EditorTab | undefined;
  activeTabRef: MutableRefObject<EditorTab | undefined>;
  scratchDirRef: MutableRefObject<string>;
  runWorkingDirOverrideRef: MutableRefObject<string | null>;
  runCommandInTerminal: (
    command: string,
    options?: TerminalRunOptions,
  ) => Promise<number | null>;
  writeTerminalNotice: (
    text: string,
    options?: { reveal?: boolean },
  ) => Promise<void>;
  interruptTerminalCommand: () => void;
};

function buildScriptArgs(
  params: ScriptParameter[],
  paramValues: Record<string, string>,
): string[] {
  const args: string[] = [];
  for (const param of params) {
    const raw = paramValues[param.name] ?? "";
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
      args.push(`-${param.name}:$${lower === "false" || lower === "0" || lower === "no" ? "false" : "true"}`);
      continue;
    }

    if (isSecure) {
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

function normalizeFrameIndex(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
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

function escapeForSingleQuotedPsLiteral(value: string): string {
  return value.replace(/'/g, "''");
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

export function useExecutionActions({
  state,
  dispatch,
  activeTab,
  activeTabRef,
  scratchDirRef,
  runWorkingDirOverrideRef,
  runCommandInTerminal,
  writeTerminalNotice,
  interruptTerminalCommand,
}: UseExecutionActionsOptions): ExecutionActions {
  const [paramPrompt, setParamPrompt] = useState<ParamPromptState>(null);
  const [pssaGatePrompt, setPssaGatePrompt] =
    useState<PssaGatePromptState>(null);
  const stateRef = useRef(state);
  const runGuardRef = useRef(false);
  const debugSessionRef = useRef(false);
  const debugLocationRef = useRef<{ line: number; column: number } | null>(
    null,
  );
  const debugWatchesRef = useRef<DebugWatch[]>(state.debugWatches);
  const debugSelectedFrameRef = useRef<number>(state.debugSelectedFrame);
  const isDebuggingRef = useRef(state.isDebugging);
  const debugPausedRef = useRef(state.debugPaused);
  const breakpointsRef = useRef(state.breakpoints);

  stateRef.current = state;
  activeTabRef.current = activeTab;
  debugLocationRef.current =
    state.debugLine && state.debugColumn
      ? { line: state.debugLine, column: state.debugColumn }
      : null;
  debugWatchesRef.current = state.debugWatches;
  debugSelectedFrameRef.current = normalizeFrameIndex(state.debugSelectedFrame);
  // isDebuggingRef / debugPausedRef are NOT mirrored from state here: break
  // handlers set them synchronously in the same tick as dispatch, and an
  // unrelated re-render before the reducer commits would wipe them back to
  // the previous state (refresh/Continue no-op — same failure class as S6-14).
  breakpointsRef.current = state.breakpoints;

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
      const scratchDir = scratchDirRef.current;
      const isScratchPath =
        !!scratchDir && !!tab.filePath && isScratchBackedTab(tab, scratchDir);
      let filePath = isScratchPath ? "" : tab.filePath;

      if (!filePath) {
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

        const dir = dirname(filePath);
        if (dir) dispatch({ type: "SET_WORKING_DIR", dir });

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
        void writeTerminalNotice(
          `[PSForge] Save failed for "${tab.title}": ${extractInvokeErrorMessage(err)}`,
          { reveal: true },
        );
        return { saved: false, cancelled: false };
      }
    },
    [dispatch, fileChangedOnDisk, scratchDirRef, writeTerminalNotice],
  );

  const saveCurrentFile = useCallback(async () => {
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome") return;
    const result = await saveTab(tab);
    if (!result.saved || !result.path) return;
    dispatch({ type: "MERGE_RECENT_FILES", paths: [result.path] });
  }, [activeTabRef, dispatch, saveTab]);

  const saveAllFiles = useCallback(async () => {
    const current = stateRef.current;
    const scratchDir = scratchDirRef.current;
    const hasUserPath = (tab: EditorTab) =>
      !!tab.filePath && !(scratchDir && isScratchBackedTab(tab, scratchDir));
    const targets = current.tabs.filter(
      (tab) => tab.tabType !== "welcome" && (tab.isDirty || !hasUserPath(tab)),
    );
    if (targets.length === 0) return;

    const withPath = targets.filter(hasUserPath);
    const withoutPath = targets.filter((tab) => !hasUserPath(tab));
    const orderedTargets = [...withPath, ...withoutPath];

    const savedPaths: string[] = [];
    for (const tab of orderedTargets) {
      const result = await saveTab(tab);
      if (result.cancelled) continue;
      if (result.saved && result.path) savedPaths.push(result.path);
    }

    if (savedPaths.length > 0) {
      dispatch({
        type: "MERGE_RECENT_FILES",
        paths: [...savedPaths].reverse(),
      });
    }
  }, [dispatch, saveTab, scratchDirRef]);

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

      if (/\[DBG\]:.*>>$/.test(trimmed)) {
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
      const line = event.payload;
      const hasLine = Number.isFinite(line) && line >= 1;
      debugLocationRef.current = hasLine ? { line, column: 1 } : null;
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

  const runScript = useCallback(async () => {
    // One-shot re-run override: consume it before any guard can return early,
    // so a blocked run (already running, no shell selected) can never leak a
    // historic working directory into a later unrelated run.
    const workDirOverride = runWorkingDirOverrideRef.current;
    runWorkingDirOverrideRef.current = null;

    const current = stateRef.current;
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome" || current.isRunning) return;

    dispatch({ type: "SET_BOTTOM_TAB", tab: "terminal" });

    if (!current.selectedPsPath) {
      await writeTerminalNotice(
        "[PSForge] Run failed: no PowerShell executable is selected.",
        { reveal: true },
      );
      return;
    }

    if (runGuardRef.current) return;
    runGuardRef.current = true;
    debugSessionRef.current = false;
    debugLocationRef.current = null;
    isDebuggingRef.current = false;
    debugPausedRef.current = false;
    dispatch({
      type: "SET_DEBUG_STATE",
      isDebugging: false,
      debugPaused: false,
      debugLine: null,
      debugColumn: null,
    });
    dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });

    let recordScriptPath = tab.filePath;
    const recordTabTitle = tab.title;

    // Flush dirty buffer before a live-console `& path` run (including scratch).
    // Untitled tabs pick up a scratch path when auto-scratch is on.
    const shouldFlushForRun =
      tab.isDirty &&
      (current.settings.autoSaveOnRun ||
        !!tab.filePath ||
        current.settings.autoSaveScratchScripts !== false);
    if (shouldFlushForRun) {
      let savePath = tab.filePath;
      if (!savePath && current.settings.autoSaveScratchScripts !== false) {
        const scratchDir = scratchDirRef.current;
        if (scratchDir) savePath = scratchPathForTab(scratchDir, tab.id);
      }
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
              filePath: savePath,
              savedContent: savedBaseline,
              isDirty: false,
            },
          });
          recordScriptPath = savePath;
        } catch {
          // Save failed; continue running with unsaved content via temp wrapper.
        }
      }
    }

    const psPath = current.selectedPsPath;
    const scriptContent = tab.content;
    const workDir = resolveExecutionWorkDirWithOverride(
      tab,
      current.workingDir,
      current.settings,
      platformHomeFallback,
      workDirOverride ?? undefined,
    );

    const directPath = isSavedDiskScript(
      tab,
      recordScriptPath,
      scratchDirRef.current,
    )
      ? recordScriptPath
      : "";

    let scriptArgs: string[] = [];
    if (!directPath) {
      try {
        const inspect = await cmd.getScriptParameters(psPath, scriptContent);
        const allParams = inspect.parameters ?? [];
        const required = allParams.filter((p) => p.isMandatory && !p.hasDefault);

        if (inspect.status === "error") {
          if (scriptContent.length > 32_000) {
            void writeTerminalNotice(
              "[PSForge] Script is too large to inspect parameters before running. " +
                "Mandatory parameters will not be prompted for; supply them in the script or via splatting.",
              { reveal: false },
            );
          } else if (hasScriptLevelParamBlock(scriptContent)) {
            runGuardRef.current = false;
            await writeTerminalNotice(
              "[PSForge] Run blocked: the script declares a param() block but PSForge could not read its parameters. " +
                "Fix any param-block syntax errors or supply defaults before running.",
              { reveal: true },
            );
            return;
          }
        }

        if (required.length > 0) {
          const paramValues = await new Promise<Record<string, string> | null>(
            (resolve) => {
              setParamPrompt({ params: required, resolve });
            },
          );
          setParamPrompt(null);

          if (paramValues === null) {
            runGuardRef.current = false;
            return;
          }

          scriptArgs = buildScriptArgs(required, paramValues);
        }
      } catch {
        // Parameter detection failed; run the script as-is.
      }
    }

    const pssaErrors = (current.problems[tab.id] ?? []).filter((d) =>
      isPssaErrorSeverity(d.severity),
    );
    const pssaGate = current.settings.pssaRunGate ?? "warn";
    if (
      pssaErrors.length > 0 &&
      current.settings.enablePssa !== false &&
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
      const command = directPath
        ? buildDirectTerminalRunCommand({
            scriptPath: directPath,
            workingDir,
            executionPolicy: current.settings.executionPolicy,
            scriptArgs,
          })
        : await cmd.prepareTerminalScriptCommand(
            psPath,
            scriptContent,
            workingDir,
            current.settings.executionPolicy,
            scriptArgs,
            tab.title,
          );
      return runCommandInTerminal(command, {
        clearBeforeRun: current.settings.clearOutputOnRun !== false,
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
        current.settings.workingDirMode !== "custom" &&
        current.settings.workingDirMode !== "pinned" &&
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
    activeTabRef,
    dispatch,
    fileChangedOnDisk,
    runCommandInTerminal,
    runWorkingDirOverrideRef,
    scratchDirRef,
    writeTerminalNotice,
  ]);

  const startDebugSession = useCallback(async () => {
    const current = stateRef.current;
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome" || current.isRunning) return;

    if (!current.selectedPsPath) {
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

    if (current.settings.autoSaveOnRun && tab.isDirty && tab.filePath) {
      if (await fileChangedOnDisk(tab)) {
        void writeTerminalNotice(
          `[PSForge] Auto-save skipped: "${basename(tab.filePath)}" changed on disk since it was opened. Save manually to resolve.`,
          { reveal: false },
        );
      } else {
        try {
          const saveWarning = await cmd.saveFileContent(
            tab.filePath,
            tab.content,
            tab.encoding,
          );
          let savedBaseline = tab.content;
          if (saveWarning) {
            void writeTerminalNotice(`[PSForge] ${saveWarning}`, {
              reveal: true,
            });
            try {
              savedBaseline = (await cmd.readFileContent(tab.filePath)).content;
            } catch {
              // Keep the buffer baseline.
            }
          }
          dispatch({
            type: "UPDATE_TAB",
            id: tab.id,
            changes: { savedContent: savedBaseline, isDirty: false },
          });
        } catch {
          // Save failed; continue with in-memory content.
        }
      }
    }

    const psPath = current.selectedPsPath;
    const scriptContent = tab.content;
    const breakpoints: DebugBreakpoint[] = (current.breakpoints[tab.id] ?? [])
      .map((bp) => normalizeBreakpointForDebug(bp))
      .filter((bp): bp is DebugBreakpoint => bp !== null);

    const workDir = resolveExecutionWorkDir(
      tab,
      current.workingDir,
      current.settings.workingDirMode,
      current.settings.customWorkingDir,
      current.settings.pinnedRunDir ?? "",
      platformHomeFallback,
    );

    let scriptArgs: string[] = [];
    try {
      const inspect = await cmd.getScriptParameters(psPath, scriptContent);
      const allParams = inspect.parameters ?? [];
      const required = allParams.filter((p) => p.isMandatory && !p.hasDefault);
      if (inspect.status === "error" && hasScriptLevelParamBlock(scriptContent)) {
        runGuardRef.current = false;
        debugSessionRef.current = false;
        isDebuggingRef.current = false;
        debugPausedRef.current = false;
        dispatch({
          type: "SET_DEBUG_STATE",
          isDebugging: false,
          debugPaused: false,
          debugLine: null,
          debugColumn: null,
        });
        dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
        await writeTerminalNotice(
          "[PSForge] Debug blocked: the script declares a param() block but PSForge could not read its parameters. " +
            "Fix any param-block syntax errors or supply defaults before debugging.",
          { reveal: true },
        );
        return;
      }
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
          isDebuggingRef.current = false;
          debugPausedRef.current = false;
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
    isDebuggingRef.current = true;
    debugPausedRef.current = false;
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

    const runStartedAt = performance.now();
    const recordDebugOutcome = (exitCode: number | null) => {
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - runStartedAt),
      );
      dispatch({
        type: "SET_LAST_RUN_RESULT",
        result: { exitCode, durationMs },
      });
    };

    try {
      const exitCode = await cmd.executeScriptDebug(
        psPath,
        scriptContent,
        workDir,
        current.settings.executionPolicy,
        breakpoints,
        scriptArgs,
        current.settings.persistRunspaceBetweenRuns !== false,
      );
      recordDebugOutcome(exitCode);
    } catch (err) {
      if (
        current.settings.workingDirMode !== "custom" &&
        current.settings.workingDirMode !== "pinned" &&
        isInvalidWorkingDirError(err)
      ) {
        const fallbackWorkDir = resolveFallbackWorkDir(tab);
        if (fallbackWorkDir !== workDir) {
          await writeTerminalNotice(
            `[PSForge] Working directory "${workDir}" is unavailable; retrying debug session from "${fallbackWorkDir}".`,
            { reveal: true },
          );
          dispatch({ type: "SET_WORKING_DIR", dir: fallbackWorkDir });
          try {
            const exitCode = await cmd.executeScriptDebug(
              psPath,
              scriptContent,
              fallbackWorkDir,
              current.settings.executionPolicy,
              breakpoints,
              scriptArgs,
              current.settings.persistRunspaceBetweenRuns !== false,
            );
            recordDebugOutcome(exitCode);
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
      recordDebugOutcome(null);
    } finally {
      // Don't rely solely on ps-complete delivery to unstick the UI: invoke
      // resolution is the ground truth that the debug host finished.
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
    }
  }, [activeTabRef, dispatch, fileChangedOnDisk, writeTerminalNotice]);

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
    if (isDebuggingRef.current && debugPausedRef.current) {
      void debugContinue();
      return;
    }

    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome") return;
    const breakpoints = breakpointsRef.current[tab.id] ?? [];
    if (breakpoints.length > 0) {
      void startDebugSession();
      return;
    }
    void runScript();
  }, [activeTabRef, debugContinue, runScript, startDebugSession]);

  const selectDebugFrame = useCallback(
    async (frameIndex: number) => {
      const next = normalizeFrameIndex(frameIndex);
      dispatch({ type: "SET_DEBUG_SELECTED_FRAME", frameIndex: next });
      // Use live pause/session refs: React state can lag the break handlers
      // (same failure class as S6-14 / S7-1).
      if (!isDebuggingRef.current) return;
      try {
        await cmd.debugSetFrame(next);
      } catch {
        // Non-fatal: inspector refresh still works via explicit scope.
      }
      if (debugPausedRef.current) void refreshDebugInspector(next);
    },
    [dispatch, refreshDebugInspector],
  );

  const stopExecution = useCallback(() => {
    if (debugSessionRef.current || stateRef.current.isDebugging) {
      void cmd.stopScript().catch(async (err) => {
        const message = extractInvokeErrorMessage(err);
        await writeTerminalNotice(
          `[PSForge] Stop request failed: ${message}. The script may still be running.`,
          { reveal: true },
        );
      });
      dispatch({ type: "SET_DEBUG_STATE", debugPaused: false });
      dispatch({ type: "CLEAR_DEBUG_INSPECTOR_VALUES" });
      return;
    }

    interruptTerminalCommand();
  }, [dispatch, interruptTerminalCommand, writeTerminalNotice]);

  const runSelection = useCallback(async () => {
    const current = stateRef.current;
    const tab = activeTabRef.current;
    if (!tab || tab.tabType === "welcome" || current.isRunning) return;

    dispatch({ type: "SET_BOTTOM_TAB", tab: "terminal" });

    if (!current.selectedPsPath) {
      await writeTerminalNotice(
        "[PSForge] Selection run failed: no PowerShell executable is selected.",
        { reveal: true },
      );
      return;
    }

    if (runGuardRef.current) return;
    runGuardRef.current = true;

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

    const psPath = current.selectedPsPath;

    dispatch({ type: "SET_VARIABLES", variables: [] });
    dispatch({ type: "SET_LAST_RUN_RESULT", result: null });
    dispatch({ type: "SET_RUNNING", running: true });

    const workDir = resolveExecutionWorkDir(
      tab,
      current.workingDir,
      current.settings.workingDirMode,
      current.settings.customWorkingDir,
      current.settings.pinnedRunDir ?? "",
      platformHomeFallback,
    );

    const runStartedAt = performance.now();
    const recordSelectionOutcome = (exitCode: number | null) => {
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - runStartedAt),
      );
      dispatch({
        type: "SET_LAST_RUN_RESULT",
        result: { exitCode, durationMs },
      });
    };

    try {
      const command = await cmd.prepareTerminalScriptCommand(
        psPath,
        runText,
        workDir,
        current.settings.executionPolicy,
        [],
        `${tab.title} (selection)`,
      );
      const exitCode = await runCommandInTerminal(command, {
        clearBeforeRun: current.settings.clearOutputOnRun !== false,
        reveal: true,
      });
      recordSelectionOutcome(exitCode);
    } catch (err) {
      if (
        current.settings.workingDirMode !== "custom" &&
        current.settings.workingDirMode !== "pinned" &&
        isInvalidWorkingDirError(err)
      ) {
        const fallbackWorkDir = resolveFallbackWorkDir(tab);
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
              current.settings.executionPolicy,
              [],
              `${tab.title} (selection)`,
            );
            const exitCode = await runCommandInTerminal(retryCommand, {
              clearBeforeRun: current.settings.clearOutputOnRun !== false,
              reveal: true,
            });
            recordSelectionOutcome(exitCode);
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
      recordSelectionOutcome(null);
    } finally {
      runGuardRef.current = false;
      dispatch({ type: "SET_RUNNING", running: false });
    }
  }, [activeTabRef, dispatch, runCommandInTerminal, writeTerminalNotice]);

  return {
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
  };
}
