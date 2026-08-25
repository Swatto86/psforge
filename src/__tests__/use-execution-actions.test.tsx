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

type ListenHandler = (event: { payload: unknown }) => void;
const listenHandlers = new Map<string, ListenHandler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: ListenHandler) => {
    listenHandlers.set(event, handler);
    return () => {
      listenHandlers.delete(event);
    };
  }),
}));

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
  saveFileContent: vi.fn(async () => undefined),
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

function codeTab(id = "tab-code"): EditorTab {
  return {
    id,
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

const welcomeTab: EditorTab = {
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

function appState(tabs: EditorTab[], activeTabId: string): AppState {
  return {
    tabs,
    activeTabId,
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

function Harness({
  state,
  activeTab,
}: {
  state: AppState;
  activeTab: EditorTab | undefined;
}) {
  const activeTabRef = useRef<EditorTab | undefined>(activeTab);
  const scratchDirRef = useRef("");
  const runWorkingDirOverrideRef = useRef<string | null>(null);
  actions = useExecutionActions({
    state,
    dispatch,
    activeTab,
    activeTabRef,
    scratchDirRef,
    runWorkingDirOverrideRef,
    runCommandInTerminal,
    writeTerminalNotice,
    interruptTerminalCommand,
  });
  return null;
}

async function renderHarness(state: AppState, activeTab: EditorTab | undefined) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  await act(async () => {
    root!.render(<Harness state={state} activeTab={activeTab} />);
  });
}

async function flushPromises() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function getActions(): ExecutionActions {
  if (!actions) throw new Error("Harness did not render actions.");
  return actions;
}

beforeEach(() => {
  vi.clearAllMocks();
  listenHandlers.clear();
  actions = undefined;
  vi.mocked(commands.getScriptParameters).mockResolvedValue({
    status: "none",
    parameters: [],
  });
  vi.mocked(commands.prepareTerminalScriptCommand).mockResolvedValue(
    "prepared-command",
  );
  runCommandInTerminal.mockResolvedValue(0);
  writeTerminalNotice.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  root = undefined;
  container?.remove();
  container = undefined;
});

describe("useExecutionActions", () => {
  it("runs the latest active tab when an old run handler fires", async () => {
    const tab = codeTab();
    await renderHarness(appState([welcomeTab, tab], welcomeTab.id), welcomeTab);
    const staleRun = getActions().runOrDebugScript;

    await renderHarness(appState([welcomeTab, tab], tab.id), tab);
    await act(async () => {
      staleRun();
      await flushPromises();
    });

    expect(commands.getScriptParameters).not.toHaveBeenCalled();
    expect(commands.prepareTerminalScriptCommand).not.toHaveBeenCalled();
    expect(commands.stageTerminalRunPrep).toHaveBeenCalledWith(
      "C:\\Scripts",
      "Default",
    );
    expect(runCommandInTerminal).toHaveBeenCalledWith(
      "& 'C:\\Scripts\\script.ps1'",
      {
        clearBeforeRun: false,
        reveal: true,
      },
    );
  });

  it("guards rapid duplicate run calls before React state updates", async () => {
    const tab = codeTab();
    let finishRun: ((exitCode: number | null) => void) | undefined;
    runCommandInTerminal.mockImplementation(
      () =>
        new Promise<number | null>((resolve) => {
          finishRun = resolve;
        }),
    );

    await renderHarness(appState([tab], tab.id), tab);
    let firstRun!: Promise<void>;
    let secondRun!: Promise<void>;
    await act(async () => {
      firstRun = getActions().runScript();
      secondRun = getActions().runScript();
      await flushPromises();
    });

    expect(commands.prepareTerminalScriptCommand).not.toHaveBeenCalled();
    expect(runCommandInTerminal).toHaveBeenCalledTimes(1);

    finishRun?.(0);
    await act(async () => {
      await firstRun;
      await secondRun;
    });
  });

  it("records last-run result after a debug session completes", async () => {
    const tab = codeTab();
    vi.mocked(commands.executeScriptDebug).mockResolvedValue(7);

    await renderHarness(appState([tab], tab.id), tab);
    await act(async () => {
      await getActions().startDebugSession();
      await flushPromises();
    });

    expect(commands.executeScriptDebug).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_LAST_RUN_RESULT",
      result: expect.objectContaining({ exitCode: 7 }),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_RUNNING",
      running: false,
    });
  });

  it("keeps pause refs across re-render so continue still sends (S6-14 class)", async () => {
    const tab = codeTab();
    let resolveDebug: ((code: number) => void) | undefined;
    vi.mocked(commands.executeScriptDebug).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveDebug = resolve;
        }),
    );

    await renderHarness(appState([tab], tab.id), tab);
    await act(async () => {
      void getActions().startDebugSession();
      await flushPromises();
    });

    const breakHandler = listenHandlers.get("ps-debug-break");
    expect(breakHandler).toBeTypeOf("function");
    await act(async () => {
      breakHandler!({ payload: 12 });
    });

    // Unrelated re-render with pre-break state (isDebugging/debugPaused still
    // false in React state). Old code mirrored state onto the live refs and
    // wiped the pause latch, making continue a silent no-op.
    await renderHarness(appState([tab], tab.id), tab);

    await act(async () => {
      await getActions().debugContinue();
      await flushPromises();
    });

    expect(commands.debugContinue).toHaveBeenCalledTimes(1);
    resolveDebug?.(0);
    await act(async () => {
      await flushPromises();
    });
  });

  it("does not fall back from a pinned invalid working dir on selection run", async () => {
    const tab = codeTab();
    const err = Object.assign(new Error("missing dir"), {
      code: "INVALID_WORKING_DIR",
    });
    vi.mocked(commands.prepareTerminalScriptCommand).mockRejectedValue(err);
    (window as unknown as Record<string, unknown>).__psforge_getRunText = () =>
      "Write-Host sel";

    const state = appState([tab], tab.id);
    state.settings = {
      ...state.settings,
      workingDirMode: "pinned",
      pinnedRunDir: "C:\\MissingPin",
    };

    await renderHarness(state, tab);
    await act(async () => {
      await getActions().runSelection();
      await flushPromises();
    });

    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledTimes(1);
    expect(writeTerminalNotice).toHaveBeenCalledWith(
      expect.stringContaining("Selection run failed"),
      expect.anything(),
    );
  });

  it("surfaces save failures in the terminal instead of only console.error", async () => {
    const tab = codeTab();
    vi.mocked(commands.readFileContent).mockResolvedValue({
      content: tab.savedContent,
      encoding: "utf8",
      path: tab.filePath,
    });
    vi.mocked(commands.saveFileContent).mockRejectedValue(
      new Error("disk full"),
    );

    await renderHarness(appState([tab], tab.id), tab);
    let result!: { saved: boolean; cancelled: boolean };
    await act(async () => {
      result = await getActions().saveTab(tab);
      await flushPromises();
    });

    expect(result).toEqual({ saved: false, cancelled: false });
    expect(writeTerminalNotice).toHaveBeenCalledWith(
      expect.stringContaining("Save failed"),
      expect.objectContaining({ reveal: true }),
    );
  });

  it("selects debug frames using live pause refs after re-render", async () => {
    const tab = codeTab();
    let resolveDebug: ((code: number) => void) | undefined;
    vi.mocked(commands.executeScriptDebug).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveDebug = resolve;
        }),
    );

    await renderHarness(appState([tab], tab.id), tab);
    await act(async () => {
      void getActions().startDebugSession();
      await flushPromises();
    });

    const breakHandler = listenHandlers.get("ps-debug-break");
    expect(breakHandler).toBeTypeOf("function");
    await act(async () => {
      breakHandler!({ payload: 5 });
    });

    // Re-render with stale React state (isDebugging/debugPaused still false).
    await renderHarness(appState([tab], tab.id), tab);

    await act(async () => {
      await getActions().selectDebugFrame(1);
      await flushPromises();
    });

    expect(commands.debugSetFrame).toHaveBeenCalledWith(1);
    expect(commands.sendStdin).toHaveBeenCalled();
    resolveDebug?.(0);
    await act(async () => {
      await flushPromises();
    });
  });

  it("keeps untitled scripts on the temp wrapper path", async () => {
    const tab = codeTab();
    tab.filePath = "";
    tab.title = "Untitled-1";
    await renderHarness(appState([tab], tab.id), tab);
    await act(async () => {
      await getActions().runScript();
      await flushPromises();
    });
    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledTimes(1);
    expect(runCommandInTerminal).toHaveBeenCalledWith("prepared-command", {
      clearBeforeRun: false,
      reveal: true,
    });
  });

  it("falls back to psrun when auto-save before run fails", async () => {
    const tab = codeTab();
    tab.isDirty = true;
    tab.content = "Write-Host 'from buffer'";
    vi.mocked(commands.saveFileContent).mockRejectedValue(new Error("disk full"));

    await renderHarness(appState([tab], tab.id), tab);
    await act(async () => {
      await getActions().runScript();
      await flushPromises();
    });

    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledTimes(1);
    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledWith(
      expect.any(String),
      "Write-Host 'from buffer'",
      expect.any(String),
      expect.any(String),
      [],
      tab.title,
    );
    expect(runCommandInTerminal).toHaveBeenCalledWith("prepared-command", {
      clearBeforeRun: false,
      reveal: true,
    });
  });
});
