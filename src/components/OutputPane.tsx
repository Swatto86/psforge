/** PSForge bottom pane.
 *  Hosts the integrated terminal plus debugger and variable inspector tools.
 */

import React, { useEffect, useState, useCallback } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type {
  VariableInfo,
  DebugBreakpoint,
  DebugLocal,
  DebugStackFrame,
  DebugWatch,
} from "../types";
import { TerminalPane } from "./TerminalPane";
import { ShowCommandPane } from "./ShowCommandPane";
import { HelpPane } from "./HelpPane";

function breakpointLabel(bp: DebugBreakpoint): string {
  if (typeof bp.line === "number") return `Ln ${bp.line}`;
  if (bp.targetCommand) return `Command ${bp.targetCommand}`;
  const mode = bp.mode ?? "ReadWrite";
  return `$${bp.variable ?? "?"} (${mode})`;
}

function breakpointKey(bp: DebugBreakpoint): string {
  if (typeof bp.line === "number") return `line:${bp.line}`;
  if (bp.targetCommand) return `cmd:${bp.targetCommand.toLowerCase()}`;
  return `var:${bp.mode ?? "ReadWrite"}:${bp.variable ?? ""}`;
}

function summarizeBreakpointOptions(bp: DebugBreakpoint): string {
  const parts: string[] = [];
  if (bp.condition) parts.push(`if ${bp.condition}`);
  if (bp.hitCount && bp.hitCount > 1) parts.push(`hit >= ${bp.hitCount}`);
  if (bp.command) parts.push("has action");
  return parts.join(" | ");
}

