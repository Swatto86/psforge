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
import type { VariableInfo, ProblemItem } from "../types";
import { TerminalPane } from "./TerminalPane";

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

interface OutputPaneProps {
  onDebugStart: () => void;
  onDebugContinue: () => void;
  onDebugStepOver: () => void;
  onDebugStepInto: () => void;
  onDebugStepOut: () => void;
  onStop: () => void;
}

export function OutputPane({
  onDebugStart,
  onDebugContinue,
  onDebugStepOver,
  onDebugStepInto,
  onDebugStepOut,
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

  const handleStdinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stdinInput.trim()) return;
    try {
      await cmd.sendStdin(stdinInput);
      dispatch({
        type: "ADD_OUTPUT",
        line: {
          stream: "stdout",
          text: `> ${stdinInput}`,
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
    navigator.clipboard.writeText(problemsToText(state.problems)).catch(() => {});
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

  const navigateTo = useCallback((line: number, column: number) => {
    const nav = (window as unknown as Record<string, unknown>)
      .__psforge_navigateTo as ((l: number, c: number) => void) | undefined;
    nav?.(line, Math.max(1, column));
  }, []);

  const activeTabBreakpoints =
    activeTab && activeTab.tabType !== "welcome"
      ? state.breakpoints[activeTab.id] ?? []
      : [];

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
        }}
      >
        {(["terminal", "output", "debugger", "variables", "problems"] as const).map(
          (tab) => (
            <button
              key={tab}
              data-testid={`output-tab-${tab}`}
              onClick={() => {
                dispatch({ type: "SET_BOTTOM_TAB", tab });
                // When switching to the terminal, focus it immediately while
                // we are still inside the user-gesture call stack so WebView2
                // allows the focus() call to succeed.
                if (tab === "terminal") {
                  requestAnimationFrame(() => {
                    (
                      window as unknown as Record<string, () => void>
                    ).__psforge_terminal_focus?.();
                  });
                }
              }}
              className="capitalize transition-colors"
              style={{
                padding: "8px 28px",
                backgroundColor: "transparent",
                color:
                  state.bottomPanelTab === tab
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                borderBottom:
                  state.bottomPanelTab === tab
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
              }}
            >
              {tab}
              {tab === "output" && state.outputLines.length > 0 && (
                <span className="opacity-60">
                  {" "}
                  ({state.outputLines.length})
                </span>
              )}
              {tab === "problems" && state.problems.length > 0 && (
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
              {tab === "debugger" && state.isDebugging && (
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
          ),
        )}

        <div className="flex-1" />

        {state.bottomPanelTab === "output" && (
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
                fontSize: "12px",
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
                fontSize: "12px",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Save output to file"
            >
              {isSavingOutput ? "Saving..." : "Save..."}
            </button>
            <button
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
                fontSize: "12px",
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

        {state.bottomPanelTab === "problems" && (
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
                fontSize: "12px",
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
                fontSize: "12px",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Save problems to file"
            >
              {isSavingProblems ? "Saving..." : "Save..."}
            </button>
            <button
              onClick={() => dispatch({ type: "CLEAR_OUTPUT" })}
              disabled={state.problems.length === 0}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                color:
                  state.problems.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                cursor: state.problems.length === 0 ? "default" : "pointer",
                fontSize: "12px",
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
                fontSize: "12px",
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
                fontSize: "12px",
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
                fontSize: "12px",
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
                fontSize: "12px",
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
                fontSize: "12px",
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
                fontSize: "12px",
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
                fontSize: "12px",
                border: "none",
                borderRadius: "3px",
                marginRight: "4px",
              }}
              title="Step Out (Shift+F11)"
            >
              Step Out
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
                fontSize: "12px",
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

        {state.bottomPanelTab === "variables" && (
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
        {state.bottomPanelTab === "output" && (
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
                  fontSize: "11px",
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

        {state.bottomPanelTab === "variables" && (
          <VariableTable
            variables={filteredVars}
            typeColor={typeColor}
            fontSize={state.settings.outputFontSize ?? 13}
            fontFamily={
              state.settings.outputFontFamily ??
              "Cascadia Code, Consolas, monospace"
            }
          />
        )}

        {state.bottomPanelTab === "problems" && (
          <ProblemsPane
            problems={state.problems}
            fontSize={state.settings.outputFontSize ?? 13}
            fontFamily={
              state.settings.outputFontFamily ??
              "Cascadia Code, Consolas, monospace"
            }
          />
        )}

        {state.bottomPanelTab === "debugger" && (
          <DebuggerPane
            isRunning={state.isRunning}
            isDebugging={state.isDebugging}
            debugPaused={state.debugPaused}
            debugLine={state.debugLine}
            debugColumn={state.debugColumn}
            activeTabName={
              activeTab?.tabType === "code" ? activeTab.title : undefined
            }
            breakpoints={activeTabBreakpoints}
            onNavigate={navigateTo}
            onToggleBreakpoint={(line) => {
              if (!activeTab || activeTab.tabType === "welcome") return;
              dispatch({
                type: "TOGGLE_BREAKPOINT",
                tabId: activeTab.id,
                line,
              });
            }}
            fontSize={state.settings.outputFontSize ?? 13}
            fontFamily={
              state.settings.outputFontFamily ??
              "Cascadia Code, Consolas, monospace"
            }
          />
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

      {/* Stdin input row (only visible in output tab) */}
      {state.bottomPanelTab === "output" && (
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
            &gt;
          </span>
          <input
            value={stdinInput}
            onChange={(e) => setStdinInput(e.target.value)}
            placeholder={
              state.isRunning
                ? "Type input for Read-Host..."
                : "Script not running"
            }
            disabled={!state.isRunning}
            className="flex-1 text-xs font-mono"
            style={{
              backgroundColor: "transparent",
              border: "none",
              color: "var(--text-primary)",
              outline: "none",
              opacity: state.isRunning ? 1 : 0.5,
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
  activeTabName,
  breakpoints,
  onNavigate,
  onToggleBreakpoint,
  fontSize,
  fontFamily,
}: {
  isRunning: boolean;
  isDebugging: boolean;
  debugPaused: boolean;
  debugLine: number | null;
  debugColumn: number | null;
  activeTabName?: string;
  breakpoints: number[];
  onNavigate: (line: number, column: number) => void;
  onToggleBreakpoint: (line: number) => void;
  fontSize: number;
  fontFamily: string;
}) {
  const fontStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily: `var(--ui-font-family, ${fontFamily})`,
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
        <div style={{ color: "var(--text-secondary)" }}>
          Breakpoints{activeTabName ? ` (${activeTabName})` : ""}
        </div>
        {breakpoints.length === 0 ? (
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            No line breakpoints in the active tab. Click the editor gutter to add one.
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {breakpoints.map((line) => (
              <div
                key={line}
                className="flex items-center gap-1 px-2 py-1 rounded"
                style={{
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <button
                  data-testid={`debugger-breakpoint-${line}`}
                  onClick={() => onNavigate(line, 1)}
                  style={{
                    backgroundColor: "transparent",
                    color: "var(--text-accent)",
                    textDecoration: "underline",
                    cursor: "pointer",
                    fontSize: "0.95em",
                  }}
                  title={`Go to breakpoint on line ${line}`}
                >
                  Ln {line}
                </button>
                <button
                  data-testid={`debugger-breakpoint-remove-${line}`}
                  onClick={() => onToggleBreakpoint(line)}
                  style={{
                    backgroundColor: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: "0.95em",
                    padding: "0 2px",
                  }}
                  title={`Remove breakpoint on line ${line}`}
                >
                  x
                </button>
              </div>
            ))}
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
        F5 Continue | F10 Step Over | F11 Step Into | Shift+F11 Step Out | Shift+F5 Stop
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
          width="14" height="14" viewBox="0 0 16 16"
          fill="none" xmlns="http://www.w3.org/2000/svg"
          style={{ flexShrink: 0, marginTop: "1px" }}
        >
          <path d="M8 1L15 14H1L8 1Z" stroke={color} strokeWidth="1.5" fill="none" />
          <line x1="8" y1="6" x2="8" y2="10" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="12" r="0.75" fill={color} />
        </svg>
      );
    }
    if (severity === "info") {
      return (
        <svg
          width="14" height="14" viewBox="0 0 16 16"
          fill="none" xmlns="http://www.w3.org/2000/svg"
          style={{ flexShrink: 0, marginTop: "1px" }}
        >
          <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.5" />
          <line x1="8" y1="7" x2="8" y2="11" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="5" r="0.75" fill={color} />
        </svg>
      );
    }
    // default: error
    return (
      <svg
        width="14" height="14" viewBox="0 0 16 16"
        fill="none" xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0, marginTop: "1px" }}
      >
        <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.5" />
        <line x1="5.5" y1="5.5" x2="10.5" y2="10.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="10.5" y1="5.5" x2="5.5" y2="10.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
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
              <div style={{ color: "var(--text-primary)", wordBreak: "break-word" }}>
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
