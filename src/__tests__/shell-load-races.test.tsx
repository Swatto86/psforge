/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShowCommandPane } from "../components/ShowCommandPane";
import { Sidebar } from "../components/Sidebar";
import * as cmd from "../commands";
import type { Action, AppState } from "../store";
import {
  DEFAULT_SETTINGS,
  type CommandInfo,
  type ModuleInfo,
} from "../types";

let currentState: AppState;
const testDispatch = vi.fn((action: Action) => {
  if (action.type === "SET_MODULES") {
    currentState = { ...currentState, modules: action.modules };
  } else if (action.type === "SET_MODULES_LOADING") {
    currentState = { ...currentState, modulesLoading: action.loading };
  }
});

vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return {
    ...actual,
    useAppState: () => ({
      state: currentState,
      dispatch: testDispatch,
      activeTab: currentState.tabs.find(
        (tab) => tab.id === currentState.activeTabId,
      ),
    }),
  };
});
vi.mock("../commands", () => ({
  getInstalledModules: vi.fn(),
  getModuleCommands: vi.fn(),
  getCommandParameters: vi.fn(),
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

function moduleInfo(name: string): ModuleInfo {
  return { name, version: "1.0", moduleType: "Script", path: `/${name}` };
}

function commandInfo(name: string): CommandInfo {
  return { name, commandType: "Function" };
}

function makeState(): AppState {
  return {
    tabs: [{
      id: "script",
      title: "script.ps1",
      filePath: "/script.ps1",
      content: "function Test-Script {}",
      savedContent: "function Test-Script {}",
      encoding: "utf8",
      language: "powershell",
      isDirty: false,
      tabType: "code",
    }],
    activeTabId: "script",
    isRunning: false,
    psVersions: [],
    selectedPsPath: "host-a",
    workingDir: "",
    settings: DEFAULT_SETTINGS,
    settingsLoaded: true,
    scratchDir: "",
    variables: [],
    modules: [],
    modulesLoading: false,
    sidebarVisible: true,
    sidebarPosition: "left",
    bottomPanelTab: "terminal",
    referenceSubview: "show-command",
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

async function renderShowCommand() {
  await act(async () => root.render(<ShowCommandPane />));
}

async function renderSidebar() {
  await act(async () => root.render(<Sidebar />));
}

async function selectShell(path: string, modules: ModuleInfo[] = []) {
  currentState = {
    ...currentState,
    selectedPsPath: path,
    modules,
    modulesLoading: false,
  };
}

function dispatchedModules() {
  return testDispatch.mock.calls
    .map(([action]) => action)
    .filter((action) => action.type === "SET_MODULES")
    .flatMap((action) => action.modules.map((module) => module.name));
}

beforeEach(() => {
  currentState = makeState();
  testDispatch.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Show Command shell lifetime", () => {
  it("does not apply host A modules after host B has loaded", async () => {
    const a = deferred<ModuleInfo[]>();
    const b = deferred<ModuleInfo[]>();
    vi.mocked(cmd.getInstalledModules).mockImplementation((path) =>
      path === "host-a" ? a.promise : b.promise,
    );
    await renderShowCommand();
    await selectShell("host-b");
    await renderShowCommand();

    await act(async () => {
      b.resolve([moduleInfo("Module B")]);
      await b.promise;
    });
    await act(async () => {
      a.resolve([moduleInfo("Module A")]);
      await a.promise;
      await Promise.resolve();
    });

    expect(dispatchedModules()).toEqual(["Module B"]);
  });

  it("ignores host A error and finally while host B is still loading", async () => {
    const a = deferred<ModuleInfo[]>();
    const b = deferred<ModuleInfo[]>();
    vi.mocked(cmd.getInstalledModules).mockImplementation((path) =>
      path === "host-a" ? a.promise : b.promise,
    );
    await renderShowCommand();
    await selectShell("host-b");
    await renderShowCommand();
    testDispatch.mockClear();

    await act(async () => {
      a.reject(new Error("host A failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const errorText = container.textContent;
    const loadingActions = testDispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "SET_MODULES_LOADING")
      .map((action) => action.loading);
    await act(async () => {
      b.resolve([moduleInfo("Module B")]);
      await b.promise;
    });

    expect(errorText).not.toContain("host A failed");
    expect(loadingActions).not.toContain(false);
  });
});

describe("Sidebar shell lifetime", () => {
  it("does not apply host A modules after host B has loaded", async () => {
    const a = deferred<ModuleInfo[]>();
    const b = deferred<ModuleInfo[]>();
    vi.mocked(cmd.getInstalledModules).mockImplementation((path) =>
      path === "host-a" ? a.promise : b.promise,
    );
    await renderSidebar();
    await selectShell("host-b");
    await renderSidebar();
    testDispatch.mockClear();

    await act(async () => {
      b.resolve([moduleInfo("Module B")]);
      await b.promise;
    });
    await act(async () => {
      a.resolve([moduleInfo("Module A")]);
      await a.promise;
      await Promise.resolve();
    });

    expect(dispatchedModules()).toEqual(["Module B"]);
  });

  it("invalidates a hidden in-flight load when Outline is selected", async () => {
    const a = deferred<ModuleInfo[]>();
    vi.mocked(cmd.getInstalledModules).mockReturnValue(a.promise);
    await renderSidebar();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=sidebar-view-outline]")?.click();
    });
    await selectShell("host-b");
    await renderSidebar();
    testDispatch.mockClear();

    await act(async () => {
      a.resolve([moduleInfo("Module A")]);
      await a.promise;
      await Promise.resolve();
    });

    expect(dispatchedModules()).toEqual([]);
    expect(
      testDispatch.mock.calls.some(
        ([action]) => action.type === "SET_MODULES_LOADING",
      ),
    ).toBe(false);
  });

  it("scopes expanded-module commands to the shell that requested them", async () => {
    const a = deferred<CommandInfo[]>();
    const b = deferred<CommandInfo[]>();
    vi.mocked(cmd.getModuleCommands).mockImplementation((path) =>
      path === "host-a" ? a.promise : b.promise,
    );
    vi.mocked(cmd.getInstalledModules).mockResolvedValue([moduleInfo("Shared")]);
    currentState = { ...currentState, modules: [moduleInfo("Shared")] };
    await renderSidebar();
    await act(async () => {
      container.querySelector<HTMLElement>("span[title=Shared]")?.parentElement?.click();
    });
    expect(cmd.getModuleCommands).toHaveBeenCalledWith("host-a", "Shared");

    await selectShell("host-b", [moduleInfo("Shared")]);
    await renderSidebar();
    currentState = { ...currentState, modules: [moduleInfo("Shared")] };
    await renderSidebar();
    await act(async () => {
      container.querySelector<HTMLElement>("span[title=Shared]")?.parentElement?.click();
    });
    expect(cmd.getModuleCommands).toHaveBeenCalledWith("host-b", "Shared");

    await act(async () => {
      b.resolve([commandInfo("Get-B")]);
      await b.promise;
    });
    await act(async () => {
      a.resolve([commandInfo("Get-A")]);
      await a.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Get-B");
    expect(container.textContent).not.toContain("Get-A");
  });
});
