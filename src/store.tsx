/** PSForge application state management using React context + useReducer.
 *  Central store for all application state: tabs, output, settings, etc.
 */

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import type {
  EditorTab,
  OutputLine,
  PsVersion,
  AppSettings,
  VariableInfo,
  ModuleInfo,
  ProblemItem,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import * as cmd from "./commands";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of output lines retained in React state.
 *  Prevents unbounded memory growth for long-running scripts.
 *  The Rust backend already caps at 100 000 lines; this is the UI-side bound.
 */
const MAX_OUTPUT_LINES = 10_000;

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface AppState {
  tabs: EditorTab[];
  activeTabId: string;
  outputLines: OutputLine[];
  /** Diagnostic problems parsed from the last script run's stderr output. */
  problems: ProblemItem[];
  isRunning: boolean;
  psVersions: PsVersion[];
  selectedPsPath: string;
  workingDir: string;
  settings: AppSettings;
  settingsLoaded: boolean;
  variables: VariableInfo[];
  modules: ModuleInfo[];
  modulesLoading: boolean;
  sidebarVisible: boolean;
  /** Which side of the editor the module browser panel is docked to. */
  sidebarPosition: "left" | "right";
  bottomPanelTab: "output" | "variables" | "problems" | "terminal";
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  /** Command palette mode: full command list or snippets-only picker. */
  commandPaletteMode: "all" | "snippets";
  /** Whether the keyboard shortcut reference panel is open. */
  shortcutPanelOpen: boolean;
  /** Current editor cursor line (1-indexed). Updated on every cursor move. */
  cursorLine: number;
  /** Current editor cursor column (1-indexed). Updated on every cursor move. */
  cursorColumn: number;
  /** Whether the About dialog is visible. */
  showAbout: boolean;
  /** Whether the script signing dialog is visible. */
  showSigningDialog: boolean;
}

/** Detects first launch by checking localStorage and creates the appropriate initial tab. */
function createInitialTab(): EditorTab {
  const welcomed = localStorage.getItem("psforge.welcomed");
  if (!welcomed) {
    localStorage.setItem("psforge.welcomed", "1");
    return {
      id: "tab-welcome",
      title: "Welcome",
      filePath: "",
      content: "",
      savedContent: "",
      encoding: "utf8",
      language: "markdown",
      isDirty: false,
      tabType: "welcome",
    };
  }
  return {
    id: "tab-1",
    title: "Untitled-1",
    filePath: "",
    content: "",
    savedContent: "",
    encoding: "utf8",
    language: "powershell",
    isDirty: false,
    tabType: "code",
  };
}

const initialTab = createInitialTab();

const initialState: AppState = {
  tabs: [initialTab],
  activeTabId: initialTab.id,
  outputLines: [],
  problems: [],
  isRunning: false,
  psVersions: [],
  selectedPsPath: "",
  workingDir: "",
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  variables: [],
  modules: [],
  modulesLoading: false,
  sidebarVisible: true,
  sidebarPosition: "left" as const,
  bottomPanelTab: "terminal",
  settingsOpen: false,
  commandPaletteOpen: false,
  commandPaletteMode: "all",
  shortcutPanelOpen: false,
  cursorLine: 1,
  cursorColumn: 1,
  showAbout: false,
  showSigningDialog: false,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { type: "SET_TABS"; tabs: EditorTab[] }
  | { type: "SET_ACTIVE_TAB"; id: string }
  | { type: "ADD_TAB"; tab: EditorTab }
  | { type: "CLOSE_TAB"; id: string }
  | { type: "UPDATE_TAB"; id: string; changes: Partial<EditorTab> }
  | { type: "REORDER_TABS"; fromId: string; toId: string }
  | { type: "ADD_OUTPUT"; line: OutputLine }
  | { type: "CLEAR_OUTPUT" }
  | { type: "SET_RUNNING"; running: boolean }
  | { type: "SET_PS_VERSIONS"; versions: PsVersion[] }
  | { type: "SET_SELECTED_PS"; path: string }
  | { type: "SET_WORKING_DIR"; dir: string }
  | { type: "SET_SETTINGS"; settings: AppSettings }
  | { type: "SET_SETTINGS_LOADED"; loaded: boolean }
  | { type: "SET_VARIABLES"; variables: VariableInfo[] }
  | { type: "SET_MODULES"; modules: ModuleInfo[] }
  | { type: "SET_MODULES_LOADING"; loading: boolean }
  | { type: "SET_PROBLEMS"; problems: ProblemItem[] }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "SET_SIDEBAR_POSITION"; position: "left" | "right" }
  | { type: "REMOVE_RECENT_FILE"; path: string }
  | {
      type: "SET_BOTTOM_TAB";
      tab: "output" | "variables" | "problems" | "terminal";
    }
  | { type: "TOGGLE_SETTINGS" }
  | { type: "OPEN_COMMAND_PALETTE"; mode?: "all" | "snippets" }
  | { type: "CLOSE_COMMAND_PALETTE" }
  | { type: "TOGGLE_COMMAND_PALETTE" }
  | { type: "TOGGLE_SHORTCUT_PANEL" }
  | { type: "SET_CURSOR_POSITION"; line: number; column: number }
  | { type: "TOGGLE_ABOUT" }
  | { type: "TOGGLE_SIGNING_DIALOG" };

// ---------------------------------------------------------------------------
// Problem parsing
// ---------------------------------------------------------------------------

/**
 * Strips ANSI/VT escape sequences from a string.
 * PowerShell emits colour codes (e.g. \x1b[31;1m) in error records when the
 * host reports it supports colour.  These must be removed before the text is
 * stored or displayed as plain text.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Parses stderr output lines from a completed run into structured ProblemItem records.
 *
 * Handles both PS5 and PS7 error record formats:
 *
 * PS5 / common runtime errors:
 *   <message>
 *   At <path>:<line> char:<col>
 *   + <context snippet>
 *   + FullyQualifiedErrorId: ...
 *
 * PS7 parser / compile errors:
 *   ParserError:          <- error type header (skipped)
 *   Line |                <- line separator (skipped)
 *     N | <code snippet>  <- code line (skipped)
 *       | ~~~~            <- pointer (skipped)
 *       | <actual message> <- real message (| prefix stripped)
 *   At <path>:<line> char:<col>
 *
 * Location info is extracted from the nearest following "At ... char:N" line.
 */
function parseProblems(lines: OutputLine[]): ProblemItem[] {
  const problems: ProblemItem[] = [];
  const stderrLines = lines.filter((l) => l.stream === "stderr");
  if (stderrLines.length === 0) return problems;

  // Matches "At line:N char:M" or "At C:\path\file.ps1:N char:M"
  const locRe = /At (?:[^\s:]+:)?(\d+)\s+char:(\d+)/i;

  // PS7-specific patterns (matched against the trimmed line)
  // e.g. "ParserError:" / "RuntimeException:" standalone type headers
  const ps7TypeHeader = /^[\w.]+(?:Error|Exception):\s*$/;
  // e.g. "Line |" separator
  const ps7LineSep = /^[Ll]ine\s*\|\s*$/;
  // e.g. "  14 |  code here" code snippet
  const ps7CodeSnippet = /^\d+\s*\|/;
  // e.g. "|  ~~~~~" pointer-only line
  const ps7Pointer = /^\|\s*~+\s*$/;
  // e.g. "|  Variable reference is not valid" pipe-prefixed message
  const ps7PipeMsg = /^\|\s+(.*)/;

  for (let i = 0; i < stderrLines.length; i++) {
    // Strip ANSI codes before any processing so escape sequences don't bleed
    // into messages or confuse the metadata-line detection regexes.
    const text = stripAnsi(stderrLines[i].text).trim();
    if (!text) continue;
    // Skip PS5-style metadata continuation lines (start with + or ~)
    if (text.startsWith("+") || text.startsWith("~")) continue;
    // Skip location-only lines -- they are associated with the preceding message
    if (/^At /i.test(text) && locRe.test(text)) continue;
    // Skip process-exit notifications emitted by the PSForge runner, not PS itself
    if (/^Process exited with code/i.test(text)) continue;
    // Skip lines that are just punctuation / single chars after ANSI stripping
    if (text.length <= 2) continue;
    // Skip PS7 noise lines
    if (ps7TypeHeader.test(text)) continue;
    if (ps7LineSep.test(text)) continue;
    if (ps7CodeSnippet.test(text)) continue;
    if (ps7Pointer.test(text)) continue;

    // For PS7 pipe-prefixed lines ("| message text"), strip the leading "|".
    let messageText = text;
    const pipeMatch = ps7PipeMsg.exec(text);
    if (pipeMatch) {
      messageText = pipeMatch[1].trim();
      if (!messageText) continue;
    }

    // Look ahead up to 6 lines for the location context.
    let lineNum: number | undefined;
    let colNum: number | undefined;
    for (let j = i + 1; j < Math.min(i + 7, stderrLines.length); j++) {
      // Trim + strip ANSI before matching: PowerShell indents "At line:N char:M"
      // lines with leading spaces, which would otherwise cause the regex to miss them.
      const m = locRe.exec(stripAnsi(stderrLines[j].text).trim());
      if (m) {
        lineNum = parseInt(m[1], 10);
        colNum = parseInt(m[2], 10);
        break;
      }
    }

    problems.push({
      severity: "error",
      message: messageText,
      source: "PowerShell",
      line: lineNum,
      column: colNum,
    });
  }

  return problems;
}

/** Pure reducer function for PSForge app state.
 *  Handles every Action variant by returning a new state object (immutable update).
 *  Kept pure (no side-effects) so it is safe to call from React's concurrent mode.
 */
function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_TABS":
      return { ...state, tabs: action.tabs };

    case "SET_ACTIVE_TAB":
      return { ...state, activeTabId: action.id };

    case "ADD_TAB":
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activeTabId: action.tab.id,
      };

    case "CLOSE_TAB": {
      const remaining = state.tabs.filter((t) => t.id !== action.id);
      let newActive = state.activeTabId;
      if (state.activeTabId === action.id) {
        const closedIndex = state.tabs.findIndex((t) => t.id === action.id);
        const next = remaining[Math.min(closedIndex, remaining.length - 1)];
        newActive = next?.id ?? "";
      }
      return { ...state, tabs: remaining, activeTabId: newActive };
    }

    case "UPDATE_TAB":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, ...action.changes } : t,
        ),
      };

    case "REORDER_TABS": {
      const fromIndex = state.tabs.findIndex((t) => t.id === action.fromId);
      const toIndex = state.tabs.findIndex((t) => t.id === action.toId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex)
        return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      return { ...state, tabs };
    }

    case "ADD_OUTPUT": {
      const next = [...state.outputLines, action.line];
      // Trim oldest lines when the cap is exceeded to prevent memory growth.
      const trimmed =
        next.length > MAX_OUTPUT_LINES
          ? next.slice(next.length - MAX_OUTPUT_LINES)
          : next;
      return { ...state, outputLines: trimmed };
    }

    case "CLEAR_OUTPUT":
      return { ...state, outputLines: [], problems: [] };

    case "SET_RUNNING":
      if (!action.running) {
        // When a run finishes, parse stderr lines into structured problems.
        return {
          ...state,
          isRunning: false,
          problems: parseProblems(state.outputLines),
        };
      }
      // BUG-NEW-3 fix: clear stale problems immediately when a new run starts
      // so the Problems tab never shows diagnostics from the previous run
      // while the current script is executing.  Problems are re-populated
      // from stderr when SET_RUNNING: false fires at run completion.
      return { ...state, isRunning: true, problems: [] };

    case "SET_PS_VERSIONS":
      return { ...state, psVersions: action.versions };

    case "SET_SELECTED_PS":
      return { ...state, selectedPsPath: action.path };

    case "SET_WORKING_DIR":
      return { ...state, workingDir: action.dir };

    case "SET_SETTINGS":
      return { ...state, settings: action.settings };

    case "SET_SETTINGS_LOADED":
      return { ...state, settingsLoaded: action.loaded };

    case "SET_VARIABLES":
      return { ...state, variables: action.variables };

    case "SET_MODULES":
      return { ...state, modules: action.modules };

    case "SET_MODULES_LOADING":
      return { ...state, modulesLoading: action.loading };

    case "SET_PROBLEMS":
      return { ...state, problems: action.problems };

    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarVisible: !state.sidebarVisible };

    case "SET_SIDEBAR_POSITION":
      return { ...state, sidebarPosition: action.position };

    case "REMOVE_RECENT_FILE":
      return {
        ...state,
        settings: {
          ...state.settings,
          recentFiles: state.settings.recentFiles.filter(
            (f) => f !== action.path,
          ),
        },
      };

    case "SET_BOTTOM_TAB":
      return { ...state, bottomPanelTab: action.tab };

    case "TOGGLE_SETTINGS":
      return { ...state, settingsOpen: !state.settingsOpen };

    case "OPEN_COMMAND_PALETTE":
      return {
        ...state,
        commandPaletteOpen: true,
        commandPaletteMode: action.mode ?? "all",
      };

    case "CLOSE_COMMAND_PALETTE":
      return {
        ...state,
        commandPaletteOpen: false,
        commandPaletteMode: "all",
      };

    case "TOGGLE_COMMAND_PALETTE":
      return state.commandPaletteOpen
        ? { ...state, commandPaletteOpen: false, commandPaletteMode: "all" }
        : { ...state, commandPaletteOpen: true, commandPaletteMode: "all" };

    case "TOGGLE_SHORTCUT_PANEL":
      return { ...state, shortcutPanelOpen: !state.shortcutPanelOpen };

    case "SET_CURSOR_POSITION":
      return { ...state, cursorLine: action.line, cursorColumn: action.column };

    case "TOGGLE_ABOUT":
      return { ...state, showAbout: !state.showAbout };

    case "TOGGLE_SIGNING_DIALOG":
      return { ...state, showSigningDialog: !state.showSigningDialog };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** Convenience: get the active tab object. */
  activeTab: EditorTab | undefined;
}