function formatCount(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

type BottomTabId =
  | "terminal"
  | "debugger"
  | "variables"
  | "show-command"
  | "help";

type BottomTabDescriptor = {
  id: BottomTabId;
  label: string;
  secondary?: boolean;
};

interface OutputPaneProps {
  onDebugStart: () => void;
  onDebugContinue: () => void;
  onDebugStepOver: () => void;
  onDebugStepInto: () => void;
  onDebugStepOut: () => void;
  onDebugSelectFrame: (frameIndex: number) => void;
  onDebugRefreshInspector: () => void;
  onDebugEvaluateWatch: (expression: string) => void;
  onStop: () => void;
}

export function OutputPane({
  onDebugStart,
  onDebugContinue,
  onDebugStepOver,
  onDebugStepInto,
  onDebugStepOut,
  onDebugSelectFrame,
  onDebugRefreshInspector,
  onDebugEvaluateWatch,
  onStop,
}: OutputPaneProps) {
  const { state, dispatch, activeTab } = useAppState();
  const [stdinInput, setStdinInput] = useState("");
  const [varFilter, setVarFilter] = useState("");

  const isDebuggerInputTab = state.bottomPanelTab === "debugger";
  const isStdinEnabled = state.isDebugging;
  const inputPrompt = "DBG>";

  const handleStdinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = stdinInput.trim();
    if (!value) return;
    try {
      await cmd.sendStdin(value);
      const writeNotice = (
        window as unknown as Record<string, unknown>
      ).__psforge_terminal_write_notice as
        | ((text: string, options?: { reveal?: boolean }) => Promise<void>)
        | undefined;
      void writeNotice?.(`${inputPrompt} ${value}\n`, { reveal: false });
      setStdinInput("");
    } catch {
      // Failed to send stdin.
    }
  };

  const typeColor = (typeName: string): string => {
    const lower = typeName.toLowerCase();
    if (lower === "string") return "var(--type-string)";
    if (lower.includes("int") || lower === "double" || lower === "decimal") {
      return "var(--type-int)";
    }
    if (lower === "boolean" || lower === "switchparameter") {
      return "var(--type-bool)";
    }
    return "var(--type-object)";
  };

  const filteredVars = state.variables.filter(
    (v) =>
      !varFilter ||
      v.name.toLowerCase().includes(varFilter.toLowerCase()) ||
      v.value.toLowerCase().includes(varFilter.toLowerCase()),
  );

  const handleAddDebugWatch = useCallback(
    (expression: string) => {
      const expr = expression.trim();
      if (!expr) return;
      dispatch({ type: "ADD_DEBUG_WATCH", expression: expr });
      if (state.isDebugging && state.debugPaused) {
        onDebugEvaluateWatch(expr);
      }
    },
    [dispatch, state.isDebugging, state.debugPaused, onDebugEvaluateWatch],
  );

  const handleRemoveDebugWatch = useCallback(
    (expression: string) => {
      dispatch({ type: "REMOVE_DEBUG_WATCH", expression });
    },
    [dispatch],
  );

  const navigateTo = useCallback((line: number, column: number) => {
    const nav = (window as unknown as Record<string, unknown>)
      .__psforge_navigateTo as ((l: number, c: number) => void) | undefined;
    nav?.(line, Math.max(1, column));
  }, []);

  const activeTabBreakpoints =
    activeTab && activeTab.tabType !== "welcome"
      ? (state.breakpoints[activeTab.id] ?? [])
      : [];

  const upsertActiveTabBreakpoint = useCallback(
    (breakpoint: DebugBreakpoint) => {
      if (!activeTab || activeTab.tabType === "welcome") return;
      dispatch({
        type: "UPSERT_BREAKPOINT",
        tabId: activeTab.id,
        breakpoint,
      });
    },
    [activeTab, dispatch],
  );

  const removeActiveTabBreakpoint = useCallback(
    (breakpoint: DebugBreakpoint) => {
      if (!activeTab || activeTab.tabType === "welcome") return;
      dispatch({
        type: "REMOVE_BREAKPOINT",
        tabId: activeTab.id,
        breakpoint,
      });
    },
    [activeTab, dispatch],
  );

  const primaryBottomTabs: BottomTabDescriptor[] = [
    { id: "terminal", label: "Terminal" },
  ];

  const utilityBottomTabs: BottomTabDescriptor[] = [
    { id: "variables", label: "Variables", secondary: true },
    { id: "debugger", label: "Debugger", secondary: true },
    { id: "show-command", label: "Show Command", secondary: true },
    { id: "help", label: "Help", secondary: true },
  ];

  const variableCountText = formatCount(state.variables.length, "variable");

  const activePaneMeta = (() => {
    switch (state.bottomPanelTab) {
      case "terminal":
        return {
          title: "Interactive Terminal",
          subtitle:
            "Run scripts, inspect errors, and use ad-hoc PowerShell commands in the same terminal session.",
          chipLabel: state.isRunning ? "Running" : "Terminal-first",
          chipTone: "accent",
        };
      case "variables":
        return {
          title: "Variables",
          subtitle:
            state.variables.length === 0
              ? "Variables captured after a script run will appear here."
              : `${variableCountText} captured from the last completed execution.`,
          chipLabel:
            state.variables.length === 0 ? "No variables" : variableCountText,
          chipTone: state.variables.length === 0 ? "default" : "accent",
        };
      case "debugger":
        return {
          title: "Debugger",
          subtitle:
            "Breakpoints, locals, call stack, and watches for the active debug session.",
          chipLabel: !state.isDebugging
            ? "Idle"
            : state.debugPaused
              ? "Paused"
              : "Active",
          chipTone: !state.isDebugging
            ? "default"
            : state.debugPaused
              ? "warn"
              : "accent",
        };
      case "show-command":
        return {
          title: "Show Command",
          subtitle:
            "Build command invocations visually and send them back to the editor.",
          chipLabel: "Utility",
          chipTone: "default",
        };
      case "help":
        return {
          title: "Help",
          subtitle:
            "Look up command help without leaving the editor workspace.",
          chipLabel: "Utility",
          chipTone: "default",
        };
    }
  })();

  const toolbarMeta = (() => {
    switch (state.bottomPanelTab) {
      case "terminal":
        return state.isRunning
          ? "Script execution is streaming directly into the integrated terminal."
          : "Use the terminal for both script execution and ad-hoc PowerShell commands.";
      case "variables":
        return state.variables.length === 0
          ? "Run a script to capture variables here."
          : `Showing ${formatCount(filteredVars.length, "match")} from ${variableCountText}.`;
      case "debugger":
        return !state.isDebugging
          ? "Start a debug session to inspect locals and watches here."
          : state.debugPaused
            ? "Debugger paused: step, continue, or inspect the current frame."
            : "Debugger active: controls will enable when execution pauses.";
      case "show-command":
        return "Build commands here and insert them back into the editor when ready.";
      case "help":
        return "Use inline help for command lookup without opening extra tools.";
    }
  })();

  const chipClassName =
    activePaneMeta.chipTone === "accent"
      ? "bottom-pane-chip bottom-pane-chip-accent"
      : activePaneMeta.chipTone === "warn"
        ? "bottom-pane-chip bottom-pane-chip-warn"
        : activePaneMeta.chipTone === "danger"
          ? "bottom-pane-chip bottom-pane-chip-danger"
          : "bottom-pane-chip";

  const actionButtonClassName = (
    options: { danger?: boolean; primary?: boolean } = {},
  ) => {
    const classNames = ["bottom-pane-action"];
    if (options.primary) classNames.push("bottom-pane-action-primary");
    if (options.danger) classNames.push("bottom-pane-action-danger");
    return classNames.join(" ");
  };

  const renderTabButton = (tab: BottomTabDescriptor) => {
    const isActive = state.bottomPanelTab === tab.id;
    let badgeText: string | null = null;
    let badgeClassName = "bottom-pane-badge";

    if (tab.id === "variables" && state.variables.length > 0) {
      badgeText = state.variables.length.toLocaleString();
      badgeClassName = "bottom-pane-badge bottom-pane-badge-accent";
    }
    if (tab.id === "debugger" && state.isDebugging) {
      badgeText = state.debugPaused ? "Paused" : "Active";
      badgeClassName = state.debugPaused
        ? "bottom-pane-badge bottom-pane-badge-warn"
        : "bottom-pane-badge bottom-pane-badge-accent";
    }

    return (
      <button
        key={tab.id}
        data-testid={`bottom-tab-${tab.id}`}
        onClick={() => {
          dispatch({ type: "SET_BOTTOM_TAB", tab: tab.id });
          if (tab.id === "terminal") {
            requestAnimationFrame(() => {
              (
                window as unknown as Record<string, () => void>
              ).__psforge_terminal_focus?.();
            });
          }
        }}
        className={[
          "bottom-pane-tab",
          isActive ? "bottom-pane-tab-active" : "",
          tab.secondary ? "bottom-pane-tab-secondary" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={tab.label}
      >
        <span>{tab.label}</span>
        {badgeText && <span className={badgeClassName}>{badgeText}</span>}
      </button>
    );
  };

  const showInputRow =
    state.bottomPanelTab === "debugger" && state.isDebugging;

  return (
    <div
      data-testid="bottom-pane"
      className="flex flex-col h-full bottom-pane-shell"
    >
      <div className="bottom-pane-header no-select text-sm">
        <div className="bottom-pane-heading">
          <div className="bottom-pane-title-row">
            <span className="bottom-pane-title">{activePaneMeta.title}</span>
            <span className={chipClassName}>{activePaneMeta.chipLabel}</span>
          </div>
          <div className="bottom-pane-subtitle">{activePaneMeta.subtitle}</div>
        </div>

        <div className="bottom-pane-tab-rails">
          <div className="bottom-pane-tab-group">
            {primaryBottomTabs.map(renderTabButton)}
          </div>
          <div className="bottom-pane-tab-group">
            {utilityBottomTabs.map(renderTabButton)}
          </div>
        </div>
      </div>

      <div className="bottom-pane-toolbar">
        <div className="bottom-pane-toolbar-meta">{toolbarMeta}</div>

        <div className="bottom-pane-action-group">
          {state.bottomPanelTab === "terminal" && (
            <>
              <button
                data-testid="terminal-clear-button"
                onClick={() =>
                  (
                    window as unknown as Record<string, () => void>
                  ).__psforge_terminal_clear?.()
                }
                className={actionButtonClassName()}
                title="Clear terminal output"
              >
                Clear
              </button>
              <button
                data-testid="terminal-restart-button"
                onClick={() =>
                  (
                    window as unknown as Record<string, () => void>
                  ).__psforge_terminal_restart?.()
                }
                className={actionButtonClassName()}
                title="Restart PowerShell session"
              >
                Restart Session
              </button>
            </>
          )}

          {state.bottomPanelTab === "debugger" && (
            <>
              <button
                onClick={onDebugStart}
                disabled={
                  state.isRunning ||
                  !state.selectedPsPath ||
                  !activeTab ||
                  activeTab.tabType === "welcome"
                }
                className={actionButtonClassName({ primary: true })}
                title="Start debugging"
              >
                Start
              </button>
              <button
                onClick={onDebugContinue}
                disabled={!state.isDebugging || !state.debugPaused}
                className={actionButtonClassName()}
                title="Continue (F5)"
              >
                Continue
              </button>
              <button
                onClick={onDebugStepOver}
                disabled={!state.isDebugging || !state.debugPaused}
                className={actionButtonClassName()}
                title="Step Over (F10)"
              >
                Step Over
              </button>
              <button
                onClick={onDebugStepInto}
                disabled={!state.isDebugging || !state.debugPaused}
                className={actionButtonClassName()}
                title="Step Into (F11)"
              >
                Step Into
              </button>
              <button
                onClick={onDebugStepOut}
                disabled={!state.isDebugging || !state.debugPaused}
                className={actionButtonClassName()}
                title="Step Out (Shift+F11)"
              >
                Step Out
              </button>
              <button
                onClick={onDebugRefreshInspector}
                disabled={!state.isDebugging || !state.debugPaused}
                className={actionButtonClassName()}
                title="Refresh locals, call stack, and watches"
              >
                Refresh
              </button>
              <button
                onClick={onStop}
                disabled={!state.isRunning}
                className={actionButtonClassName({ danger: true })}
                title="Stop (Shift+F5)"
              >
                Stop
              </button>
            </>
          )}

          {state.bottomPanelTab === "variables" && (
            <input
              data-testid="variables-filter"
              value={varFilter}
              onChange={(e) => setVarFilter(e.target.value)}
              placeholder="Filter variables..."
              className="bottom-pane-filter"
              style={{
                fontSize: `${state.settings.outputFontSize ?? 13}px`,
                fontFamily:
                  state.settings.outputFontFamily ??
                  "Cascadia Code, Consolas, monospace",
              }}
            />
          )}
        </div>
      </div>

      {/* Panel content — flex column so the terminal gets explicit height via flex:1 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          userSelect: "text",
          WebkitUserSelect: "text",
        }}
      >
        {state.bottomPanelTab === "variables" && (
          <div className="flex-1 min-h-0 overflow-auto">
            <VariableTable
              variables={filteredVars}
              typeColor={typeColor}
              fontSize={state.settings.outputFontSize ?? 13}
              fontFamily={
                state.settings.outputFontFamily ??
                "Cascadia Code, Consolas, monospace"
              }
            />
          </div>
        )}

        {state.bottomPanelTab === "debugger" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <DebuggerPane
              isRunning={state.isRunning}
              isDebugging={state.isDebugging}
              debugPaused={state.debugPaused}
              debugLine={state.debugLine}
              debugColumn={state.debugColumn}
              selectedFrameIndex={state.debugSelectedFrame}
              activeTabName={
                activeTab?.tabType === "code" ? activeTab.title : undefined
              }
              breakpoints={activeTabBreakpoints}
              locals={state.debugLocals}
              callStack={state.debugCallStack}
              watches={state.debugWatches}
              onNavigate={navigateTo}
              onSelectFrame={onDebugSelectFrame}
              onToggleBreakpoint={(line) => {
                if (!activeTab || activeTab.tabType === "welcome") return;
                dispatch({
                  type: "TOGGLE_BREAKPOINT",
                  tabId: activeTab.id,
                  line,
                });
              }}
              onUpsertBreakpoint={upsertActiveTabBreakpoint}
              onRemoveBreakpoint={removeActiveTabBreakpoint}
              onAddVariableBreakpoint={(variable, mode) =>
                upsertActiveTabBreakpoint({ variable, mode })
              }
              onAddCommandBreakpoint={(targetCommand) =>
                upsertActiveTabBreakpoint({ targetCommand })
              }
              onRefresh={onDebugRefreshInspector}
              onAddWatch={handleAddDebugWatch}
              onRemoveWatch={handleRemoveDebugWatch}
              onEvaluateWatch={onDebugEvaluateWatch}
              fontSize={state.settings.outputFontSize ?? 13}
              fontFamily={
                state.settings.outputFontFamily ??
                "Cascadia Code, Consolas, monospace"
              }
            />
          </div>
        )}

        {state.bottomPanelTab === "show-command" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <ShowCommandPane />
          </div>
        )}

        {state.bottomPanelTab === "help" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <HelpPane />
          </div>
        )}

        {/* TerminalPane is always mounted (never conditionally removed) so the
            xterm.js instance and PS session survive tab switches.
            When hidden: display:none removes it from layout without unmounting.
            When visible: flex:1 + minHeight:0 gives xterm an explicit height so
            FitAddon can calculate rows/cols correctly — display:contents caused
            height to collapse to 0 which prevented keyboard input. */}
        <div
          data-testid="terminal-panel"
          style={{
            display: state.bottomPanelTab === "terminal" ? "flex" : "none",
            flex: 1,
            minHeight: 0,
            flexDirection: "column",
          }}
        >
          <TerminalPane />
        </div>
      </div>

      {/* Debugger input row. */}
      {showInputRow && (
        <form
          onSubmit={handleStdinSubmit}
          className="flex items-center px-2 py-1 bottom-pane-input-row"
        >
          <span
            className="mr-1 text-xs"
            style={{ color: "var(--text-accent)" }}
          >
            {inputPrompt}
          </span>
          <input
            value={stdinInput}
            onChange={(e) => setStdinInput(e.target.value)}
            placeholder={
              isDebuggerInputTab && isStdinEnabled
                ? "Type debugger command or expression..."
                : "Debugger not active"
            }
            disabled={!isStdinEnabled}
            className="flex-1 text-xs font-mono"
            style={{
              backgroundColor: "transparent",
              border: "none",
              color: "var(--text-primary)",
              outline: "none",
              opacity: isStdinEnabled ? 1 : 0.5,
            }}
          />
        </form>
      )}
    </div>
  );
}

/** Renders text with basic ANSI escape code support. */
function AnsiText({ text, color }: { text: string; color: string }) {
  // Simple ANSI stripping for now - render raw text with stream color
  // A full ANSI parser could be added later
  const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  return <span style={{ color }}>{cleaned}</span>;
}

function DebuggerPane({
  isRunning,
  isDebugging,
  debugPaused,
  debugLine,
  debugColumn,
  selectedFrameIndex,
  activeTabName,
  breakpoints,
  locals,
  callStack,
  watches,
  onNavigate,
  onSelectFrame,
  onToggleBreakpoint,
  onUpsertBreakpoint,
  onRemoveBreakpoint,
  onAddVariableBreakpoint,
  onAddCommandBreakpoint,
  onRefresh,
  onAddWatch,
  onRemoveWatch,
  onEvaluateWatch,
  fontSize,
  fontFamily,
}: {
  isRunning: boolean;
  isDebugging: boolean;
  debugPaused: boolean;
  debugLine: number | null;
  debugColumn: number | null;
  selectedFrameIndex: number;
  activeTabName?: string;
  breakpoints: DebugBreakpoint[];
  locals: DebugLocal[];
  callStack: DebugStackFrame[];
  watches: DebugWatch[];
  onNavigate: (line: number, column: number) => void;
  onSelectFrame: (frameIndex: number) => void;
  onToggleBreakpoint: (line: number) => void;
  onUpsertBreakpoint: (breakpoint: DebugBreakpoint) => void;
  onRemoveBreakpoint: (breakpoint: DebugBreakpoint) => void;
  onAddVariableBreakpoint: (
    variable: string,
    mode: "Read" | "Write" | "ReadWrite",
  ) => void;
  onAddCommandBreakpoint: (targetCommand: string) => void;
  onRefresh: () => void;
  onAddWatch: (expression: string) => void;
  onRemoveWatch: (expression: string) => void;
  onEvaluateWatch: (expression: string) => void;
  fontSize: number;
  fontFamily: string;
}) {
  const [newWatchExpression, setNewWatchExpression] = useState("");
  const [newVariableName, setNewVariableName] = useState("");
  const [newVariableMode, setNewVariableMode] = useState<
    "Read" | "Write" | "ReadWrite"
  >("ReadWrite");
  const [newCommandName, setNewCommandName] = useState("");
  const [editingBreakpointKey, setEditingBreakpointKey] = useState<
    string | null
  >(null);
  const [editCondition, setEditCondition] = useState("");
  const [editHitCount, setEditHitCount] = useState("");
  const [editAction, setEditAction] = useState("");
  const [editVariableName, setEditVariableName] = useState("");
  const [editVariableMode, setEditVariableMode] = useState<
    "Read" | "Write" | "ReadWrite"
  >("ReadWrite");
  const [editCommandName, setEditCommandName] = useState("");
  const [editError, setEditError] = useState("");

  const fontStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily: `var(--ui-font-family, ${fontFamily})`,
  };
  const monoFontStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily,
  };

  const statusLabel = !isDebugging
    ? isRunning
      ? "Running (non-debug)"
      : "Idle"
    : debugPaused
      ? "Paused"
      : "Running";

  const statusColor = !isDebugging
    ? isRunning
      ? "var(--text-accent)"
      : "var(--text-muted)"
    : debugPaused
      ? "var(--stream-warning)"
      : "var(--text-accent)";
  const canInspect = isDebugging && debugPaused;
  const lineBreakpoints = breakpoints
    .filter((bp): bp is DebugBreakpoint & { line: number } => {
      return typeof bp.line === "number" && bp.line >= 1;
    })
    .sort((a, b) => a.line - b.line);
  const variableBreakpoints = breakpoints.filter(
    (bp): bp is DebugBreakpoint & { variable: string } =>
      typeof bp.variable === "string" && bp.variable.trim().length > 0,
  );
  const commandBreakpoints = breakpoints.filter(
    (bp): bp is DebugBreakpoint & { targetCommand: string } =>
      typeof bp.targetCommand === "string" &&
      bp.targetCommand.trim().length > 0,
  );
  const editingBreakpoint = editingBreakpointKey
    ? (breakpoints.find((bp) => breakpointKey(bp) === editingBreakpointKey) ??
      null)
    : null;

  const beginEditBreakpoint = useCallback((bp: DebugBreakpoint) => {
    setEditingBreakpointKey(breakpointKey(bp));
    setEditCondition(bp.condition ?? "");
    setEditHitCount(bp.hitCount ? String(bp.hitCount) : "");
    setEditAction(bp.command ?? "");
    setEditVariableName(bp.variable ?? "");
    setEditVariableMode(bp.mode ?? "ReadWrite");
    setEditCommandName(bp.targetCommand ?? "");
    setEditError("");
  }, []);

  const cancelEditBreakpoint = useCallback(() => {
    setEditingBreakpointKey(null);
    setEditCondition("");
    setEditHitCount("");
    setEditAction("");
    setEditVariableName("");
    setEditVariableMode("ReadWrite");
    setEditCommandName("");
    setEditError("");
  }, []);

  useEffect(() => {
    if (!editingBreakpointKey) return;
    const exists = breakpoints.some(
      (bp) => breakpointKey(bp) === editingBreakpointKey,
    );
    if (!exists) {
      cancelEditBreakpoint();
    }
  }, [breakpoints, editingBreakpointKey, cancelEditBreakpoint]);

  const saveEditedBreakpoint = useCallback(() => {
    if (!editingBreakpoint) return;

    const trimmedHit = editHitCount.trim();
    const parsedHit = parseInt(trimmedHit, 10);
    if (
      trimmedHit.length > 0 &&
      (!Number.isFinite(parsedHit) || parsedHit < 1)
    ) {
      setEditError("Hit count must be an integer >= 1.");
      return;
    }

    let updated: DebugBreakpoint = {
      ...editingBreakpoint,
      condition: editCondition.trim() || undefined,
      hitCount: trimmedHit.length > 0 ? parsedHit : undefined,
      command: editAction.trim() || undefined,
    };

    if (editingBreakpoint.variable) {
      const variable = editVariableName.trim().replace(/^\$/, "");
      if (!variable) {
        setEditError("Variable breakpoint name cannot be empty.");
        return;
      }
      updated = {
        ...updated,
        variable,
        mode: editVariableMode,
      };
    }

    if (editingBreakpoint.targetCommand) {
      const targetCommand = editCommandName.trim();
      if (!targetCommand) {
        setEditError("Command breakpoint target cannot be empty.");
        return;
      }
      updated = {
        ...updated,
        targetCommand,
      };
    }

    const oldKey = breakpointKey(editingBreakpoint);
    const newKey = breakpointKey(updated);
    if (oldKey !== newKey) {
      onRemoveBreakpoint(editingBreakpoint);
    }
    onUpsertBreakpoint(updated);
    setEditingBreakpointKey(newKey);
    setEditError("");
  }, [
    editingBreakpoint,
    editCondition,
    editHitCount,
    editAction,
    editVariableName,
    editVariableMode,
    editCommandName,
    onRemoveBreakpoint,
    onUpsertBreakpoint,
  ]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ line?: unknown }>).detail;
      const line =
        detail && typeof detail.line === "number" && detail.line >= 1
          ? Math.floor(detail.line)
          : null;
      if (!line) return;
      const existing = breakpoints.find((bp) => bp.line === line);
      if (existing) {
        beginEditBreakpoint(existing);
        return;
      }
      const created: DebugBreakpoint = { line };
      onUpsertBreakpoint(created);
      beginEditBreakpoint(created);
    };

    window.addEventListener(
      "psforge-edit-breakpoint",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "psforge-edit-breakpoint",
        handler as EventListener,
      );
  }, [breakpoints, beginEditBreakpoint, onUpsertBreakpoint]);

  const parseCallStackLocation = useCallback((location: string) => {
    const match = /:(\d+)(?::(\d+))?$/.exec(location.trim());
    if (!match) return null;
    const line = parseInt(match[1], 10);
    const column = match[2] ? parseInt(match[2], 10) : 1;
    if (!Number.isFinite(line) || line < 1) return null;
    return {
      line,
      column: Number.isFinite(column) && column > 0 ? column : 1,
    };
  }, []);

  return (
    <div
      data-testid="debugger-panel"
      className="h-full overflow-auto p-3"
      style={{ ...fontStyle, color: "var(--text-primary)" }}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: statusColor }}
        />
        <span style={{ fontWeight: 600 }}>Debugger Status:</span>
        <span>{statusLabel}</span>
      </div>

      <div className="mt-3">
        <div style={{ color: "var(--text-secondary)" }}>Current Location</div>
        {debugLine ? (
          <button
            data-testid="debugger-location-jump"
            onClick={() => onNavigate(debugLine, debugColumn ?? 1)}
            className="mt-1"
            style={{
              backgroundColor: "transparent",
              color: "var(--text-accent)",
              textDecoration: "underline",
              cursor: "pointer",
            }}
            title="Jump to current debug stop location"
          >
            Line {debugLine}
            {debugColumn ? `, Column ${debugColumn}` : ""}
          </button>
        ) : (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No stop location yet.
          </div>
        )}
      </div>

      <div className="mt-4">
        <div
          className="flex items-center justify-between gap-2"
          style={{ color: "var(--text-secondary)" }}
        >
          <span>Watch</span>
          <button
            onClick={onRefresh}
            disabled={!canInspect}
            style={{
              backgroundColor: "transparent",
              color: canInspect ? "var(--text-accent)" : "var(--text-muted)",
              cursor: canInspect ? "pointer" : "default",
            }}
            title="Refresh all watch values"
          >
            Refresh
          </button>
        </div>

        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const expr = newWatchExpression.trim();
            if (!expr) return;
            onAddWatch(expr);
            setNewWatchExpression("");
          }}
        >
          <input
            value={newWatchExpression}
            onChange={(e) => setNewWatchExpression(e.target.value)}
            placeholder="Add watch expression..."
            className="flex-1 px-2 py-1"
            style={{
              ...monoFontStyle,
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
              borderRadius: "2px",
            }}
          />
          <button
            type="submit"
            style={{
              backgroundColor: "transparent",
              color: "var(--text-accent)",
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </form>

        {watches.length === 0 ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No watch expressions yet.
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {watches.map((watch) => (
              <div
                key={watch.expression}
                className="rounded px-2 py-1"
                style={{
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <div className="flex items-center gap-2">
                  <code
                    style={{
                      ...monoFontStyle,
                      color: "var(--text-accent)",
                      flex: 1,
                      wordBreak: "break-word",
                    }}
                  >
                    {watch.expression}
                  </code>
                  <button
                    onClick={() => onEvaluateWatch(watch.expression)}
                    disabled={!canInspect}
                    style={{
                      backgroundColor: "transparent",
                      color: canInspect
                        ? "var(--text-secondary)"
                        : "var(--text-muted)",
                      cursor: canInspect ? "pointer" : "default",
                    }}
                    title="Evaluate watch expression now"
                  >
                    Eval
                  </button>
                  <button
                    onClick={() => onRemoveWatch(watch.expression)}
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                    title="Remove watch expression"
                  >
                    x
                  </button>
                </div>
                <div
                  className="mt-1"
                  style={{
                    ...monoFontStyle,
                    color: watch.error
                      ? "var(--stream-stderr)"
                      : watch.value
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {watch.error
                    ? `Error: ${watch.error}`
                    : watch.value ||
                      "Value unavailable (pause debugger to evaluate)."}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <div style={{ color: "var(--text-secondary)" }}>
          Call Stack (selected frame: {selectedFrameIndex})
        </div>
        {callStack.length === 0 ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No call stack available at the current state.
          </div>
        ) : (
          <table className="mt-2 w-full" style={monoFontStyle}>
            <thead>
              <tr
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  color: "var(--text-secondary)",
                }}
              >
                <th className="px-2 py-1 text-left font-medium">Function</th>
                <th className="px-2 py-1 text-left font-medium">Location</th>
              </tr>
            </thead>
            <tbody>
              {callStack.map((frame, idx) => {
                const location = frame.location || "Unknown";
                const target = parseCallStackLocation(location);
                const isSelected = idx === selectedFrameIndex;
                return (
                  <tr
                    key={`${frame.functionName}-${location}-${idx}`}
                    style={{
                      borderBottom: "1px solid var(--border-primary)",
                      backgroundColor: isSelected
                        ? "color-mix(in srgb, var(--accent) 15%, transparent)"
                        : "transparent",
                    }}
                  >
                    <td
                      className="px-2 py-1"
                      style={{ color: "var(--text-primary)" }}
                    >
                      <button
                        onClick={() => onSelectFrame(idx)}
                        style={{
                          backgroundColor: "transparent",
                          color: isSelected
                            ? "var(--text-accent)"
                            : "var(--text-primary)",
                          cursor: "pointer",
                          textDecoration: isSelected ? "underline" : "none",
                        }}
                        title={`Select frame ${idx}`}
                      >
                        {frame.functionName || "<script>"}
                      </button>
                    </td>
                    <td className="px-2 py-1">
                      {target ? (
                        <button
                          onClick={() => onNavigate(target.line, target.column)}
                          style={{
                            backgroundColor: "transparent",
                            color: "var(--text-accent)",
                            textDecoration: "underline",
                            cursor: "pointer",
                          }}
                          title={`Go to ${location}`}
                        >
                          {location}
                        </button>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>
                          {location}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4">
        <div style={{ color: "var(--text-secondary)" }}>Locals</div>
        {locals.length === 0 ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No local variables captured yet.
          </div>
        ) : (
          <table className="mt-2 w-full" style={monoFontStyle}>
            <thead>
              <tr
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  color: "var(--text-secondary)",
                }}
              >
                <th className="px-2 py-1 text-left font-medium">Name</th>
                <th className="px-2 py-1 text-left font-medium">Value</th>
                <th className="px-2 py-1 text-left font-medium">Type</th>
                <th className="px-2 py-1 text-left font-medium">Scope</th>
              </tr>
            </thead>
            <tbody>
              {locals.map((local) => (
                <tr
                  key={local.name}
                  style={{ borderBottom: "1px solid var(--border-primary)" }}
                >
                  <td
                    className="px-2 py-1"
                    style={{ color: "var(--text-accent)" }}
                  >
                    ${local.name}
                  </td>
                  <td
                    className="px-2 py-1"
                    style={{
                      color: "var(--text-primary)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {local.value}
                  </td>
                  <td
                    className="px-2 py-1"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {local.typeName}
                  </td>
                  <td
                    className="px-2 py-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {local.scope}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4">
        <div style={{ color: "var(--text-secondary)" }}>
          Breakpoints{activeTabName ? ` (${activeTabName})` : ""}
        </div>
        {lineBreakpoints.length === 0 ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No line breakpoints in the active tab. Click the editor gutter to
            add one.
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {lineBreakpoints.map((bp) => (
              <div
                key={breakpointKey(bp)}
                className="flex items-center gap-1 px-2 py-1 rounded"
                style={{
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <button
                  data-testid={`debugger-breakpoint-${bp.line}`}
                  onClick={() => onNavigate(bp.line, 1)}
                  style={{
                    backgroundColor: "transparent",
                    color: "var(--text-accent)",
                    textDecoration: "underline",
                    cursor: "pointer",
                    fontSize: "0.95em",
                  }}
                  title={`Go to breakpoint on line ${bp.line}`}
                >
                  {breakpointLabel(bp)}
                </button>
                {summarizeBreakpointOptions(bp) && (
                  <span
                    style={{ color: "var(--text-muted)", fontSize: "0.82em" }}
                  >
                    {summarizeBreakpointOptions(bp)}
                  </span>
                )}
                <button
                  onClick={() => beginEditBreakpoint(bp)}
                  style={{
                    backgroundColor: "transparent",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.9em",
                  }}
                  title="Edit this breakpoint"
                >
                  Edit
                </button>
                <button
                  data-testid={`debugger-breakpoint-remove-${bp.line}`}
                  onClick={() => onToggleBreakpoint(bp.line)}
                  style={{
                    backgroundColor: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: "0.95em",
                    padding: "0 2px",
                  }}
                  title={`Remove breakpoint on line ${bp.line}`}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <div style={{ color: "var(--text-secondary)" }}>
          Variable Breakpoints
        </div>
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const variable = newVariableName.trim().replace(/^\$/, "");
            if (!variable) return;
            onAddVariableBreakpoint(variable, newVariableMode);
            setNewVariableName("");
          }}
        >
          <input
            value={newVariableName}
            onChange={(e) => setNewVariableName(e.target.value)}
            placeholder="Variable name (e.g. path)"
            className="px-2 py-1"
            style={{
              ...monoFontStyle,
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
              borderRadius: "2px",
            }}
          />
          <select
            value={newVariableMode}
            onChange={(e) =>
              setNewVariableMode(
                e.target.value as "Read" | "Write" | "ReadWrite",
              )
            }
            style={{
              ...monoFontStyle,
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
              borderRadius: "2px",
              padding: "5px 8px",
            }}
          >
            <option value="ReadWrite">ReadWrite</option>
            <option value="Read">Read</option>
            <option value="Write">Write</option>
          </select>
          <button
            type="submit"
            style={{
              backgroundColor: "transparent",
              color: "var(--text-accent)",
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </form>

        {variableBreakpoints.length === 0 ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No variable breakpoints in the active tab.
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {variableBreakpoints.map((bp) => (
              <div
                key={breakpointKey(bp)}
                className="rounded px-2 py-1"
                style={{
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    style={{ ...monoFontStyle, color: "var(--text-accent)" }}
                  >
                    {breakpointLabel(bp)}
                  </span>
                  {summarizeBreakpointOptions(bp) && (
                    <span
                      style={{ color: "var(--text-muted)", fontSize: "0.82em" }}
                    >
                      {summarizeBreakpointOptions(bp)}
                    </span>
                  )}
                  <button
                    onClick={() => beginEditBreakpoint(bp)}
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontSize: "0.9em",
                    }}
                    title="Edit this breakpoint"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onRemoveBreakpoint(bp)}
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: "0.95em",
                    }}
                    title="Remove variable breakpoint"
                  >
                    x
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <div style={{ color: "var(--text-secondary)" }}>
          Command Breakpoints
        </div>
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const targetCommand = newCommandName.trim();
            if (!targetCommand) return;
            onAddCommandBreakpoint(targetCommand);
            setNewCommandName("");
          }}
        >
          <input
            value={newCommandName}
            onChange={(e) => setNewCommandName(e.target.value)}
            placeholder="Command name (e.g. Get-ChildItem)"
            className="px-2 py-1"
            style={{
              ...monoFontStyle,
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
              borderRadius: "2px",
            }}
          />
          <button
            type="submit"
            style={{
              backgroundColor: "transparent",
              color: "var(--text-accent)",
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </form>

        {commandBreakpoints.length === 0 ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No command breakpoints in the active tab.
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {commandBreakpoints.map((bp) => (
              <div
                key={breakpointKey(bp)}
                className="rounded px-2 py-1"
                style={{
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    style={{ ...monoFontStyle, color: "var(--text-accent)" }}
                  >
                    {breakpointLabel(bp)}
                  </span>
                  {summarizeBreakpointOptions(bp) && (
                    <span
                      style={{ color: "var(--text-muted)", fontSize: "0.82em" }}
                    >
                      {summarizeBreakpointOptions(bp)}
                    </span>
                  )}
                  <button
                    onClick={() => beginEditBreakpoint(bp)}
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontSize: "0.9em",
                    }}
                    title="Edit this breakpoint"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onRemoveBreakpoint(bp)}
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: "0.95em",
                    }}
                    title="Remove command breakpoint"
                  >
                    x
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <div style={{ color: "var(--text-secondary)" }}>Breakpoint Editor</div>
        {!editingBreakpoint ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            Select Edit on any breakpoint to modify condition, hit count, and
            action.
          </div>
        ) : (
          <div
            className="mt-2 rounded p-2"
            style={{
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-secondary)",
            }}
          >
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>
              Editing {breakpointLabel(editingBreakpoint)}
            </div>
            {editingBreakpoint.line !== undefined && (
              <div
                className="mt-2 text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                Line breakpoint at line {editingBreakpoint.line}
              </div>
            )}
            {editingBreakpoint.variable !== undefined && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={editVariableName}
                  onChange={(e) => setEditVariableName(e.target.value)}
                  placeholder="Variable name"
                  className="px-2 py-1"
                  style={{
                    ...monoFontStyle,
                    backgroundColor: "var(--bg-input)",
                    border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)",
                    borderRadius: "2px",
                  }}
                />
                <select
                  value={editVariableMode}
                  onChange={(e) =>
                    setEditVariableMode(
                      e.target.value as "Read" | "Write" | "ReadWrite",
                    )
                  }
                  style={{
                    ...monoFontStyle,
                    backgroundColor: "var(--bg-input)",
                    border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)",
                    borderRadius: "2px",
                    padding: "5px 8px",
                  }}
                >
                  <option value="ReadWrite">ReadWrite</option>
                  <option value="Read">Read</option>
                  <option value="Write">Write</option>
                </select>
              </div>
            )}
            {editingBreakpoint.targetCommand !== undefined && (
              <div className="mt-2">
                <input
                  value={editCommandName}
                  onChange={(e) => setEditCommandName(e.target.value)}
                  placeholder="Command name"
                  className="w-full px-2 py-1"
                  style={{
                    ...monoFontStyle,
                    backgroundColor: "var(--bg-input)",
                    border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)",
                    borderRadius: "2px",
                  }}
                />
              </div>
            )}

            <div className="mt-2">
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                Condition
              </div>
              <input
                value={editCondition}
                onChange={(e) => setEditCondition(e.target.value)}
                placeholder="PowerShell condition expression"
                className="w-full px-2 py-1"
                style={{
                  ...monoFontStyle,
                  backgroundColor: "var(--bg-input)",
                  border: "1px solid var(--border-primary)",
                  color: "var(--text-primary)",
                  borderRadius: "2px",
                }}
              />
            </div>

            <div className="mt-2">
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                Hit Count (blank for none)
              </div>
              <input
                value={editHitCount}
                onChange={(e) => setEditHitCount(e.target.value)}
                placeholder="e.g. 3"
                className="w-32 px-2 py-1"
                style={{
                  ...monoFontStyle,
                  backgroundColor: "var(--bg-input)",
                  border: "1px solid var(--border-primary)",
                  color: "var(--text-primary)",
                  borderRadius: "2px",
                }}
              />
            </div>

            <div className="mt-2">
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                Action Command
              </div>
              <textarea
                value={editAction}
                onChange={(e) => setEditAction(e.target.value)}
                placeholder="PowerShell script/action to run when breakpoint hits"
                className="w-full px-2 py-1"
                rows={3}
                style={{
                  ...monoFontStyle,
                  backgroundColor: "var(--bg-input)",
                  border: "1px solid var(--border-primary)",
                  color: "var(--text-primary)",
                  borderRadius: "2px",
                }}
              />
            </div>

            {editError && (
              <div
                className="mt-2 text-xs"
                style={{ color: "var(--stream-stderr)" }}
              >
                {editError}
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={saveEditedBreakpoint}
                style={{
                  backgroundColor: "transparent",
                  color: "var(--text-accent)",
                  cursor: "pointer",
                }}
              >
                Save
              </button>
              <button
                onClick={() => {
                  if (!editingBreakpoint) return;
                  onRemoveBreakpoint(editingBreakpoint);
                  cancelEditBreakpoint();
                }}
                style={{
                  backgroundColor: "transparent",
                  color: "var(--stream-stderr)",
                  cursor: "pointer",
                }}
              >
                Remove
              </button>
              <button
                onClick={cancelEditBreakpoint}
                style={{
                  backgroundColor: "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className="mt-4"
        style={{
          color: "var(--text-muted)",
          borderTop: "1px solid var(--border-primary)",
          paddingTop: "10px",
          fontSize: "0.92em",
        }}
      >
        F5 Run/Continue | F9 Toggle Breakpoint | F10 Step Over | F11 Step Into |
        Shift+F11 Step Out | Shift+F5 Stop
      </div>
    </div>
  );
}

/** Variable table for the inspector. */
function VariableTable({
  variables,
  typeColor,
  fontSize,
  fontFamily,
}: {
  variables: VariableInfo[];
  typeColor: (t: string) => string;
  fontSize: number;
  fontFamily: string;
}) {
  const fontStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily,
  };

  if (variables.length === 0) {
    return (
      <div
        data-testid="variables-empty"
        className="p-2"
        style={{ ...fontStyle, color: "var(--text-muted)" }}
      >
        Run a script to inspect variables.
      </div>
    );
  }

  return (
    <table data-testid="variables-table" className="w-full" style={fontStyle}>
      <thead>
        <tr
          style={{
            backgroundColor: "var(--bg-secondary)",
            color: "var(--text-secondary)",
          }}
        >
          <th className="text-left px-2 py-1 font-medium">Name</th>
          <th className="text-left px-2 py-1 font-medium">Value</th>
          <th className="text-left px-2 py-1 font-medium">Type</th>
        </tr>
      </thead>
      <tbody>
        {variables.map((v, i) => (
          <tr
            key={i}
            data-testid={`variables-row-${v.name.toLowerCase()}`}
            className="transition-colors"
            style={{ borderBottom: "1px solid var(--border-primary)" }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLElement).style.backgroundColor =
                "var(--bg-hover)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLElement).style.backgroundColor =
                "transparent")
            }
          >
            <td
              className="px-2 py-0.5 font-mono"
              style={{ color: "var(--text-accent)" }}
            >
              ${v.name}
            </td>
            <td
              className="px-2 py-0.5 font-mono truncate"
              style={{ maxWidth: "300px", color: typeColor(v.typeName) }}
              title={v.value}
            >
              {v.value}
            </td>
            <td
              className="px-2 py-0.5"
              style={{ color: "var(--text-secondary)" }}
            >
              {v.typeName}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

