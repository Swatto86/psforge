/** PSForge Toolbar component.
 *  Contains New, Open, Save, Save All, Run, Stop, Settings, Theme selector, PS version picker,
 *  and a Recent Files dropdown.
 */

import React, { useState, useRef, useEffect } from "react";
import { basename } from "../path-utils";
import { useAppState } from "../store";
import type { ThemeName } from "../types";

interface ToolbarProps {
  onNew: () => void;
  onOpen: () => void;
  /** Called when the user selects a path from the Recent Files dropdown. */
  onOpenRecent: (path: string) => void;
  onSave: () => void;
  onSaveAll: () => void;
  onRun: () => void;
  /** Start running the active script under the debugger. */
  onDebugStart: () => void;
  /** Continue execution from the current debugger stop point. */
  onDebugContinue: () => void;
  /** Debugger: step over. */
  onDebugStepOver: () => void;
  /** Debugger: step into. */
  onDebugStepInto: () => void;
  /** Debugger: step out. */
  onDebugStepOut: () => void;
  onStop: () => void;
  /** Format current script with Invoke-Formatter (Shift+Alt+F). */
  onFormat: () => void;
  /** Trigger Monaco's built-in Find & Replace widget. */
  onFindReplace: () => void;
  /** Open the current user's $PROFILE for editing. */
  onOpenProfile: () => void;
  /** Print the current script content. */
  onPrint: () => void;
  /** Open the script signing dialog. */
  onSign: () => void;
}