const AppContext = createContext<AppContextValue | null>(null);

/** Hook to access PSForge app state. */
export function useAppState(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used within AppProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let tabCounter = 1;

/** Generates a unique tab id. */
export function newTabId(): string {
  tabCounter += 1;
  return `tab-${tabCounter}`;
}

/** Monotonically increasing counter for untitled tab titles.
 *  Unlike `state.tabs.length + 1` (which can produce duplicate titles after
 *  closing tabs), this counter only grows, so "Untitled-N" titles are unique.
 */
let untitledNum = 1;
export function untitledCounter(): number {
  untitledNum += 1;
  return untitledNum;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  // Load settings and PS versions on mount
  useEffect(() => {
    (async () => {
      let loadedSettings = DEFAULT_SETTINGS;
      try {
        const settings = await cmd.loadSettings();
        loadedSettings = settings;
        dispatch({ type: "SET_SETTINGS", settings });

        // Apply theme
        document.documentElement.setAttribute("data-theme", settings.theme);

        // Apply UI-wide font settings as CSS variables
        document.documentElement.style.setProperty(
          "--ui-font-family",
          settings.uiFontFamily || settings.fontFamily,
        );
        document.documentElement.style.setProperty(
          "--ui-font-size",
          `${settings.uiFontSize || settings.fontSize}px`,
        );
        document.documentElement.style.setProperty(
          "--sidebar-font-family",
          settings.sidebarFontFamily || settings.fontFamily,
        );
        document.documentElement.style.setProperty(
          "--sidebar-font-size",
          `${settings.sidebarFontSize || 12}px`,
        );
      } catch {
        // Use defaults
      }
      dispatch({ type: "SET_SETTINGS_LOADED", loaded: true });

      try {
        const versions = await cmd.getPsVersions();
        dispatch({ type: "SET_PS_VERSIONS", versions });
        if (versions.length > 0) {
          const preferredPath = loadedSettings.defaultPsVersion;
          const preferred = versions.find((v) => v.path === preferredPath);
          dispatch({
            type: "SET_SELECTED_PS",
            path: preferred?.path || versions[0].path,
          });
        }
      } catch {
        // No PS versions found
      }
    })();
  }, []);

  // Apply font settings as CSS variables whenever they change (after initial load).
  // This ensures Settings panel changes propagate to all UI areas immediately.
  useEffect(() => {
    if (!state.settingsLoaded) return;
    document.documentElement.style.setProperty(
      "--ui-font-family",
      state.settings.uiFontFamily || state.settings.fontFamily,
    );
    document.documentElement.style.setProperty(
      "--ui-font-size",
      `${state.settings.uiFontSize || state.settings.fontSize}px`,
    );
    document.documentElement.style.setProperty(
      "--sidebar-font-family",
      state.settings.sidebarFontFamily || state.settings.fontFamily,
    );
    document.documentElement.style.setProperty(
      "--sidebar-font-size",
      `${state.settings.sidebarFontSize || 12}px`,
    );
  }, [
    state.settings.fontFamily,
    state.settings.fontSize,
    state.settings.uiFontFamily,
    state.settings.uiFontSize,
    state.settings.sidebarFontFamily,
    state.settings.sidebarFontSize,
    state.settingsLoaded,
  ]);

  // Persist settings whenever they change (after initial load)
  const saveSettingsDebounced = useCallback(
    debounce((s: AppSettings) => {
      cmd.saveSettings(s).catch(() => {});
    }, 1000),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce returns a stable function; settings are passed as argument
    [],
  );

  useEffect(() => {
    if (state.settingsLoaded) {
      saveSettingsDebounced(state.settings);
    }
  }, [state.settings, state.settingsLoaded, saveSettingsDebounced]);

  return (
    <AppContext.Provider value={{ state, dispatch, activeTab }}>
      {children}
    </AppContext.Provider>
  );
}

/** Simple debounce utility. */
function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
