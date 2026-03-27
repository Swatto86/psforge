/** PSForge Toolbar component.
 *  Contains New, Open, Save, Run, Stop, Settings, Theme selector, PS version picker,
 *  and a Recent Files dropdown.
 */

import React, { useState, useRef, useEffect } from "react";
import { useAppState } from "../store";
import type { ThemeName } from "../types";

interface ToolbarProps {
  onNew: () => void;
  onOpen: () => void;
  /** Called when the user selects a path from the Recent Files dropdown. */
  onOpenRecent: (path: string) => void;
  onSave: () => void;
  onRun: () => void;
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
  onRun,
  onStop,
  onFormat,
  onFindReplace,
  onOpenProfile,
  onPrint,
  onSign,
}: ToolbarProps) {
  const { state, dispatch, activeTab } = useAppState();
  const [showRecent, setShowRecent] = useState(false);
  const recentRef = useRef<HTMLDivElement>(null);

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
      {/* File operations */}
      <ToolbarBtn
        title="New File (Ctrl+N)"
        onClick={onNew}
        testId="toolbar-new"
      >
        +
      </ToolbarBtn>

      {/* Recent files button + dropdown */}
      <div ref={recentRef} className="relative">
        <button
          title="Recent Files"
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
          <svg
            width="9"
            height="9"
            viewBox="0 0 8 8"
            fill="currentColor"
            style={{ marginLeft: "2px" }}
          >
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
              const name = path.split("\\").pop() ?? path;
              return (
                <div
                  key={path}
                  className="flex items-center group"
                  style={{ minWidth: 0 }}
                >
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
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        "transparent";
                    }}
                    title={path}
                  >
                    <span className="font-medium truncate w-full">{name}</span>
                    <span
                      className="truncate w-full"
                      style={{ color: "var(--text-muted)", fontSize: "10px" }}
                    >
                      {path}
                    </span>
                  </button>
                  <button
                    data-testid={`recent-remove-${name}`}
                    title={`Remove ${name} from recent files`}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: "REMOVE_RECENT_FILE", path });
                    }}
                    className="flex items-center justify-center w-5 h-5 mr-1 rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: "12px",
                      lineHeight: 1,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color =
                        "var(--text-primary)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color =
                        "var(--text-muted)";
                    }}
                  >
                    &times;
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ToolbarBtn
        title="Open File (Ctrl+O)"
        onClick={onOpen}
        testId="toolbar-open"
      >
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

      <div
        className="mx-2 h-5"
        style={{
          width: "1px",
          backgroundColor: "var(--border-primary)",
        }}
      />

      {/* Run / Stop */}
      <ToolbarBtn
        title="Run Script (F5)"
        onClick={onRun}
        testId="toolbar-run"
        // BUG-NEW-2 fix: welcome tabs contain no runnable PowerShell code;
        // disable Run so the user cannot accidentally trigger an empty execution.
        disabled={
          state.isRunning ||
          !state.selectedPsPath ||
          !activeTab ||
          activeTab.tabType === "welcome"
        }
        className="text-green-400 hover:text-green-300"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2l10 6-10 6V2z" />
        </svg>
      </ToolbarBtn>
      <ToolbarBtn
        title="Stop (Ctrl+Break)"
        onClick={onStop}
        testId="toolbar-stop"
        disabled={!state.isRunning}
        className="text-red-400 hover:text-red-300"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <rect x="3" y="3" width="10" height="10" />
        </svg>
      </ToolbarBtn>

      <div
        className="mx-2 h-5"
        style={{
          width: "1px",
          backgroundColor: "var(--border-primary)",
        }}
      />

      {/* Script tools: Format, Find/Replace, Profile, Print, Sign */}
      <ToolbarBtn
        title="Format Document (Shift+Alt+F) - requires PSScriptAnalyzer"
        onClick={onFormat}
        testId="toolbar-format"
        disabled={
          !activeTab || activeTab.tabType === "welcome" || !state.selectedPsPath
        }
      >
        {/* Braces icon representing code formatting */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.5 1A1.5 1.5 0 0 0 2 2.5V5a1 1 0 0 1-1 1v.5a1 1 0 0 1 1 1v2.5A1.5 1.5 0 0 0 3.5 11H4v-1h-.5a.5.5 0 0 1-.5-.5V7a2 2 0 0 0-.947-1.71A2 2 0 0 0 3 3.71V2.5a.5.5 0 0 1 .5-.5H4V1h-.5zm9 0H12v1h.5a.5.5 0 0 1 .5.5v1.21A2 2 0 0 0 13.947 5.29 2 2 0 0 0 13 7v2.5a.5.5 0 0 1-.5.5H12v1h.5A1.5 1.5 0 0 0 14 9.5V7a1 1 0 0 1 1-1V5.5a1 1 0 0 1-1-1V2.5A1.5 1.5 0 0 0 12.5 1H12zm-7 5h5v1H5V6zm0 2h5v1H5V8z" />
        </svg>
      </ToolbarBtn>

      <ToolbarBtn
        title="Find and Replace (Ctrl+H)"
        onClick={onFindReplace}
        testId="toolbar-find-replace"
        disabled={!activeTab || activeTab.tabType === "welcome"}
      >
        {/* Magnifying glass with pencil icon */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.44 1.406a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" />
          <path d="M8.5 7.5a.5.5 0 0 0-1 0V9H6a.5.5 0 0 0 0 1h1.5v1.5a.5.5 0 0 0 1 0V10H10a.5.5 0 0 0 0-1H8.5V7.5z" />
        </svg>
      </ToolbarBtn>

      <div
        className="mx-1 h-5"
        style={{ width: "1px", backgroundColor: "var(--border-primary)" }}
      />

      <ToolbarBtn
        title="Open $PROFILE for editing"
        onClick={onOpenProfile}
        testId="toolbar-open-profile"
        disabled={!state.selectedPsPath}
      >
        {/* Person/profile icon */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.029 10 8 10c-2.029 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z" />
        </svg>
      </ToolbarBtn>

      <ToolbarBtn
        title="Print Script"
        onClick={onPrint}
        testId="toolbar-print"
        disabled={
          !activeTab || activeTab.tabType === "welcome" || !activeTab.content
        }
      >
        {/* Printer icon */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2.5 8a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z" />
          <path d="M5 1a2 2 0 0 0-2 2v2H2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2H5zm4 10H5a1 1 0 0 1-1-1v-1h6v1a1 1 0 0 1-1 1zm0-9a1 1 0 0 0-1 1v2H6V3a1 1 0 0 0-1 1v1H4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2h-1V4a1 1 0 0 0-1-1z" />
        </svg>
      </ToolbarBtn>

      <ToolbarBtn
        title="Sign Script (Authenticode)"
        onClick={onSign}
        testId="toolbar-sign"
        disabled={
          !activeTab || activeTab.tabType === "welcome" || !activeTab.filePath
        }
      >
        {/* Certificate/badge icon */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a5 5 0 0 1 5 5 4.994 4.994 0 0 1-1.012 3.026L14.83 14l-1.41 1.41-1.96-1.96A4.978 4.978 0 0 1 8 14a5 5 0 1 1 0-10v-4zM8 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
        </svg>
      </ToolbarBtn>

      <div
        className="mx-2 h-5"
        style={{
          width: "1px",
          backgroundColor: "var(--border-primary)",
        }}
      />

      {/* PS Version selector */}
      <select
        title="PowerShell Version"
        data-testid="toolbar-ps-selector"
        value={state.selectedPsPath}
        onChange={(e) =>
          dispatch({ type: "SET_SELECTED_PS", path: e.target.value })
        }
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
        title="Keyboard Shortcuts (F1)"
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