export function Toolbar({
  onNew,
  onOpen,
  onOpenRecent,
  onSave,
  onSaveAll,
  onRun,
  onDebugStart,
  onDebugContinue,
  onDebugStepOver,
  onDebugStepInto,
  onDebugStepOut,
  onStop,
  onFormat,
  onFindReplace,
  onOpenProfile,
  onPrint,
  onSign,
}: ToolbarProps) {
  const { state, dispatch, activeTab } = useAppState();
  const showDebuggerTools = state.settings.showDebuggerTools === true;
  const hasSavableTabs = state.tabs.some(
    (t) => t.tabType !== "welcome" && (t.isDirty || !t.filePath),
  );
  const [showRecent, setShowRecent] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const recentRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Close recent dropdown on outside click.
  useEffect(() => {
    if (!showRecent) return;
    const handler = (e: MouseEvent) => {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setShowRecent(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showRecent]);

  useEffect(() => {
    if (!showOverflow) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showOverflow]);

  const handleThemeChange = (theme: ThemeName) => {
    document.documentElement.setAttribute("data-theme", theme);
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, theme },
    });
  };

  return (
    <div
      data-testid="toolbar-root"
      className="flex items-center gap-1 py-1 no-select"
      style={{
        backgroundColor: "var(--bg-toolbar)",
        borderBottom: "1px solid var(--border-primary)",
        minHeight: "42px",
        paddingLeft: "12px",
        paddingRight: "12px",
      }}
    >
      {/* Primary: open, save, run, stop */}
      <div ref={recentRef} className="relative">
        <button
          title="Recent scripts"
          onClick={() => setShowRecent((v) => !v)}
          disabled={state.settings.recentFiles.length === 0}
          className="flex items-center gap-0.5 px-2 h-8 rounded text-sm transition-colors"
          style={{
            backgroundColor: "transparent",
            color:
              state.settings.recentFiles.length === 0
                ? "var(--text-muted)"
                : "var(--text-primary)",
            cursor:
              state.settings.recentFiles.length === 0
                ? "not-allowed"
                : "pointer",
            opacity: state.settings.recentFiles.length === 0 ? 0.4 : 1,
          }}
        >
          Recent
          <svg width="9" height="9" viewBox="0 0 8 8" fill="currentColor" style={{ marginLeft: "2px" }}>
            <path d="M0 2l4 4 4-4H0z" />
          </svg>
        </button>
        {showRecent && state.settings.recentFiles.length > 0 && (
          <div
            className="absolute z-50 py-1 rounded shadow-lg"
            style={{
              top: "100%",
              left: 0,
              minWidth: "280px",
              maxWidth: "420px",
              backgroundColor: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
            }}
          >
            {state.settings.recentFiles.slice(0, 15).map((path) => {
              const name = basename(path);
              return (
                <div key={path} className="flex items-center group" style={{ minWidth: 0 }}>
                  <button
                    onClick={() => {
                      onOpenRecent(path);
                      setShowRecent(false);
                    }}
                    className="flex flex-col items-start flex-1 px-3 py-1.5 text-left text-xs transition-colors"
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      minWidth: 0,
                    }}
                    title={path}
                  >
                    <span className="font-medium truncate w-full">{name}</span>
                    <span className="truncate w-full" style={{ color: "var(--text-muted)", fontSize: "var(--ui-font-size-2xs)" }}>
                      {path}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ToolbarBtn title="Open script (Ctrl+O)" onClick={onOpen} testId="toolbar-open">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6 1H2a1 1 0 0 0-1 1v3h1V2h4v3h3V2.5L6 1zM9 5H6V2l3 3zm-8 2v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7H1zm13 7H2V8h12v6z" />
        </svg>
      </ToolbarBtn>

      <ToolbarBtn
        title="Save (Ctrl+S)"
        onClick={onSave}
        testId="toolbar-save"
        disabled={
          !activeTab ||
          activeTab.tabType === "welcome" ||
          (!activeTab.isDirty && !!activeTab.filePath)
        }
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.354 1.146l1.5 1.5A.5.5 0 0 1 15 3v11a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h10.5a.5.5 0 0 1 .354.146zM2 2v12h12V3.207L12.793 2H11v4H4V2H2zm3 0v3h5V2H5z" />
        </svg>
      </ToolbarBtn>

      <div className="mx-2 h-5" style={{ width: "1px", backgroundColor: "var(--border-primary)" }} />

      <ToolbarBtn
        title={showDebuggerTools ? "Run or Debug (F5)" : "Run script (F5)"}
        onClick={onRun}
        testId="toolbar-run"
        disabled={
          state.isRunning ||
          !state.selectedPsPath ||
          !activeTab ||
          activeTab.tabType === "welcome"
        }
        className="text-green-400 hover:text-green-300"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2l10 6-10 6V2z" />
        </svg>
      </ToolbarBtn>

      {showDebuggerTools && (
        <>
          <ToolbarBtn
            title="Start Debugging"
            onClick={onDebugStart}
            testId="toolbar-debug-start"
            disabled={
              state.isRunning ||
              !state.selectedPsPath ||
              !activeTab ||
              activeTab.tabType === "welcome"
            }
            className="text-yellow-400 hover:text-yellow-300"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="8" r="5" />
            </svg>
          </ToolbarBtn>
          <ToolbarBtn
            title="Continue"
            onClick={onDebugContinue}
            testId="toolbar-debug-continue"
            disabled={!state.isDebugging || !state.debugPaused}
            className="text-yellow-300"
          >
            <span style={{ fontSize: "var(--ui-font-size-2xs)", fontWeight: 700 }}>▶</span>
          </ToolbarBtn>
        </>
      )}

      <ToolbarBtn
        title="Stop (Shift+F5)"
        onClick={onStop}
        testId="toolbar-stop"
        disabled={!state.isRunning}
        className="text-red-400 hover:text-red-300"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <rect x="3" y="3" width="10" height="10" />
        </svg>
      </ToolbarBtn>

      <div className="mx-2 h-5" style={{ width: "1px", backgroundColor: "var(--border-primary)" }} />

      <div ref={overflowRef} className="relative">
        <ToolbarBtn
          title="More tools"
          testId="toolbar-overflow"
          onClick={() => setShowOverflow((v) => !v)}
        >
          ⋯
        </ToolbarBtn>
        {showOverflow && (
          <div
            className="absolute z-50 py-1 rounded shadow-lg"
            style={{
              top: "100%",
              left: 0,
              minWidth: "200px",
              backgroundColor: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
            }}
          >
            <OverflowItem label="New file (Ctrl+N)" onClick={() => { onNew(); setShowOverflow(false); }} />
            <OverflowItem label="Save all" onClick={() => { onSaveAll(); setShowOverflow(false); }} disabled={!hasSavableTabs} />
            <OverflowItem label="Format document" onClick={() => { onFormat(); setShowOverflow(false); }} disabled={!activeTab || activeTab.tabType === "welcome" || !state.selectedPsPath} />
            <OverflowItem label="Find & replace (Ctrl+H)" onClick={() => { onFindReplace(); setShowOverflow(false); }} disabled={!activeTab || activeTab.tabType === "welcome"} />
            <OverflowItem label="Open $PROFILE" onClick={() => { onOpenProfile(); setShowOverflow(false); }} disabled={!state.selectedPsPath} />
            <OverflowItem label="Print script" onClick={() => { onPrint(); setShowOverflow(false); }} disabled={!activeTab || activeTab.tabType === "welcome" || !activeTab.content} />
            <OverflowItem label="Sign script" onClick={() => { onSign(); setShowOverflow(false); }} disabled={!activeTab || activeTab.tabType === "welcome" || !activeTab.filePath} />
          </div>
        )}
      </div>

      <div className="mx-2 h-5" style={{ width: "1px", backgroundColor: "var(--border-primary)" }} />

      {/* PS Version selector */}
      <select
        title="PowerShell Version"
        data-testid="toolbar-ps-selector"
        value={state.selectedPsPath}
        onChange={(e) => {
          const nextPath = e.target.value;
          dispatch({ type: "SET_SELECTED_PS", path: nextPath });
          dispatch({
            type: "SET_SETTINGS",
            settings: { ...state.settings, defaultPsVersion: nextPath || "auto" },
          });
        }}
        className="text-xs py-0.5 rounded"
        style={{
          backgroundColor: "var(--bg-input)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-primary)",
          minWidth: "160px",
        }}
      >
        {state.psVersions.length === 0 && (
          <option value="">No PowerShell found</option>
        )}
        {state.psVersions.map((v) => (
          <option key={v.path} value={v.path}>
            {v.name}
          </option>
        ))}
      </select>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Theme selector */}
      <select
        title="Theme"
        data-testid="toolbar-theme-selector"
        value={state.settings.theme}
        onChange={(e) => handleThemeChange(e.target.value as ThemeName)}
        className="text-xs py-0.5 rounded"
        style={{
          backgroundColor: "var(--bg-input)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-primary)",
        }}
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="ise-classic">ISE Classic</option>
      </select>

      {/* Modules panel toggle */}
      <ToolbarBtn
        title={
          state.sidebarVisible ? "Hide Modules Panel" : "Show Modules Panel"
        }
        onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
        testId="toolbar-modules"
        className={state.sidebarVisible ? "text-blue-400" : ""}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2zm2 0v12h2V2H3zm4 0a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V2zm2 0v12h5V2H9z" />
        </svg>
      </ToolbarBtn>

      <div
        className="mx-1 h-5"
        style={{ width: "1px", backgroundColor: "var(--border-primary)" }}
      />

      {/* Settings button */}
      <ToolbarBtn
        title="Settings (Ctrl+,)"
        testId="toolbar-settings"
        onClick={() => dispatch({ type: "TOGGLE_SETTINGS" })}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z" />
          <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.421 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.421-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.318z" />
        </svg>
      </ToolbarBtn>

      <div
        className="mx-1 h-5"
        style={{ width: "1px", backgroundColor: "var(--border-primary)" }}
      />

      {/* About button */}
      <ToolbarBtn
        title="About PS Forge"
        testId="toolbar-about"
        onClick={() => dispatch({ type: "TOGGLE_ABOUT" })}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle
            cx="8"
            cy="8"
            r="7"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
          <text
            x="8"
            y="12"
            textAnchor="middle"
            fontSize="9"
            fontWeight="bold"
            fill="currentColor"
          >
            i
          </text>
        </svg>
      </ToolbarBtn>

      {/* Keyboard shortcut help button */}
      <ToolbarBtn
        title="Keyboard Shortcuts (Ctrl+F1)"
        testId="toolbar-shortcuts"
        onClick={() => dispatch({ type: "TOGGLE_SHORTCUT_PANEL" })}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle
            cx="8"
            cy="8"
            r="7"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
          <text
            x="8"
            y="12"
            textAnchor="middle"
            fontSize="9"
            fontWeight="bold"
            fill="currentColor"
          >
            ?
          </text>
        </svg>
      </ToolbarBtn>
    </div>
  );
}

/** Reusable toolbar button. */
function ToolbarBtn({
  children,
  title,
  onClick,
  disabled,
  className = "",
  testId,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`flex items-center justify-center w-8 h-8 rounded transition-colors ${className}`}
      style={{
        backgroundColor: "transparent",
        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          (e.currentTarget as HTMLElement).style.backgroundColor =
            "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
      }}
    >
      {children}
    </button>
  );
}



function OverflowItem({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block w-full text-left px-3 py-1.5 text-xs transition-colors"
      style={{
        backgroundColor: "transparent",
        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
