/** PSForge Toolbar.
 *  A classic menu bar (File / Edit / View / Help) plus the primary AI
 *  paste-and-run workflow buttons. Every secondary action lives in a labeled
 *  menu with its shortcut shown, instead of hiding behind unlabeled icons or
 *  an overflow menu.
 */

import React, { useState, useRef, useEffect } from "react";
import { basename } from "../path-utils";
import { isScratchBackedTab } from "../scratch-utils";
import { useAppState } from "../store";
import type { ThemeName } from "../types";

interface ToolbarProps {
  onNew: () => void;
  onOpen: () => void;
  /** Called when the user selects a path from File → recent scripts. */
  onOpenRecent: (path: string) => void;
  /** Open every PowerShell script in a picked folder. */
  onOpenFolder: () => void;
  onSave: () => void;
  onSaveAll: () => void;
  onRun: () => void;
  /** Start running the active script under the debugger. */
  onDebugStart: () => void;
  /** Continue execution from the current debugger stop point. */
  onDebugContinue: () => void;
  onStop: () => void;
  /** Format current script with Invoke-Formatter (Shift+Alt+F). */
  onFormat: () => void;
  /** Paste from clipboard, clean, format, and (per settings) run.
   *  Works from the Welcome tab too (opens a new script tab). */
  onPasteScript: () => void;
  /** Copy the debug bundle (last run output + exit code + PSSA). */
  onCopyDebugBundle: () => void;
  /** Trigger Monaco's built-in Find & Replace widget. */
  onFindReplace: () => void;
  /** Open the current user's $PROFILE for editing. */
  onOpenProfile: () => void;
  /** Print the current script content. */
  onPrint: () => void;
  /** Open the script signing dialog. */
  onSign: () => void;
  /** Manual application update check (same as the status bar link). */
  onCheckForUpdates: () => void;
}

type MenuId = "file" | "edit" | "view" | "help";

const MENU_RECENT_LIMIT = 15;

