/** PSForge application state management using React context + useReducer.
 *  Central store for all application state: tabs, output, settings, etc.
 */

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
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
  DebugBreakpoint,
  DebugLocal,
  DebugStackFrame,
  DebugWatch,
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
const SESSION_STORAGE_KEY = "psforge.session.v1";

type BottomPanelTab =
  | "output"
  | "variables"
  | "problems"
  | "terminal"
  | "debugger"
  | "show-command"
  | "help";
type BreakpointMap = Record<string, DebugBreakpoint[]>;
type BookmarkMap = Record<string, number[]>;

interface PersistedSession {
  tabs: EditorTab[];
  activeTabId: string;
  bottomPanelTab: BottomPanelTab;
  workingDir: string;
  selectedPsPath: string;
  breakpoints: BreakpointMap;
  bookmarks: BookmarkMap;
}

function isBottomPanelTab(value: unknown): value is BottomPanelTab {
  return (
    value === "output" ||
    value === "variables" ||
    value === "problems" ||
    value === "terminal" ||
    value === "debugger" ||
    value === "show-command" ||
    value === "help"
  );
}

function createUntitledTab(id = "tab-1", title = "Untitled-1"): EditorTab {
  return {
    id,
    title,
    filePath: "",
    content: "",
    savedContent: "",
    encoding: "utf8",
    language: "powershell",
    isDirty: false,
    tabType: "code",
  };
}

function normalizeBreakpointMode(value: unknown): "Read" | "Write" | "ReadWrite" {
  if (value === "Read") return "Read";
  if (value === "Write") return "Write";
  return "ReadWrite";
}

function breakpointKey(bp: DebugBreakpoint): string {
  if (typeof bp.line === "number") return `line:${bp.line}`;
  if (typeof bp.targetCommand === "string" && bp.targetCommand.trim()) {
    return `cmd:${bp.targetCommand.trim().toLowerCase()}`;
  }
  const mode = normalizeBreakpointMode(bp.mode);
  const variable = (bp.variable ?? "").toLowerCase();
  return `var:${mode}:${variable}`;
}

function normalizeBreakpoint(value: unknown): DebugBreakpoint | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return { line: value };
  }
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const line =
    typeof rec.line === "number" && Number.isInteger(rec.line) && rec.line >= 1
      ? rec.line
      : undefined;
  const variableRaw =
    typeof rec.variable === "string"
      ? rec.variable.trim().replace(/^\$/, "")
      : "";
  const variable = variableRaw.length > 0 ? variableRaw : undefined;
  const targetCommandRaw =
    typeof rec.targetCommand === "string" ? rec.targetCommand.trim() : "";
  const targetCommand =
    targetCommandRaw.length > 0 ? targetCommandRaw : undefined;
  if (line === undefined && variable === undefined && targetCommand === undefined) {
    return null;
  }

  const condition =
    typeof rec.condition === "string" && rec.condition.trim().length > 0
      ? rec.condition.trim()
      : undefined;
  const command =
    typeof rec.command === "string" && rec.command.trim().length > 0
      ? rec.command.trim()
      : undefined;
  const hitCount =
    typeof rec.hitCount === "number" &&
    Number.isInteger(rec.hitCount) &&
    rec.hitCount >= 1
      ? rec.hitCount
      : undefined;
  const mode = variable ? normalizeBreakpointMode(rec.mode) : undefined;

  return { line, variable, targetCommand, mode, condition, hitCount, command };
}

function normalizeBreakpointList(value: unknown): DebugBreakpoint[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, DebugBreakpoint>();
  for (const item of value) {
    const normalized = normalizeBreakpoint(item);
    if (!normalized) continue;
    unique.set(breakpointKey(normalized), normalized);
  }
  return [...unique.values()].sort((a, b) => {
    const aLine = typeof a.line === "number" ? a.line : Number.MAX_SAFE_INTEGER;
    const bLine = typeof b.line === "number" ? b.line : Number.MAX_SAFE_INTEGER;
    if (aLine !== bLine) return aLine - bLine;
    return breakpointKey(a).localeCompare(breakpointKey(b));
  });
}

