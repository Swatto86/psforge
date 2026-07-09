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

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../commands", () => ({
  debugContinue: vi.fn(async () => {}),
  debugSetFrame: vi.fn(async () => {}),
  debugStepInto: vi.fn(async () => {}),
  debugStepOut: vi.fn(async () => {}),
  debugStepOver: vi.fn(async () => {}),
  deleteScratchFile: vi.fn(async () => {}),
  executeScriptDebug: vi.fn(async () => 0),
  getScriptParameters: vi.fn(async () => []),
  prepareTerminalScriptCommand: vi.fn(async () => "prepared-command"),
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
  actions = undefined;
  vi.mocked(commands.getScriptParameters).mockResolvedValue([]);
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

    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledWith(
      "pwsh",
      tab.content,
      "C:\\Scripts",
      "Default",
      [],
    );
    expect(runCommandInTerminal).toHaveBeenCalledWith("prepared-command", {
      clearBeforeRun: false,
      reveal: true,
    });
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

    expect(commands.prepareTerminalScriptCommand).toHaveBeenCalledTimes(1);

    finishRun?.(0);
    await act(async () => {
      await firstRun;
      await secondRun;
    });
  });
});