export function Toolbar({
  onNew,
  onOpen,
  onOpenRecent,
  onOpenFolder,
  onSave,
  onSaveAll,
  onRun,
  onDebugStart,
  onDebugContinue,
  onStop,
  onFormat,
  onPasteScript,
  onCopyDebugBundle,
  onFindReplace,
  onOpenProfile,
  onPrint,
  onSign,
  onCheckForUpdates,
}: ToolbarProps) {
  const { state, dispatch, activeTab } = useAppState();
  const showDebuggerTools = state.settings.showDebuggerTools === true;
  // A scratch backing path is internal, not a user-chosen save location, so
  // scratch-backed tabs always need Save (As) — even when auto-save has
  // marked them clean (S6-8).
  const needsSave = (t: (typeof state.tabs)[number]) =>
    t.isDirty ||
    !t.filePath ||
    (!!state.scratchDir && isScratchBackedTab(t, state.scratchDir));
  const hasSavableTabs = state.tabs.some(
    (t) => t.tabType !== "welcome" && needsSave(t),
  );
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Close any open menu on outside click or Escape.
  useEffect(() => {
    if (!openMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        menuBarRef.current &&
        !menuBarRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  // Modals opened via global shortcuts (Ctrl+, / Ctrl+F1 / Ctrl+Shift+P …)
  // paint over an open dropdown without any mousedown/Escape reaching it;
  // close the menu so it doesn't reappear stale when the modal closes.
  const modalOpen =
    state.settingsOpen ||
    state.commandPaletteOpen ||
    state.shortcutPanelOpen ||
    state.showAbout ||
    state.showSigningDialog;
  useEffect(() => {
    if (modalOpen) setOpenMenu(null);
  }, [modalOpen]);

  const handleThemeChange = (theme: ThemeName) => {
    document.documentElement.setAttribute("data-theme", theme);
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, theme },
    });
  };

  const hasCodeTab = !!activeTab && activeTab.tabType !== "welcome";
  const pasteRuns = state.settings.runAfterPasteCleanFormat !== false;
  const canSave = hasCodeTab && !!activeTab && needsSave(activeTab);
  const recentFiles = state.settings.recentFiles.slice(0, MENU_RECENT_LIMIT);

  /** Runs a menu action and closes the menu. */
  const menuAction = (action: () => void) => () => {
    setOpenMenu(null);
    action();
  };

  const exitApp = async () => {
    try {
      // Same flush-then-exit path as the tray's Exit action: the store
      // listener saves pending settings, then terminates the process.
      // window.close() would only hide the window to the tray.
      const { emit } = await import("@tauri-apps/api/event");
      await emit("psforge-exit-requested");
    } catch {
      // Event API unavailable (tests / browser preview): nothing to exit.
    }
  };

  const openWelcomePage = () => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_openWelcome as (() => void) | undefined;
    fn?.();
  };

  const menuButton = (id: MenuId, label: string) => (
    <button
      type="button"
      data-testid={`menubar-${id}`}
      className={`menubar-btn ${openMenu === id ? "menubar-btn-open" : ""}`}
      onClick={() => setOpenMenu((current) => (current === id ? null : id))}
      onMouseEnter={() => {
        // Hover-to-switch once a menu is open, like native menu bars.
        setOpenMenu((current) => (current && current !== id ? id : current));
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      data-testid="toolbar-root"
      className="flex items-center gap-1 py-1 no-select"
      style={{
        backgroundColor: "var(--bg-toolbar)",
        borderBottom: "1px solid var(--border-primary)",
        minHeight: "42px",
        paddingLeft: "8px",
        paddingRight: "12px",
      }}
    >
      {/* Menu bar */}
      <div
        ref={menuBarRef}
        className="flex items-center"
        onBlur={(e) => {
          // Keyboard Tab-away: close when focus leaves the menu bar. A null
          // relatedTarget (click on non-focusable page area) is left to the
          // document mousedown handler instead.
          if (
            e.relatedTarget &&
            !e.currentTarget.contains(e.relatedTarget as Node)
          ) {
            setOpenMenu(null);
          }
        }}
      >
        <div className="relative">
          {menuButton("file", "File")}
          {openMenu === "file" && (
            <div
              className="menu-pop"
              style={{ top: "100%", left: 0, minWidth: "260px" }}
            >
              <MenuItem
                label="New Script"
                shortcut="Ctrl+N"
                onClick={menuAction(onNew)}
              />
              <MenuItem
                label="Open Script…"
                shortcut="Ctrl+O"
                onClick={menuAction(onOpen)}
              />
              <MenuItem
                label="Open Folder…"
                onClick={menuAction(onOpenFolder)}
              />
              {recentFiles.length > 0 && (
                <>
                  <div className="menu-header">Recent</div>
                  {recentFiles.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className="menu-item"
                      // 10px padding + 16px check gutter keeps recent entries
                      // aligned with the MenuItem labels above them.
                      style={{ minWidth: 0, maxWidth: "340px", paddingLeft: "26px" }}
                      title={path}
                      onClick={menuAction(() => onOpenRecent(path))}
                    >
                      <span className="block truncate">{basename(path)}</span>
                    </button>
                  ))}
                </>
              )}
              <div className="menu-separator" />
              <MenuItem
                label="Save"
                shortcut="Ctrl+S"
                disabled={!canSave}
                onClick={menuAction(onSave)}
              />
              <MenuItem
                label="Save All"
                disabled={!hasSavableTabs}
                onClick={menuAction(onSaveAll)}
              />
              <div className="menu-separator" />
              <MenuItem
                label="Sign Script…"
                disabled={!hasCodeTab || !activeTab?.filePath}
                onClick={menuAction(onSign)}
              />
              <MenuItem
                label="Print…"
                disabled={!hasCodeTab || !activeTab?.content}
                onClick={menuAction(onPrint)}
              />
              <MenuItem
                label="Open $PROFILE"
                disabled={!state.selectedPsPath}
                onClick={menuAction(onOpenProfile)}
              />
              <div className="menu-separator" />
              <MenuItem
                label="Settings…"
                shortcut="Ctrl+,"
                onClick={menuAction(() => dispatch({ type: "TOGGLE_SETTINGS" }))}
              />
              <div className="menu-separator" />
              <MenuItem label="Exit" onClick={menuAction(() => void exitApp())} />
            </div>
          )}
        </div>

        <div className="relative">
          {menuButton("edit", "Edit")}
          {openMenu === "edit" && (
            <div
              className="menu-pop"
              style={{ top: "100%", left: 0, minWidth: "280px" }}
            >
              <MenuItem
                label="Paste Clean + Format"
                shortcut="Ctrl+Shift+Alt+V"
                disabled={!state.selectedPsPath}
                onClick={menuAction(onPasteScript)}
              />
              <MenuItem
                label="Format Document"
                shortcut="Shift+Alt+F"
                disabled={!hasCodeTab || !state.selectedPsPath}
                onClick={menuAction(onFormat)}
              />
              <MenuItem
                label="Find & Replace"
                shortcut="Ctrl+H"
                disabled={!hasCodeTab}
                onClick={menuAction(onFindReplace)}
              />
              <div className="menu-separator" />
              <MenuItem
                label="Insert Snippet…"
                shortcut="Ctrl+J"
                disabled={!hasCodeTab}
                onClick={menuAction(() =>
                  dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "snippets" }),
                )}
              />
              <MenuItem
                label="Command Palette…"
                shortcut="Ctrl+Shift+P"
                onClick={menuAction(() =>
                  dispatch({ type: "OPEN_COMMAND_PALETTE", mode: "all" }),
                )}
              />
            </div>
          )}
        </div>

        <div className="relative">
          {menuButton("view", "View")}
          {openMenu === "view" && (
            <div
              className="menu-pop"
              style={{ top: "100%", left: 0, minWidth: "230px" }}
            >
              <MenuItem
                label="Modules Panel"
                checked={state.sidebarVisible}
                onClick={menuAction(() => dispatch({ type: "TOGGLE_SIDEBAR" }))}
              />
              <MenuItem
                label="Welcome Page"
                onClick={menuAction(openWelcomePage)}
              />
              <div className="menu-separator" />
              <div className="menu-header">Theme</div>
              {(
                [
                  ["dark", "Dark"],
                  ["light", "Light"],
                  ["ise-classic", "ISE Classic"],
                ] as [ThemeName, string][]
              ).map(([id, label]) => (
                <MenuItem
                  key={id}
                  label={label}
                  checked={state.settings.theme === id}
                  onClick={menuAction(() => handleThemeChange(id))}
                />
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          {menuButton("help", "Help")}
          {openMenu === "help" && (
            <div
              className="menu-pop"
              style={{ top: "100%", left: 0, minWidth: "240px" }}
            >
              <MenuItem
                label="Keyboard Shortcuts"
                shortcut="Ctrl+F1"
                onClick={menuAction(() =>
                  dispatch({ type: "TOGGLE_SHORTCUT_PANEL" }),
                )}
              />
              <MenuItem
                label="Welcome Page"
                onClick={menuAction(openWelcomePage)}
              />
              <div className="menu-separator" />
              <MenuItem
                label="Check for Updates…"
                onClick={menuAction(onCheckForUpdates)}
              />
              <MenuItem
                label="About PSForge"
                onClick={menuAction(() => dispatch({ type: "TOGGLE_ABOUT" }))}
              />
            </div>
          )}
        </div>
      </div>

      <div className="tb-divider" />

      {/* AI paste-and-run workflow */}
      <button
        type="button"
        data-testid="toolbar-paste-run"
        title={
          pasteRuns
            ? "Paste from clipboard, clean smart quotes/code fences, format, and run (Ctrl+Shift+Alt+V)"
            : "Paste from clipboard, clean smart quotes/code fences, and format (Ctrl+Shift+Alt+V)"
        }
        onClick={onPasteScript}
        disabled={!state.selectedPsPath}
        className="tb-action tb-action-solid"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M10 1.5a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1H4.5A1.5 1.5 0 0 0 3 3v11a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 14V3a1.5 1.5 0 0 0-1.5-1.5H10zM7 1.5h2V3H7V1.5zM4.5 3H6v.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5V3h1.5a.5.5 0 0 1 .5.5V14a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z" />
        </svg>
        {pasteRuns ? "Paste + Run" : "Paste clean"}
      </button>

      <button
        type="button"
        data-testid="toolbar-run"
        title={showDebuggerTools ? "Run or Debug (F5)" : "Run script (F5)"}
        onClick={onRun}
        disabled={state.isRunning || !state.selectedPsPath || !hasCodeTab}
        className="tb-action tb-action-run"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2l10 6-10 6V2z" />
        </svg>
        Run
      </button>

      {showDebuggerTools && (
        <>
          <IconBtn
            title="Start Debugging"
            onClick={onDebugStart}
            testId="toolbar-debug-start"
            disabled={state.isRunning || !state.selectedPsPath || !hasCodeTab}
            className="text-yellow-400 hover:text-yellow-300"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="8" r="5" />
            </svg>
          </IconBtn>
          <IconBtn
            title="Continue"
            onClick={onDebugContinue}
            testId="toolbar-debug-continue"
            disabled={!state.isDebugging || !state.debugPaused}
            className="text-yellow-300"
          >
            <span style={{ fontSize: "var(--ui-font-size-2xs)", fontWeight: 700 }}>
              ▶
            </span>
          </IconBtn>
        </>
      )}

      <button
        type="button"
        data-testid="toolbar-stop"
        title="Stop (Shift+F5)"
        onClick={onStop}
        disabled={!state.isRunning}
        className="tb-action tb-action-stop"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
          <rect x="3" y="3" width="10" height="10" rx="1" />
        </svg>
        Stop
      </button>

      {/* "Copy for AI" targets EXTERNAL AI chats (copy bundle → paste into a
          conversation), so it stays — with this name — even when the in-app
          AI assistant is disabled. */}
      <button
        type="button"
        data-testid="toolbar-copy-bundle"
        title="Copy debug bundle: last run output, exit code, and PSScriptAnalyzer findings as markdown"
        onClick={onCopyDebugBundle}
        disabled={!state.lastRunResult || state.isRunning}
        className="tb-action tb-action-accent"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h1V2zm1 1h6a1 1 0 0 1 1 1v8h1V2H5v1zM3 4v10h8V4H3z" />
        </svg>
        Copy for AI
      </button>

      <div className="tb-divider" />

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
        style={{ minWidth: "160px" }}
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
    </div>
  );
}

/** Reusable icon-only toolbar button. */
function IconBtn({
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
      className={`icon-btn ${className}`}
    >
      {children}
    </button>
  );
}

/** Menu entry with optional right-aligned shortcut hint and checkmark. */
function MenuItem({
  label,
  shortcut,
  checked,
  disabled,
  onClick,
}: {
  label: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="menu-item"
    >
      <span className="menu-item-row">
        <span className="flex items-center">
          <span className="menu-check">{checked ? "✓" : ""}</span>
          {label}
        </span>
        {shortcut && <span className="menu-shortcut">{shortcut}</span>}
      </span>
    </button>
  );
}
