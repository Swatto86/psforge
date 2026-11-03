/** @vitest-environment happy-dom */
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as cmd from "../commands";
import type { Action, AppState } from "../store";
import { DEFAULT_SETTINGS, type EditorTab } from "../types";

let currentState: AppState;
const testDispatch = vi.fn((action: Action) => {
  if (action.type === "UPDATE_TAB") {
    currentState = {
      ...currentState,
      tabs: currentState.tabs.map((tab) =>
        tab.id === action.id ? { ...tab, ...action.changes } : tab,
      ),
    };
  } else if (action.type === "CLOSE_TAB") {
    currentState = {
      ...currentState,
      tabs: currentState.tabs.filter((tab) => tab.id !== action.id),
    };
  } else if (action.type === "SET_SCRATCH_DIR") {
    currentState = { ...currentState, scratchDir: action.dir };
  } else if (action.type === "SET_SETTINGS") {
    currentState = { ...currentState, settings: action.settings };
  }
});

vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return {
    ...actual,
    AppProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useAppState: () => ({
      state: currentState,
      dispatch: testDispatch,
      activeTab: currentState.tabs.find(
        (tab) => tab.id === currentState.activeTabId,
      ),
    }),
  };
});
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../commands", () => ({
  formatScript: vi.fn(),
  getScratchDir: vi.fn(),
  listScratchFiles: vi.fn(),
  saveFileContent: vi.fn(),
  deleteScratchFile: vi.fn(),
  getLaunchPath: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock("../use-execution-actions", () => ({
  useExecutionActions: () => ({
    paramPrompt: null,
    pssaGatePrompt: null,
    saveTab: vi.fn(async () => ({ saved: false })),
    saveCurrentFile: vi.fn(),
    saveAllFiles: vi.fn(),
    runScript: vi.fn(),
    startDebugSession: vi.fn(),
    runOrDebugScript: vi.fn(),
    runSelection: vi.fn(),
    stopExecution: vi.fn(),
    debugContinue: vi.fn(),
    debugStepOver: vi.fn(),
    debugStepInto: vi.fn(),
    debugStepOut: vi.fn(),
    evaluateDebugWatch: vi.fn(),
    refreshDebugInspector: vi.fn(),
    selectDebugFrame: vi.fn(),
  }),
}));
vi.mock("../use-clipboard-script", () => ({ useClipboardScript: () => vi.fn() }));
vi.mock("../use-app-updates", () => ({
  useAppUpdates: () => ({ updateStatus: null, checkForUpdates: vi.fn() }),
}));
vi.mock("../use-editor-diagnostics", () => ({ useEditorDiagnostics: vi.fn() }));
vi.mock("../components/PssaInstallControls", () => ({ usePssaAutoInstall: vi.fn() }));
vi.mock("../components/Toolbar", () => ({
  Toolbar: (props: { onFormat: () => void; onPasteScript: () => void }) => (
    <>
      <button data-testid="test-format" onClick={props.onFormat}>Format</button>
      <button data-testid="test-paste" onClick={props.onPasteScript}>Paste</button>
    </>
  ),
}));
vi.mock("../components/TabBar", () => ({ TabBar: () => null }));
vi.mock("../components/EditorPane", () => ({ EditorPane: () => null }));
vi.mock("../components/OutputPane", () => ({ OutputPane: () => null }));
vi.mock("../components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../components/StatusBar", () => ({ StatusBar: () => null }));
vi.mock("../components/SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("../components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../components/KeyboardShortcutPanel", () => ({ KeyboardShortcutPanel: () => null }));
vi.mock("../components/AboutDialog", () => ({ AboutDialog: () => null }));
vi.mock("../components/ScriptSigningDialog", () => ({ ScriptSigningDialog: () => null }));
vi.mock("../components/ParamPromptDialog", () => ({ ParamPromptDialog: () => null }));
vi.mock("../components/PssaRunGateDialog", () => ({ PssaRunGateDialog: () => null }));
vi.mock("../components/ScratchRecoveryDialog", () => ({ ScratchRecoveryDialog: () => null }));
vi.mock("../components/CloseScratchDialog", () => ({
  CloseScratchDialog: (props: { onChoice: (choice: "discard") => void }) => (
    <button data-testid="test-discard" onClick={() => props.onChoice("discard")}>
      Discard
    </button>
  ),
}));
vi.mock("../components/ToastStack", () => ({
  ToastStack: () => null,
  showAppToast: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function codeTab(id: string, content: string, filePath = ""): EditorTab {
  return {
    id,
    title: id,
    filePath,
    content,
    savedContent: content,
    encoding: "utf8",
    language: "powershell",
    isDirty: true,
    tabType: "code",
  };
}

function makeState(tabs: EditorTab[]): AppState {
  return {
    tabs,
    activeTabId: tabs[0]?.id ?? "",
    isRunning: false,
    psVersions: [],
    selectedPsPath: "pwsh-a",
    workingDir: "",
    settings: {
      ...DEFAULT_SETTINGS,
      enablePssa: false,
      autoInstallPssa: false,
      checkForUpdatesOnStartup: false,
      runAfterPasteCleanFormat: false,
      autoSaveScratchScripts: true,
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

let root: Root;
let container: HTMLDivElement;

async function renderApp() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function rerenderApp() {
  await act(async () => root.render(<App />));
}

beforeEach(() => {
  testDispatch.mockClear();
  vi.mocked(readText).mockResolvedValue("Write-Host pasted");
  vi.mocked(cmd.getScratchDir).mockResolvedValue("/scratch");
  vi.mocked(cmd.listScratchFiles).mockResolvedValue([]);
  vi.mocked(cmd.getLaunchPath).mockResolvedValue(null);
  vi.mocked(cmd.saveSettings).mockResolvedValue();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  const w = window as unknown as Record<string, unknown>;
  delete w.__psforge_insertTextAtSelection;
  delete w.__psforge_getEditorText;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("editor formatting races", () => {
  it("does not replace newer edits when Format Document completes", async () => {
    currentState = makeState([codeTab("script", "before", "/script.ps1")]);
    const pending = deferred<string>();
    vi.mocked(cmd.formatScript).mockReturnValue(pending.promise);
    await renderApp();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=test-format]")?.click();
      await Promise.resolve();
    });
    expect(cmd.formatScript).toHaveBeenCalledWith("pwsh-a", "before");

    currentState = {
      ...currentState,
      tabs: [{ ...currentState.tabs[0]!, content: "newer edit", isDirty: true }],
    };
    await rerenderApp();
    await act(async () => {
      pending.resolve("formatted old");
      await pending.promise;
      await Promise.resolve();
    });

    expect(currentState.tabs[0]?.content).toBe("newer edit");
  });

  it("does not replace newer edits when Paste Clean + Format completes", async () => {
    currentState = makeState([codeTab("script", "before", "/script.ps1")]);
    const pending = deferred<string>();
    vi.mocked(cmd.formatScript).mockReturnValue(pending.promise);
    const submitted = "before\nWrite-Host pasted";
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_insertTextAtSelection = vi.fn(() => true);
    w.__psforge_getEditorText = vi.fn(() => submitted);
    await renderApp();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=test-paste]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(cmd.formatScript).toHaveBeenCalledWith("pwsh-a", submitted);

    currentState = {
      ...currentState,
      tabs: [{ ...currentState.tabs[0]!, content: "newer after paste", isDirty: true }],
    };
    await rerenderApp();
    await act(async () => {
      pending.resolve("formatted pasted buffer");
      await pending.promise;
      await Promise.resolve();
    });

    expect(currentState.tabs[0]?.content).toBe("newer after paste");
  });
});

describe("scratch close races", () => {
  it("makes discard deletion final after an in-flight scratch save", async () => {
    currentState = makeState([
      codeTab("scratch", "unsaved"),
      { ...codeTab("other", "saved", "/other.ps1"), isDirty: false },
    ]);
    const pending = deferred<string | null>();
    const files = new Set<string>();
    const operations: string[] = [];
    vi.mocked(cmd.saveFileContent).mockImplementation((path) => {
      operations.push("save-started");
      return pending.promise.then(() => {
        operations.push("save-finished");
        files.add(path);
        return null;
      });
    });
    vi.mocked(cmd.deleteScratchFile).mockImplementation(async (path) => {
      operations.push("delete");
      files.delete(path);
    });
    await renderApp();
    expect(currentState.scratchDir).toBe("/scratch");
    currentState = { ...currentState, tabs: [...currentState.tabs] };
    await rerenderApp();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1250));
    });
    expect(cmd.saveFileContent).toHaveBeenCalledWith(
      "/scratch/scratch.ps1",
      "unsaved",
      "utf8",
    );

    const w = window as unknown as Record<string, unknown>;
    const requestClose = w.__psforge_requestCloseTab as (
      id: string,
    ) => Promise<boolean>;
    let closing!: Promise<boolean>;
    await act(async () => {
      closing = requestClose("scratch");
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=test-discard]")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      pending.resolve(null);
      await closing;
    });

    expect(operations).toEqual(["save-started", "save-finished", "delete"]);
    expect(files.has("/scratch/scratch.ps1")).toBe(false);
    expect(currentState.tabs.map((tab) => tab.id)).toEqual(["other"]);
    expect(
      testDispatch.mock.calls.some(([action]) => action.type === "UPDATE_TAB"),
    ).toBe(false);
  });
});
