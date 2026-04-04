/** PSForge Output Pane.
 *  Displays script output, variables, problems, terminal, and debugger controls.
 *
 *  Output rendering uses @tanstack/react-virtual to virtualise the line list:
 *  only the visible rows (plus a small overscan buffer) are in the DOM at any
 *  one time.  This keeps frame time constant regardless of how many lines have
 *  been accumulated (capped server-side at MAX_OUTPUT_LINES = 10 000 in the
 *  store, but visually smooth even at that limit).
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type {
  VariableInfo,
  ProblemItem,
  DebugBreakpoint,
  DebugLocal,
  DebugStackFrame,
  DebugWatch,
} from "../types";
import { TerminalPane } from "./TerminalPane";
import { ShowCommandPane } from "./ShowCommandPane";
import { HelpPane } from "./HelpPane";

/** Prompt the user for a save path and write plain text to disk. */
async function saveTextToFile({
  title,
  defaultPath,
  text,
}: {
  title: string;
  defaultPath: string;
  text: string;
}): Promise<void> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title,
    defaultPath,
    filters: [
      { name: "Log files", extensions: ["log", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!path) return; // user cancelled
  await cmd.saveFileContent(path, text, "utf8");
}

/** Prompt the user for a save path and write output lines to disk. */
async function saveOutputToFile(lines: { text: string }[]): Promise<void> {
  const text = lines.map((l) => l.text).join("\n");
  await saveTextToFile({
    title: "Save Output",
    defaultPath: "output.log",
    text,
  });
}

/** Converts structured problems into plain text for copy/save actions. */
function problemsToText(problems: ProblemItem[]): string {
  return problems
    .map((p) => {
      const severity = p.severity.toUpperCase();
      const location =
        p.line !== undefined
          ? ` (Ln ${p.line}${p.column !== undefined ? `, Col ${p.column}` : ""})`
          : "";
      return `[${severity}] ${p.source}${location}: ${p.message}`;
    })
    .join("\n");
}

/** Prompt the user for a save path and write problems to disk. */
async function saveProblemsToFile(problems: ProblemItem[]): Promise<void> {
  await saveTextToFile({
    title: "Save Problems",
    defaultPath: "problems.log",
    text: problemsToText(problems),
  });
}

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

type EditableBottomTab = "output" | "problems";

type PaneTextEditorState = {
  tab: EditableBottomTab;
  text: string;
  undoStack: string[];
  redoStack: string[];
};

const MAX_TEXT_EDITOR_HISTORY = 200;

function isEditableBottomTab(tab: string): tab is EditableBottomTab {
  return tab === "output" || tab === "problems";
}

function outputLinesToText(
  lines: Array<{ text: string; timestamp: string }>,
  includeTimestamps: boolean,
): string {
  return lines
    .map((line) => {
      if (!includeTimestamps) return line.text;
      return `[${formatTimestamp(line.timestamp)}] ${line.text}`;
    })
    .join("\n");
}

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
  /** Scroll container for the virtualised output list. */
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const [stdinInput, setStdinInput] = useState("");
  const [varFilter, setVarFilter] = useState("");
  /** Tracks whether the user has manually scrolled up (suppresses auto-scroll). */
  const isAtBottomRef = useRef(true);

  // Virtual list: renders only the visible rows plus OVERSCAN_COUNT buffer rows
  // on either side.  estimateSize uses the line-height for text-xs (20 px).
  const OVERSCAN_COUNT = 10;
  const ESTIMATED_LINE_HEIGHT_PX = 20;

  const virtualizer = useVirtualizer({
    count: state.outputLines.length,
    getScrollElement: () => outputScrollRef.current,
    estimateSize: () => ESTIMATED_LINE_HEIGHT_PX,
    overscan: OVERSCAN_COUNT,
  });

  // Detect whether the user is already at the bottom of the list.
  const handleScroll = useCallback(() => {
    const el = outputScrollRef.current;
    if (!el) return;
    // Allow 4 px tolerance for subpixel rounding.
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  }, []);

  // Auto-scroll to bottom only when new output arrives and the user hasn't scrolled up.
  useEffect(() => {
    if (
      isAtBottomRef.current &&
      state.outputLines.length > 0 &&
      state.bottomPanelTab === "output"
    ) {
      virtualizer.scrollToIndex(state.outputLines.length - 1, {
        align: "end",
        behavior: "auto",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.outputLines.length, state.bottomPanelTab]);

  const isDebuggerInputTab = state.bottomPanelTab === "debugger";
  const isStdinEnabled = isDebuggerInputTab
    ? state.isDebugging
    : state.isRunning;
  const inputPrompt = isDebuggerInputTab ? "DBG>" : ">";
  const inputEchoPrefix = isDebuggerInputTab ? "DBG> " : "> ";

  const handleStdinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stdinInput.trim()) return;
    try {
      await cmd.sendStdin(stdinInput);
      dispatch({
        type: "ADD_OUTPUT",
        line: {
          stream: "stdout",
          text: `${inputEchoPrefix}${stdinInput}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      });
      setStdinInput("");
    } catch {
      // Failed to send stdin
    }
  };

  const copyAll = () => {
    const text = state.outputLines.map((l) => l.text).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const copyProblems = useCallback(() => {
    navigator.clipboard
      .writeText(problemsToText(state.problems))
      .catch(() => {});
  }, [state.problems]);

  const [isSavingOutput, setIsSavingOutput] = useState(false);
  const [isSavingProblems, setIsSavingProblems] = useState(false);

  const handleSaveOutput = useCallback(async () => {
    if (isSavingOutput || state.outputLines.length === 0) return;
    setIsSavingOutput(true);
    try {
      await saveOutputToFile(state.outputLines);
    } finally {
      setIsSavingOutput(false);
    }
  }, [isSavingOutput, state.outputLines]);

  const handleSaveProblems = useCallback(async () => {
    if (isSavingProblems || state.problems.length === 0) return;
    setIsSavingProblems(true);
    try {
      await saveProblemsToFile(state.problems);
    } finally {
      setIsSavingProblems(false);
    }
  }, [isSavingProblems, state.problems]);

  /** Maps a stream type to its display colour CSS variable.
   *  Colours are defined in styles.css and vary per theme.
   */
  const streamColor = (stream: string): string => {
    switch (stream) {
      case "stderr":
        return "var(--stream-stderr)";
      case "verbose":
        return "var(--stream-verbose)";
      case "warning":
        return "var(--stream-warning)";
      default:
        return "var(--stream-stdout)";
    }
  };

  /** Maps a PowerShell type name to a colour CSS variable for the variable inspector. */
  const typeColor = (typeName: string): string => {
    const lower = typeName.toLowerCase();
    if (lower === "string") return "var(--type-string)";
    if (lower.includes("int") || lower === "double" || lower === "decimal")
      return "var(--type-int)";
    if (lower === "boolean" || lower === "switchparameter")
      return "var(--type-bool)";
    return "var(--type-object)";
  };

  const filteredVars = state.variables.filter(
    (v) =>
      !varFilter ||
      v.name.toLowerCase().includes(varFilter.toLowerCase()) ||
      v.value.toLowerCase().includes(varFilter.toLowerCase()),
  );
  const [textEditorState, setTextEditorState] =
    useState<PaneTextEditorState | null>(null);

  const activeEditableTab = isEditableBottomTab(state.bottomPanelTab)
    ? state.bottomPanelTab
    : null;
  const isTextEditorActive =
    activeEditableTab !== null && textEditorState?.tab === activeEditableTab;

  const capturePaneText = useCallback(
    (tab: EditableBottomTab): string => {
      if (tab === "output") {
        return outputLinesToText(
          state.outputLines,
          state.settings.showTimestamps === true,
        );
      }
      return problemsToText(state.problems);
    },
    [state.outputLines, state.problems, state.settings.showTimestamps],
  );

  const pushTextEditorChange = useCallback((nextText: string) => {
    setTextEditorState((prev) => {
      if (!prev || prev.text === nextText) return prev;
      const undoStack = [...prev.undoStack, prev.text].slice(
        -MAX_TEXT_EDITOR_HISTORY,
      );
      return {
        ...prev,
        text: nextText,
        undoStack,
        redoStack: [],
      };
    });
  }, []);

  const toggleTextEditor = useCallback(() => {
    if (!activeEditableTab) return;
    if (textEditorState?.tab === activeEditableTab) {
      setTextEditorState(null);
      return;
    }
    const snapshot = capturePaneText(activeEditableTab);
    setTextEditorState({
      tab: activeEditableTab,
      text: snapshot,
      undoStack: [],
      redoStack: [],
    });
  }, [activeEditableTab, capturePaneText, textEditorState]);

  const undoTextEditor = useCallback(() => {
    setTextEditorState((prev) => {
      if (!prev || prev.undoStack.length === 0) return prev;
      const previousText = prev.undoStack[prev.undoStack.length - 1];
      return {
        ...prev,
        text: previousText,
        undoStack: prev.undoStack.slice(0, -1),
        redoStack: [prev.text, ...prev.redoStack].slice(
          0,
          MAX_TEXT_EDITOR_HISTORY,
        ),
      };
    });
  }, []);

  const redoTextEditor = useCallback(() => {
    setTextEditorState((prev) => {
      if (!prev || prev.redoStack.length === 0) return prev;
      const [nextText, ...remainingRedo] = prev.redoStack;
      return {
        ...prev,
        text: nextText,
        undoStack: [...prev.undoStack, prev.text].slice(
          -MAX_TEXT_EDITOR_HISTORY,
        ),
        redoStack: remainingRedo,
      };
    });
  }, []);

  const resetTextEditor = useCallback(() => {
    if (!activeEditableTab || !isTextEditorActive) return;
    pushTextEditorChange(capturePaneText(activeEditableTab));
  }, [
    activeEditableTab,
    capturePaneText,
    isTextEditorActive,
    pushTextEditorChange,
  ]);

  const clearTextEditor = useCallback(() => {
    if (!isTextEditorActive) return;
    pushTextEditorChange("");
  }, [isTextEditorActive, pushTextEditorChange]);

  const copyTextEditor = useCallback(() => {
    if (!isTextEditorActive || !textEditorState) return;
    navigator.clipboard.writeText(textEditorState.text).catch(() => {});
  }, [isTextEditorActive, textEditorState]);

  const handleTextEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (!e.shiftKey && key === "z") {
        e.preventDefault();
        undoTextEditor();
        return;
      }
      if (key === "y" || (e.shiftKey && key === "z")) {
        e.preventDefault();
        redoTextEditor();
      }
    },
    [redoTextEditor, undoTextEditor],
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

  const bottomTabs: Array<{
    id:
      | "terminal"
      | "output"
      | "debugger"
      | "variables"
      | "problems"
      | "show-command"
      | "help";
    label: string;
  }> = [
    { id: "terminal", label: "terminal" },
    { id: "output", label: "output" },
    { id: "debugger", label: "debugger" },
    { id: "show-command", label: "show command" },
    { id: "help", label: "help" },
    { id: "variables", label: "variables" },
    { id: "problems", label: "problems" },
  ];

  return (
    <div
      data-testid="output-pane"
      className="flex flex-col h-full"
      style={{
        backgroundColor: "var(--bg-panel)",
        borderTop: "1px solid var(--border-primary)",
      }}
    >
      {/* Panel tabs */}
      <div
        className="flex items-center no-select text-sm"
        style={{
          borderBottom: "1px solid var(--border-primary)",
          backgroundColor: "var(--bg-secondary)",
          minHeight: "38px",
          whiteSpace: "nowrap",
          overflowX: "auto",
          overflowY: "hidden",
        }}
      >
        {bottomTabs.map((tab) => (
          <button
            key={tab.id}
            data-testid={`output-tab-${tab.id}`}
            onClick={() => {
              dispatch({ type: "SET_BOTTOM_TAB", tab: tab.id });
              // When switching to the terminal, focus it immediately while
              // we are still inside the user-gesture call stack so WebView2
              // allows the focus() call to succeed.
              if (tab.id === "terminal") {
                requestAnimationFrame(() => {
                  (
                    window as unknown as Record<string, () => void>
                  ).__psforge_terminal_focus?.();
                });
              }
            }}
            className="transition-colors"
            style={{
              padding: "8px 28px",
              display: "inline-flex",
              alignItems: "center",
              whiteSpace: "nowrap",
              flexShrink: 0,
              backgroundColor: "transparent",
              color:
                state.bottomPanelTab === tab.id
                  ? "var(--text-primary)"
                  : "var(--text-secondary)",
              borderBottom:
                state.bottomPanelTab === tab.id
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
            }}
          >
            {tab.label}
            {tab.id === "output" && state.outputLines.length > 0 && (
              <span className="opacity-60"> ({state.outputLines.length})</span>
            )}
            {tab.id === "problems" && state.problems.length > 0 && (
              <span
                style={{
                  color: "var(--stream-stderr)",
                  fontWeight: 600,
                }}
              >
                {" "}
                ({state.problems.length})
              </span>
            )}
            {tab.id === "debugger" && state.isDebugging && (
              <span
                style={{
                  color: state.debugPaused
                    ? "var(--stream-warning)"
                    : "var(--text-accent)",
                  fontWeight: 600,
                }}
              >
                {" "}
                ({state.debugPaused ? "paused" : "active"})
              </span>
            )}
          </button>
        ))}

        <div className="flex-1" />

        {activeEditableTab && (
          <>
            <button
              data-testid="bottom-pane-text-mode-toggle"
              onClick={toggleTextEditor}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color: isTextEditorActive
                  ? "var(--text-accent)"
                  : "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: isTextEditorActive ? "4px" : "8px",
              }}
              title="Open an editable text snapshot for the current pane"
            >
              {isTextEditorActive ? "Structured" : "Text Mode"}
            </button>

            {isTextEditorActive && (
              <>
                <button
                  data-testid="bottom-pane-text-undo"
                  onClick={undoTextEditor}
                  disabled={
                    !textEditorState || textEditorState.undoStack.length === 0
                  }
                  style={{
                    padding: "6px 14px",
                    backgroundColor: "transparent",
                    color:
                      !textEditorState || textEditorState.undoStack.length === 0
                        ? "var(--text-muted)"
                        : "var(--text-secondary)",
                    cursor:
                      !textEditorState || textEditorState.undoStack.length === 0
                        ? "default"
                        : "pointer",
                    fontSize: "var(--ui-font-size-sm)",
                    border: "none",
                    borderRadius: "3px",
                    marginRight: "4px",
                  }}
                  title="Undo the last text edit (Ctrl+Z)"
                >
                  Undo
                </button>
                <button
                  data-testid="bottom-pane-text-redo"
                  onClick={redoTextEditor}
                  disabled={
                    !textEditorState || textEditorState.redoStack.length === 0
                  }
                  style={{
                    padding: "6px 14px",
                    backgroundColor: "transparent",
                    color:
                      !textEditorState || textEditorState.redoStack.length === 0
                        ? "var(--text-muted)"
                        : "var(--text-secondary)",
                    cursor:
                      !textEditorState || textEditorState.redoStack.length === 0
                        ? "default"
                        : "pointer",
                    fontSize: "var(--ui-font-size-sm)",
                    border: "none",
                    borderRadius: "3px",
                    marginRight: "4px",
                  }}
                  title="Redo the last undone edit (Ctrl+Y / Ctrl+Shift+Z)"
                >
                  Redo
                </button>
                <button
                  data-testid="bottom-pane-text-copy"
                  onClick={copyTextEditor}
                  disabled={
                    !textEditorState || textEditorState.text.length === 0
                  }
                  style={{
                    padding: "6px 14px",
                    backgroundColor: "transparent",
                    color:
                      !textEditorState || textEditorState.text.length === 0
                        ? "var(--text-muted)"
                        : "var(--text-secondary)",
                    cursor:
                      !textEditorState || textEditorState.text.length === 0
                        ? "default"
                        : "pointer",
                    fontSize: "var(--ui-font-size-sm)",
                    border: "none",
                    borderRadius: "3px",
                    marginRight: "4px",
                  }}
                  title="Copy the editable pane text"
                >
                  Copy
                </button>
                <button
                  data-testid="bottom-pane-text-reset"
                  onClick={resetTextEditor}
                  style={{
                    padding: "6px 14px",
                    backgroundColor: "transparent",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "var(--ui-font-size-sm)",
                    border: "none",
                    borderRadius: "3px",
                    marginRight: "4px",
                  }}
                  title="Reload the current pane text into the editor"
                >
                  Reset
                </button>
                <button
                  data-testid="bottom-pane-text-clear"
                  onClick={clearTextEditor}
                  disabled={
                    !textEditorState || textEditorState.text.length === 0
                  }
                  style={{
                    padding: "6px 14px",
                    backgroundColor: "transparent",
                    color:
                      !textEditorState || textEditorState.text.length === 0
                        ? "var(--text-muted)"
                        : "var(--text-secondary)",
                    cursor:
                      !textEditorState || textEditorState.text.length === 0
                        ? "default"
                        : "pointer",
                    fontSize: "var(--ui-font-size-sm)",
                    border: "none",
                    borderRadius: "3px",
                    marginRight: "8px",
                  }}
                  title="Clear only the editable pane text"
                >
                  Clear
                </button>
              </>
            )}
          </>
        )}

        {!isTextEditorActive && state.bottomPanelTab === "output" && (
          <>
            <button
              onClick={copyAll}
              disabled={state.outputLines.length === 0}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color:
                  state.outputLines.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor: state.outputLines.length === 0 ? "default" : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Copy all output to clipboard"
            >
              Copy
            </button>
            <button
              onClick={handleSaveOutput}
              disabled={isSavingOutput || state.outputLines.length === 0}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color:
                  isSavingOutput || state.outputLines.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  isSavingOutput || state.outputLines.length === 0
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Save output to file"
            >
              {isSavingOutput ? "Saving..." : "Save..."}
            </button>
            <button
              data-testid="output-clear-button"
              onClick={() => dispatch({ type: "CLEAR_OUTPUT" })}
              disabled={state.outputLines.length === 0}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color:
                  state.outputLines.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor: state.outputLines.length === 0 ? "default" : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "8px",
              }}
              title="Clear output"
            >
              Clear
            </button>
          </>
        )}

        {!isTextEditorActive && state.bottomPanelTab === "problems" && (
          <>
            <button
              onClick={copyProblems}
              disabled={state.problems.length === 0}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color:
                  state.problems.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor: state.problems.length === 0 ? "default" : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Copy all problems to clipboard"
            >
              Copy
            </button>
            <button
              onClick={handleSaveProblems}
              disabled={isSavingProblems || state.problems.length === 0}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color:
                  isSavingProblems || state.problems.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  isSavingProblems || state.problems.length === 0
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Save problems to file"
            >
              {isSavingProblems ? "Saving..." : "Save..."}
            </button>
            <button
              data-testid="problems-clear-button"
              onClick={() => dispatch({ type: "CLEAR_PROBLEMS" })}
              disabled={state.problems.length === 0}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color:
                  state.problems.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor: state.problems.length === 0 ? "default" : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "8px",
              }}
              title="Clear problems"
            >
              Clear
            </button>
          </>
        )}

        {state.bottomPanelTab === "terminal" && (
          <>
            <button
              onClick={() =>
                (
                  window as unknown as Record<string, () => void>
                ).__psforge_terminal_clear?.()
              }
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Clear terminal output"
            >
              Clear
            </button>
            <button
              onClick={() =>
                (
                  window as unknown as Record<string, () => void>
                ).__psforge_terminal_restart?.()
              }
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "8px",
              }}
              title="Restart PowerShell session"
            >
              Restart
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
              style={{
                padding: "6px 12px",
                backgroundColor: "transparent",
                color:
                  state.isRunning ||
                  !state.selectedPsPath ||
                  !activeTab ||
                  activeTab.tabType === "welcome"
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  state.isRunning ||
                  !state.selectedPsPath ||
                  !activeTab ||
                  activeTab.tabType === "welcome"
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Start debugging"
            >
              Start
            </button>
            <button
              onClick={onDebugContinue}
              disabled={!state.isDebugging || !state.debugPaused}
              style={{
                padding: "6px 12px",
                backgroundColor: "transparent",
                color:
                  !state.isDebugging || !state.debugPaused
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  !state.isDebugging || !state.debugPaused
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Continue (F5)"
            >
              Continue
            </button>
            <button
              onClick={onDebugStepOver}
              disabled={!state.isDebugging || !state.debugPaused}
              style={{
                padding: "6px 12px",
                backgroundColor: "transparent",
                color:
                  !state.isDebugging || !state.debugPaused
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  !state.isDebugging || !state.debugPaused
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Step Over (F10)"
            >
              Step Over
            </button>
            <button
              onClick={onDebugStepInto}
              disabled={!state.isDebugging || !state.debugPaused}
              style={{
                padding: "6px 12px",
                backgroundColor: "transparent",
                color:
                  !state.isDebugging || !state.debugPaused
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  !state.isDebugging || !state.debugPaused
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Step Into (F11)"
            >
              Step Into
            </button>
            <button
              onClick={onDebugStepOut}
              disabled={!state.isDebugging || !state.debugPaused}
              style={{
                padding: "6px 12px",
                backgroundColor: "transparent",
                color:
                  !state.isDebugging || !state.debugPaused
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  !state.isDebugging || !state.debugPaused
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Step Out (Shift+F11)"
            >
              Step Out
            </button>
            <button
              onClick={onDebugRefreshInspector}
              disabled={!state.isDebugging || !state.debugPaused}
              style={{
                padding: "6px 12px",
                backgroundColor: "transparent",
                color:
                  !state.isDebugging || !state.debugPaused
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor:
                  !state.isDebugging || !state.debugPaused
                    ? "default"
                    : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Refresh locals, call stack, and watches"
            >
              Refresh
            </button>
            <button
              onClick={onStop}
              disabled={!state.isRunning}
              style={{
                padding: "6px 12px",
                backgroundColor: "transparent",
                color: !state.isRunning
                  ? "var(--text-muted)"
                  : "var(--stream-stderr)",
                cursor: !state.isRunning ? "default" : "pointer",
                fontSize: "var(--ui-font-size-sm)",
                border: "none",
                borderRadius: "3px",
                marginRight: "8px",
              }}
              title="Stop (Shift+F5)"
            >
              Stop
            </button>
          </>
        )}

        {!isTextEditorActive && state.bottomPanelTab === "variables" && (
          <input
            data-testid="variables-filter"
            value={varFilter}
            onChange={(e) => setVarFilter(e.target.value)}
            placeholder="Filter variables..."
            className="mr-1 px-2 py-0.5"
            style={{
              fontSize: `${state.settings.outputFontSize ?? 13}px`,
              fontFamily:
                state.settings.outputFontFamily ??
                "Cascadia Code, Consolas, monospace",
              width: "180px",
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
              borderRadius: "2px",
            }}
          />
        )}
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
        {isTextEditorActive && textEditorState && (
          <textarea
            data-testid={`bottom-pane-text-editor-${textEditorState.tab}`}
            value={textEditorState.text}
            onChange={(e) => pushTextEditorChange(e.target.value)}
            onKeyDown={handleTextEditorKeyDown}
            spellCheck={false}
            wrap={state.settings.outputWordWrap === true ? "soft" : "off"}
            className="h-full w-full p-3 resize-none"
            style={{
              border: "none",
              borderRadius: 0,
              backgroundColor: "var(--bg-panel)",
              color: "var(--text-primary)",
              fontFamily:
                state.settings.outputFontFamily ??
                "Cascadia Code, Consolas, monospace",
              fontSize: `${state.settings.outputFontSize ?? 13}px`,
              outline: "none",
            }}
          />
        )}

        {!isTextEditorActive && state.bottomPanelTab === "output" && (
          /* Scroll container: needs explicit height so the virtualizer can
             calculate visible rows.  flex-1 fills the available panel space.
             Font family/size come from user output font settings. */
          <div
            ref={outputScrollRef}
            data-testid="output-scroll"
            onScroll={handleScroll}
            className="font-mono overflow-auto h-full"
            style={{
              contain: "strict",
              fontFamily:
                state.settings.outputFontFamily ??
                "Cascadia Code, Consolas, monospace",
              fontSize: `${state.settings.outputFontSize ?? 13}px`,
            }}
          >
            {state.outputLines.length === 0 && (
              <div className="p-2" style={{ color: "var(--text-muted)" }}>
                Output will appear here when you run a script (F5).
              </div>
            )}
            {/* Outer div sized to the total virtual height so the scrollbar is correct. */}
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const line = state.outputLines[vItem.index];
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                      padding: "1px 8px",
                      whiteSpace:
                        state.settings.outputWordWrap === true
                          ? "pre-wrap"
                          : "pre",
                      wordBreak:
                        state.settings.outputWordWrap === true
                          ? "break-all"
                          : "normal",
                      display: "flex",
                      gap: "8px",
                    }}
                  >
                    {state.settings.showTimestamps && (
                      <span
                        style={{
                          color: "var(--text-muted)",
                          flexShrink: 0,
                        }}
                      >
                        [{formatTimestamp(line.timestamp)}]
                      </span>
                    )}
                    <AnsiText
                      text={line.text}
                      color={streamColor(line.stream)}
                    />
                  </div>
                );
              })}
            </div>

            {/* Running indicator: sticky so it remains visible at the bottom
                of the scroll viewport even when the user has scrolled up to
                review earlier output.  position:sticky inside overflow:auto
                only pins the element when the container is taller than its
                content; once the virtualiser fills the height the indicator
                stays pinned to the visible bottom edge either way. */}
            {state.isRunning && (
              <div
                className="animate-pulse px-2 py-0.5"
                style={{
                  position: "sticky",
                  bottom: 0,
                  color: "var(--text-accent)",
                  backgroundColor: "var(--bg-panel)",
                  borderTop: "1px solid var(--border-primary)",
                  fontSize: "var(--ui-font-size-xs)",
                }}
              >
                {state.isDebugging
                  ? state.debugPaused
                    ? "Debug paused…"
                    : "Debugging…"
                  : "Running…"}
              </div>
            )}
          </div>
        )}

        {!isTextEditorActive && state.bottomPanelTab === "variables" && (
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

        {!isTextEditorActive && state.bottomPanelTab === "problems" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <ProblemsPane
              problems={state.problems}
              fontSize={state.settings.outputFontSize ?? 13}
              fontFamily={
                state.settings.outputFontFamily ??
                "Cascadia Code, Consolas, monospace"
              }
            />
          </div>
        )}

        {!isTextEditorActive && state.bottomPanelTab === "debugger" && (
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

        {!isTextEditorActive && state.bottomPanelTab === "show-command" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <ShowCommandPane />
          </div>
        )}

        {!isTextEditorActive && state.bottomPanelTab === "help" && (
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

      {/* Stdin/debugger input row (visible in output and debugger tabs). */}
      {(state.bottomPanelTab === "output" ||
        state.bottomPanelTab === "debugger") && (
        <form
          onSubmit={handleStdinSubmit}
          className="flex items-center px-2 py-1"
          style={{
            borderTop: "1px solid var(--border-primary)",
            backgroundColor: "var(--bg-secondary)",
          }}
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
              isDebuggerInputTab
                ? isStdinEnabled
                  ? "Type debugger command or expression..."
                  : "Debugger not active"
                : isStdinEnabled
                  ? "Type input for Read-Host..."
                  : "Script not running"
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
                const location = frame.location.trim();
                const target = parseCallStackLocation(location);
                const isSelected = selectedFrameIndex === idx;
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
                          {location || "Unknown"}
                        </button>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>
                          {location || "Unknown"}
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

function formatTimestamp(ts: string): string {
  const secs = parseInt(ts, 10);
  if (isNaN(secs)) return ts;
  const date = new Date(secs * 1000);
  return date.toLocaleTimeString();
}

/** Renders the Problems tab with structured diagnostic items.
 *  Rows with a known line number are clickable -- clicking navigates the
 *  Monaco editor to the error location via window.__psforge_navigateTo.
 */
function ProblemsPane({
  problems,
  fontSize,
  fontFamily,
}: {
  problems: ProblemItem[];
  fontSize: number;
  fontFamily: string;
}) {
  const fontStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily: `var(--ui-font-family, ${fontFamily})`,
  };

  if (problems.length === 0) {
    return (
      <div className="p-3" style={{ ...fontStyle, color: "var(--text-muted)" }}>
        No problems detected. Run a script to see errors here.
      </div>
    );
  }

  const severityColor = (s: string) => {
    switch (s) {
      case "warning":
        return "var(--stream-warning)";
      case "info":
        return "var(--stream-verbose)";
      default:
        return "var(--stream-stderr)";
    }
  };

  // SVG icons rendered inline so they scale with the font and honour CSS color.
  const SeverityIcon = ({ severity }: { severity: string }) => {
    const color = severityColor(severity);
    if (severity === "warning") {
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ flexShrink: 0, marginTop: "1px" }}
        >
          <path
            d="M8 1L15 14H1L8 1Z"
            stroke={color}
            strokeWidth="1.5"
            fill="none"
          />
          <line
            x1="8"
            y1="6"
            x2="8"
            y2="10"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="12" r="0.75" fill={color} />
        </svg>
      );
    }
    if (severity === "info") {
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ flexShrink: 0, marginTop: "1px" }}
        >
          <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.5" />
          <line
            x1="8"
            y1="7"
            x2="8"
            y2="11"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="5" r="0.75" fill={color} />
        </svg>
      );
    }
    // default: error
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0, marginTop: "1px" }}
      >
        <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.5" />
        <line
          x1="5.5"
          y1="5.5"
          x2="10.5"
          y2="10.5"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="10.5"
          y1="5.5"
          x2="5.5"
          y2="10.5"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  };

  const navigateTo = (line: number, column: number) => {
    const nav = (window as unknown as Record<string, unknown>)
      .__psforge_navigateTo as ((l: number, c: number) => void) | undefined;
    nav?.(line, column ?? 1);
  };

  /** Prevent click-to-navigate when the user is drag-selecting problem text. */
  const hasSelectionIn = (container: HTMLElement): boolean => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return false;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    return (
      (anchorNode !== null && container.contains(anchorNode)) ||
      (focusNode !== null && container.contains(focusNode))
    );
  };

  return (
    <div className="flex flex-col overflow-auto h-full" style={fontStyle}>
      {problems.map((p, i) => {
        const navigable = p.line !== undefined;
        return (
          <div
            key={i}
            className="flex items-start gap-2.5 px-3 py-2"
            style={{
              borderBottom: "1px solid var(--border-primary)",
              cursor: navigable ? "pointer" : "default",
            }}
            onClick={(e) => {
              if (!navigable) return;
              if (hasSelectionIn(e.currentTarget)) return;
              navigateTo(p.line!, p.column ?? 1);
            }}
            title={navigable ? `Click to go to line ${p.line}` : undefined}
            onMouseEnter={(e) => {
              if (navigable)
                (e.currentTarget as HTMLElement).style.backgroundColor =
                  "var(--bg-hover)";
            }}
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLElement).style.backgroundColor =
                "transparent")
            }
          >
            {/* Severity icon */}
            <SeverityIcon severity={p.severity} />

            {/* Message + meta */}
            <div className="flex-1 min-w-0">
              {/* Message — strip any residual ANSI escape sequences */}
              <div
                style={{
                  color: "var(--text-primary)",
                  wordBreak: "break-word",
                }}
              >
                <AnsiText text={p.message} color="var(--text-primary)" />
              </div>

              {/* Source + location on a second line */}
              <div
                className="flex items-center gap-3 mt-0.5"
                style={{ color: "var(--text-muted)", fontSize: "0.82em" }}
              >
                <span>{p.source}</span>
                {p.line !== undefined && (
                  <span>
                    Ln {p.line}
                    {p.column !== undefined ? `, Col ${p.column}` : ""}
                  </span>
                )}
                {navigable && (
                  <span style={{ opacity: 0.6 }}>Click to navigate</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