function normalizePersistedBreakpoints(
  value: unknown,
  validTabIds: Set<string>,
): BreakpointMap {
  if (!value || typeof value !== "object") return {};
  const rec = value as Record<string, unknown>;
  const result: BreakpointMap = {};
  for (const [tabId, rawBreakpoints] of Object.entries(rec)) {
    if (!validTabIds.has(tabId)) continue;
    const breakpoints = normalizeBreakpointList(rawBreakpoints);
    if (breakpoints.length > 0) result[tabId] = breakpoints;
  }
  return result;
}

function normalizeBookmarkList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<number>();
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 1) {
      unique.add(item);
    }
  }
  return [...unique.values()].sort((a, b) => a - b);
}

function normalizePersistedBookmarks(
  value: unknown,
  validTabIds: Set<string>,
): BookmarkMap {
  if (!value || typeof value !== "object") return {};
  const rec = value as Record<string, unknown>;
  const result: BookmarkMap = {};
  for (const [tabId, rawLines] of Object.entries(rec)) {
    if (!validTabIds.has(tabId)) continue;
    const lines = normalizeBookmarkList(rawLines);
    if (lines.length > 0) result[tabId] = lines;
  }
  return result;
}

function normalizePersistedTab(value: unknown): EditorTab | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;

  const id = typeof rec.id === "string" ? rec.id : "";
  if (!id) return null;

  const tabType = rec.tabType;
  if (tabType === "welcome") return null;

  const content = typeof rec.content === "string" ? rec.content : "";
  const savedContent =
    typeof rec.savedContent === "string" ? rec.savedContent : content;

  return {
    id,
    title: typeof rec.title === "string" ? rec.title : "Untitled",
    filePath: typeof rec.filePath === "string" ? rec.filePath : "",
    content,
    savedContent,
    encoding: typeof rec.encoding === "string" ? rec.encoding : "utf8",
    language: typeof rec.language === "string" ? rec.language : "powershell",
    isDirty:
      typeof rec.isDirty === "boolean" ? rec.isDirty : content !== savedContent,
    tabType: "code",
  };
}

function loadPersistedSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;

    if (!Array.isArray(rec.tabs)) return null;
    const tabs = rec.tabs
      .map((tab) => normalizePersistedTab(tab))
      .filter((tab): tab is EditorTab => tab !== null);

    const uniqueTabs: EditorTab[] = [];
    const seenIds = new Set<string>();
    for (const tab of tabs) {
      if (seenIds.has(tab.id)) continue;
      seenIds.add(tab.id);
      uniqueTabs.push(tab);
    }

    if (uniqueTabs.length === 0) return null;
    const validTabIds = new Set(uniqueTabs.map((t) => t.id));

    return {
      tabs: uniqueTabs,
      activeTabId:
        typeof rec.activeTabId === "string"
          ? rec.activeTabId
          : uniqueTabs[0].id,
      bottomPanelTab: isBottomPanelTab(rec.bottomPanelTab)
        ? rec.bottomPanelTab
        : "terminal",
      workingDir: typeof rec.workingDir === "string" ? rec.workingDir : "",
      selectedPsPath:
        typeof rec.selectedPsPath === "string" ? rec.selectedPsPath : "",
      breakpoints: normalizePersistedBreakpoints(rec.breakpoints, validTabIds),
      bookmarks: normalizePersistedBookmarks(rec.bookmarks, validTabIds),
    };
  } catch {
    return null;
  }
}

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
  bottomPanelTab: BottomPanelTab;
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
  /** Per-tab debugger breakpoints (line and variable). */
  breakpoints: BreakpointMap;
  /** Per-tab bookmarked source lines. */
  bookmarks: BookmarkMap;
  /** True when a debug run is active (script started via debugger command). */
  isDebugging: boolean;
  /** True when execution is currently paused in the debugger prompt. */
  debugPaused: boolean;
  /** Current debugger stop location line (1-indexed), when known. */
  debugLine: number | null;
  /** Current debugger stop location column (1-indexed), when known. */
  debugColumn: number | null;
  /** Selected call-stack frame index (0 = current). */
  debugSelectedFrame: number;
  /** Debugger locals captured at the current pause point. */
  debugLocals: DebugLocal[];
  /** PowerShell call stack captured at the current pause point. */
  debugCallStack: DebugStackFrame[];
  /** User-defined watch expressions and their latest values/errors. */
  debugWatches: DebugWatch[];
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
  breakpoints: {},
  bookmarks: {},
  isDebugging: false,
  debugPaused: false,
  debugLine: null,
  debugColumn: null,
  debugSelectedFrame: 0,
  debugLocals: [],
  debugCallStack: [],
  debugWatches: [],
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
      tab: BottomPanelTab;
    }
  | { type: "TOGGLE_SETTINGS" }
  | { type: "OPEN_COMMAND_PALETTE"; mode?: "all" | "snippets" }
  | { type: "CLOSE_COMMAND_PALETTE" }
  | { type: "TOGGLE_COMMAND_PALETTE" }
  | { type: "TOGGLE_SHORTCUT_PANEL" }
  | { type: "SET_CURSOR_POSITION"; line: number; column: number }
  | { type: "TOGGLE_ABOUT" }
  | { type: "TOGGLE_SIGNING_DIALOG" }
  | { type: "TOGGLE_BREAKPOINT"; tabId: string; line: number }
  | { type: "SET_BREAKPOINTS"; tabId: string; breakpoints: DebugBreakpoint[] }
  | { type: "UPSERT_BREAKPOINT"; tabId: string; breakpoint: DebugBreakpoint }
  | { type: "REMOVE_BREAKPOINT"; tabId: string; breakpoint: DebugBreakpoint }
  | { type: "TOGGLE_BOOKMARK"; tabId: string; line: number }
  | { type: "SET_BOOKMARKS"; tabId: string; lines: number[] }
  | {
      type: "SET_DEBUG_STATE";
      isDebugging?: boolean;
      debugPaused?: boolean;
      debugLine?: number | null;
      debugColumn?: number | null;
    }
  | { type: "SET_DEBUG_SELECTED_FRAME"; frameIndex: number }
  | { type: "SET_DEBUG_LOCALS"; locals: DebugLocal[] }
  | { type: "SET_DEBUG_CALL_STACK"; frames: DebugStackFrame[] }
  | { type: "ADD_DEBUG_WATCH"; expression: string }
  | { type: "REMOVE_DEBUG_WATCH"; expression: string }
  | { type: "UPDATE_DEBUG_WATCH"; watch: DebugWatch }
  | { type: "CLEAR_DEBUG_INSPECTOR_VALUES" };

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
  const locRe = /At\s+(?:.+:)?(\d+)\s+char:(\d+)/i;

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
      const { [action.id]: _removed, ...restBreakpoints } = state.breakpoints;
      const { [action.id]: _removedBookmarks, ...restBookmarks } = state.bookmarks;
      return {
        ...state,
        tabs: remaining,
        activeTabId: newActive,
        breakpoints: restBreakpoints,
        bookmarks: restBookmarks,
      };
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

    case "TOGGLE_BREAKPOINT": {
      if (action.line < 1) return state;
      const existing = state.breakpoints[action.tabId] ?? [];
      const has = existing.some((bp) => bp.line === action.line);
      const breakpoints = has
        ? existing.filter((bp) => bp.line !== action.line)
        : normalizeBreakpointList([...existing, { line: action.line }]);
      const next = { ...state.breakpoints };
      if (breakpoints.length === 0) {
        delete next[action.tabId];
      } else {
        next[action.tabId] = breakpoints;
      }
      return { ...state, breakpoints: next };
    }

    case "SET_BREAKPOINTS": {
      const breakpoints = normalizeBreakpointList(action.breakpoints);
      const next = { ...state.breakpoints };
      if (breakpoints.length === 0) {
        delete next[action.tabId];
      } else {
        next[action.tabId] = breakpoints;
      }
      return { ...state, breakpoints: next };
    }

    case "UPSERT_BREAKPOINT": {
      const normalized = normalizeBreakpoint(action.breakpoint);
      if (!normalized) return state;
      const existing = state.breakpoints[action.tabId] ?? [];
      const key = breakpointKey(normalized);
      const merged = normalizeBreakpointList([
        ...existing.filter((bp) => breakpointKey(bp) !== key),
        normalized,
      ]);
      const next = { ...state.breakpoints };
      if (merged.length === 0) {
        delete next[action.tabId];
      } else {
        next[action.tabId] = merged;
      }
      return { ...state, breakpoints: next };
    }

    case "REMOVE_BREAKPOINT": {
      const normalized = normalizeBreakpoint(action.breakpoint);
      if (!normalized) return state;
      const existing = state.breakpoints[action.tabId] ?? [];
      const key = breakpointKey(normalized);
      const filtered = existing.filter((bp) => breakpointKey(bp) !== key);
      const next = { ...state.breakpoints };
      if (filtered.length === 0) {
        delete next[action.tabId];
      } else {
        next[action.tabId] = filtered;
      }
      return { ...state, breakpoints: next };
    }

    case "TOGGLE_BOOKMARK": {
      if (action.line < 1 || !Number.isInteger(action.line)) return state;
      const existing = state.bookmarks[action.tabId] ?? [];
      const has = existing.includes(action.line);
      const lines = has
        ? existing.filter((line) => line !== action.line)
        : [...existing, action.line].sort((a, b) => a - b);
      const next = { ...state.bookmarks };
      if (lines.length === 0) {
        delete next[action.tabId];
      } else {
        next[action.tabId] = lines;
      }
      return { ...state, bookmarks: next };
    }

    case "SET_BOOKMARKS": {
      const lines = normalizeBookmarkList(action.lines);
      const next = { ...state.bookmarks };
      if (lines.length === 0) {
        delete next[action.tabId];
      } else {
        next[action.tabId] = lines;
      }
      return { ...state, bookmarks: next };
    }

    case "SET_DEBUG_STATE":
      return {
        ...state,
        isDebugging: action.isDebugging ?? state.isDebugging,
        debugPaused: action.debugPaused ?? state.debugPaused,
        debugLine:
          action.debugLine !== undefined ? action.debugLine : state.debugLine,
        debugColumn:
          action.debugColumn !== undefined
            ? action.debugColumn
            : state.debugColumn,
        debugSelectedFrame:
          action.isDebugging === false ? 0 : state.debugSelectedFrame,
      };

    case "SET_DEBUG_SELECTED_FRAME":
      return {
        ...state,
        debugSelectedFrame: Math.max(0, Math.floor(action.frameIndex || 0)),
      };

    case "SET_DEBUG_LOCALS":
      return { ...state, debugLocals: action.locals };

    case "SET_DEBUG_CALL_STACK":
      return { ...state, debugCallStack: action.frames };

    case "ADD_DEBUG_WATCH": {
      const expression = action.expression.trim();
      if (!expression) return state;
      if (state.debugWatches.some((w) => w.expression === expression)) {
        return state;
      }
      return {
        ...state,
        debugWatches: [
          ...state.debugWatches,
          { expression, value: "", error: "" },
        ],
      };
    }

    case "REMOVE_DEBUG_WATCH":
      return {
        ...state,
        debugWatches: state.debugWatches.filter(
          (w) => w.expression !== action.expression,
        ),
      };

    case "UPDATE_DEBUG_WATCH": {
      const idx = state.debugWatches.findIndex(
        (w) => w.expression === action.watch.expression,
      );
      if (idx === -1) {
        return { ...state, debugWatches: [...state.debugWatches, action.watch] };
      }
      const next = [...state.debugWatches];
      next[idx] = action.watch;
      return { ...state, debugWatches: next };
    }

    case "CLEAR_DEBUG_INSPECTOR_VALUES":
      return {
        ...state,
        debugLocals: [],
        debugCallStack: [],
        debugWatches: state.debugWatches.map((w) => ({
          ...w,
          value: "",
          error: "",
        })),
      };

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

