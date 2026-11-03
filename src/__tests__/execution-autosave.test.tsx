/**
 * @vitest-environment happy-dom
 */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "../commands";
import type { Action, AppState } from "../store";
import { useExecutionActions, type ExecutionActions } from "../use-execution-actions";
import { DEFAULT_SETTINGS, type EditorTab } from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../commands", () => ({
  debugContinue: vi.fn(async () => {}),
  debugSetFrame: vi.fn(async () => {}),
  debugStepInto: vi.fn(async () => {}),
  debugStepOut: vi.fn(async () => {}),
  debugStepOver: vi.fn(async () => {}),
  deleteScratchFile: vi.fn(async () => {}),
  executeScriptDebug: vi.fn(async () => 0),
  getScriptParameters: vi.fn(async () => ({ status: "none", parameters: [] })),
  prepareTerminalScriptCommand: vi.fn(async () => "prepared-command"),
  stageTerminalRunPrep: vi.fn(async () => {}),
  readFileContent: vi.fn(async (path: string) => ({
    content: "",
    encoding: "utf8",
    path,
  })),
  saveFileContent: vi.fn(async () => null),
  sendStdin: vi.fn(async () => {}),
  stopScript: vi.fn(async () => {}),
}));

const dispatch = vi.fn<(action: Action) => void>();
const interruptTerminalCommand = vi.fn<() => void>();
const runCommandInTerminal = vi.fn<
  (
    command: string,
    options?: { clearBeforeRun?: boolean; reveal?: boolean },
  ) => Promise<number | null>
>();
const writeTerminalNotice = vi.fn<
  (text: string, options?: { reveal?: boolean }) => Promise<void>
>();
let actions: ExecutionActions | undefined;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

function codeTab(): EditorTab {
  return {
    id: "tab-code",
    title: "script.ps1",
    filePath: "C:\\Scripts\\script.ps1",
    content: "Write-Host 1",
    savedContent: "Write-Host 1",
    encoding: "utf8",
    language: "powershell",
    isDirty: false,
    tabType: "code",
  };
}

function appState(tab: EditorTab): AppState {
  return {
    tabs: [tab],
    activeTabId: tab.id,
    isRunning: false,
    psVersions: [],
    selectedPsPath: "pwsh",
    workingDir: "C:\\Workspace",
    settings: {
      ...DEFAULT_SETTINGS,
      autoSaveOnRun: false,
      clearOutputOnRun: false,
      enablePssa: false,
      pssaRunGate: "off",
    },
    settingsLoaded: true,
    scratchDir: "",
    variables: [],
    modules: [],
    modulesLoading: false,
    sidebarVisible: false,
    sidebarPosition: "left",
    bottomPanelTab: "terminal",
    referenceSubview: "problems",
    problems: {},
    lastRunResult: null,
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
}

function Harness({ state, tab, scratchDir = "" }: {
  state: AppState;
  tab: EditorTab;
  scratchDir?: string;
}) {
  const activeTabRef = useRef<EditorTab | undefined>(tab);
  const scratchDirRef = useRef(scratchDir);
  const runWorkingDirOverrideRef = useRef<string | null>(null);
  actions = useExecutionActions({
    state,
    dispatch,
    activeTab: tab,
    activeTabRef,
    scratchDirRef,
    runWorkingDirOverrideRef,
    runCommandInTerminal,
    writeTerminalNotice,
    interruptTerminalCommand,
  });
  return null;
}

async function renderHarness(state: AppState, tab: EditorTab, scratchDir = "") {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(<Harness state={state} tab={tab} scratchDir={scratchDir} />);
  });
}

function getActions(): ExecutionActions {
  if (!actions) throw new Error("Harness did not render actions.");
  return actions;
}

beforeEach(() => {
  vi.clearAllMocks();
  actions = undefined;
  vi.mocked(commands.getScriptParameters).mockResolvedValue({
    status: "none",
    parameters: [],
  });
  vi.mocked(commands.prepareTerminalScriptCommand).mockResolvedValue("prepared-command");
  vi.mocked(commands.saveFileContent).mockResolvedValue(null);
  runCommandInTerminal.mockResolvedValue(0);
  writeTerminalNotice.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe("auto-save before run", () => {
  it("runs a dirty user file from memory when auto-save is disabled", async () => {
    const tab = { ...codeTab(), isDirty: true, content: "Write-Host 'edited in memory'" };
    vi.mocked(commands.readFileContent).mockResolvedValue({
      content: tab.savedContent,
      encoding: "utf8",
      path: tab.filePath,
    });
    await renderHarness(appState(tab), tab);
    await act(async () => { await getActions().runScript(); });
    expect(commands.saveFileContent).not.toHaveBeenCalled();
    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledWith(
      expect.any(String), tab.content, expect.any(String), expect.any(String), [], tab.title,
    );
    expect(runCommandInTerminal).toHaveBeenCalledWith("prepared-command", {
      clearBeforeRun: false,
      reveal: true,
      newConsole: false,
    });
  });

  it("saves a dirty user file before direct run when auto-save is enabled", async () => {
    const tab = { ...codeTab(), isDirty: true, content: "Write-Host 'auto-saved'" };
    vi.mocked(commands.readFileContent).mockResolvedValue({
      content: tab.savedContent,
      encoding: "utf8",
      path: tab.filePath,
    });
    const state = appState(tab);
    state.settings = { ...state.settings, autoSaveOnRun: true };
    await renderHarness(state, tab);
    await act(async () => { await getActions().runScript(); });
    expect(commands.saveFileContent).toHaveBeenCalledWith(tab.filePath, tab.content, tab.encoding);
    expect(commands.prepareTerminalScriptCommand).not.toHaveBeenCalled();
    expect(runCommandInTerminal).toHaveBeenCalledWith(
      expect.stringContaining(tab.filePath),
      expect.objectContaining({ newConsole: false }),
    );
  });

  it("flushes a dirty scratch-backed tab when auto-save is disabled", async () => {
    const scratchDir = "C:\\Scratch";
    const tab = {
      ...codeTab(),
      filePath: `${scratchDir}\\tab-code.ps1`,
      title: "Untitled-1",
      isDirty: true,
      content: "Write-Host 'scratch edit'",
    };
    vi.mocked(commands.readFileContent).mockResolvedValue({
      content: tab.savedContent,
      encoding: "utf8",
      path: tab.filePath,
    });
    await renderHarness(appState(tab), tab, scratchDir);
    await act(async () => { await getActions().runScript(); });
    expect(commands.saveFileContent).toHaveBeenCalledWith(tab.filePath, tab.content, tab.encoding);
    expect(commands.prepareTerminalScriptCommand).not.toHaveBeenCalled();
  });

  it("falls back to psrun when auto-save before run fails", async () => {
    const tab = { ...codeTab(), isDirty: true, content: "Write-Host 'from buffer'" };
    vi.mocked(commands.readFileContent).mockResolvedValue({
      content: tab.savedContent,
      encoding: "utf8",
      path: tab.filePath,
    });
    vi.mocked(commands.saveFileContent).mockRejectedValue(new Error("disk full"));
    const state = appState(tab);
    state.settings = { ...state.settings, autoSaveOnRun: true };
    await renderHarness(state, tab);
    await act(async () => { await getActions().runScript(); });
    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledWith(
      expect.any(String), tab.content, expect.any(String), expect.any(String), [], tab.title,
    );
    expect(runCommandInTerminal).toHaveBeenCalledWith("prepared-command", {
      clearBeforeRun: false,
      reveal: true,
      newConsole: false,
    });
  });
});
