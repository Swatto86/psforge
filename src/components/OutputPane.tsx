/** PSForge Output Pane.
 *  Displays script output, variable inspector, and provides stdin input.
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

/** Prompt the user for a save path and write output lines to disk. */
async function saveOutputToFile(lines: { text: string }[]): Promise<void> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: "Save Output",
    defaultPath: "output.log",
    filters: [
      { name: "Log files", extensions: ["log", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!path) return; // user cancelled
  const text = lines.map((l) => l.text).join("\n");
  await cmd.saveFileContent(path, text, "utf8");
}

export function OutputPane() {
  const { state, dispatch } = useAppState();
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

  const [isSavingOutput, setIsSavingOutput] = useState(false);

  const handleSaveOutput = useCallback(async () => {
    if (isSavingOutput || state.outputLines.length === 0) return;
    setIsSavingOutput(true);
    try {
      await saveOutputToFile(state.outputLines);
    } finally {
      setIsSavingOutput(false);
    }
  }, [isSavingOutput, state.outputLines]);

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
        {(["terminal", "output", "variables", "problems"] as const).map(
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
                Running…
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
            onClick={() => navigable && navigateTo(p.line!, p.column ?? 1)}
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