/** Seed tab/untitled counters from restored session tabs to avoid id/title collisions. */
function syncTabCounters(tabs: EditorTab[]): void {
  let maxTab = tabCounter;
  let maxUntitled = untitledNum;

  for (const tab of tabs) {
    const idMatch = /^tab-(\d+)$/i.exec(tab.id);
    if (idMatch) {
      maxTab = Math.max(maxTab, parseInt(idMatch[1], 10));
    }

    const titleMatch = /^Untitled-(\d+)$/i.exec(tab.title);
    if (titleMatch) {
      maxUntitled = Math.max(maxUntitled, parseInt(titleMatch[1], 10));
    }
  }

  tabCounter = Math.max(tabCounter, maxTab);
  untitledNum = Math.max(untitledNum, maxUntitled);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  const sessionRestoreCompleteRef = useRef(false);
  const selectedPsPathRef = useRef(state.selectedPsPath);

  useEffect(() => {
    selectedPsPathRef.current = state.selectedPsPath;
  }, [state.selectedPsPath]);

  // Restore tab/session state from localStorage.
  // File-backed tabs are restored only when the source file still exists.
  // If every saved file is gone, we fall back to a single untitled tab.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const persisted = loadPersistedSession();
      if (!persisted) {
        sessionRestoreCompleteRef.current = true;
        return;
      }

      const restoredTabs: EditorTab[] = [];
      for (const tab of persisted.tabs) {
        if (!tab.filePath) {
          restoredTabs.push(tab);
          continue;
        }
        try {
          await cmd.readFileContent(tab.filePath);
          restoredTabs.push(tab);
        } catch {
          // File no longer exists (or is unreadable) -- skip this tab.
        }
      }

      if (cancelled) return;

      const finalTabs =
        restoredTabs.length > 0 ? restoredTabs : [createUntitledTab()];
      syncTabCounters(finalTabs);

      dispatch({ type: "SET_TABS", tabs: finalTabs });
      dispatch({
        type: "SET_ACTIVE_TAB",
        id: finalTabs.some((t) => t.id === persisted.activeTabId)
          ? persisted.activeTabId
          : finalTabs[0].id,
      });
      dispatch({ type: "SET_BOTTOM_TAB", tab: persisted.bottomPanelTab });
      dispatch({ type: "SET_WORKING_DIR", dir: persisted.workingDir });
      for (const [tabId, breakpoints] of Object.entries(persisted.breakpoints)) {
        dispatch({ type: "SET_BREAKPOINTS", tabId, breakpoints });
      }
      for (const [tabId, lines] of Object.entries(persisted.bookmarks)) {
        dispatch({ type: "SET_BOOKMARKS", tabId, lines });
      }
      if (persisted.selectedPsPath) {
        dispatch({ type: "SET_SELECTED_PS", path: persisted.selectedPsPath });
      }

      sessionRestoreCompleteRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
          // Prefer a restored session shell, then fall back to persisted settings.
          const restoredPath = selectedPsPathRef.current;
          const preferredPath =
            restoredPath && versions.some((v) => v.path === restoredPath)
              ? restoredPath
              : loadedSettings.defaultPsVersion;
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

  // Keep selected shell valid when the available PowerShell list changes.
  useEffect(() => {
    if (state.psVersions.length === 0) return;
    if (state.psVersions.some((v) => v.path === state.selectedPsPath)) return;
    dispatch({ type: "SET_SELECTED_PS", path: state.psVersions[0].path });
  }, [state.psVersions, state.selectedPsPath, dispatch]);

  // Persist recoverable session state between launches.
  useEffect(() => {
    if (!sessionRestoreCompleteRef.current) return;

    const tabs = state.tabs
      .filter((tab) => tab.tabType !== "welcome")
      .map((tab) => ({ ...tab, tabType: "code" as const }));

    if (tabs.length === 0) {
      try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
      return;
    }

    const snapshot: PersistedSession = {
      tabs,
      activeTabId: tabs.some((t) => t.id === state.activeTabId)
        ? state.activeTabId
        : tabs[0].id,
      bottomPanelTab: state.bottomPanelTab,
      workingDir: state.workingDir,
      selectedPsPath: state.selectedPsPath,
      breakpoints: Object.fromEntries(
        Object.entries(state.breakpoints).filter(([tabId, lines]) => {
          return tabs.some((t) => t.id === tabId) && lines.length > 0;
        }),
      ),
      bookmarks: Object.fromEntries(
        Object.entries(state.bookmarks).filter(([tabId, lines]) => {
          return tabs.some((t) => t.id === tabId) && lines.length > 0;
        }),
      ),
    };

    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // ignore storage errors
    }
  }, [
    state.tabs,
    state.activeTabId,
    state.bottomPanelTab,
    state.workingDir,
    state.selectedPsPath,
    state.breakpoints,
    state.bookmarks,
  ]);

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
