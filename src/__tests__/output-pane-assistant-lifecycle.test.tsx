/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputPane } from "../components/OutputPane";
import { askAi } from "../commands";
import type { Action, AppState } from "../store";
import { DEFAULT_SETTINGS } from "../types";

let currentState: AppState;
const testDispatch = vi.fn((action: Action) => {
  if (action.type === "SET_BOTTOM_TAB") {
    currentState = { ...currentState, bottomPanelTab: action.tab };
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
vi.mock("../commands", () => ({ askAi: vi.fn(), sendStdin: vi.fn() }));
vi.mock("../components/AiProviderBar", () => ({ AiProviderBar: () => null }));
vi.mock("../components/TerminalPane", () => ({
  TerminalPane: () => <div data-testid="terminal-stub" />,
}));
vi.mock("../components/ShowCommandPane", () => ({ ShowCommandPane: () => null }));
vi.mock("../components/HelpPane", () => ({ HelpPane: () => null }));
vi.mock("../components/ReferencePane", () => ({ ReferencePane: () => null }));
vi.mock("../components/ProblemsPane", () => ({ ProblemsPane: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeState(): AppState {
  return {
    tabs: [{
      id: "script",
      title: "script.ps1",
      filePath: "/script.ps1",
      content: "Write-Host test",
      savedContent: "Write-Host test",
      encoding: "utf8",
      language: "powershell",
      isDirty: false,
      tabType: "code",
    }],
    activeTabId: "script",
    isRunning: false,
    psVersions: [],
    selectedPsPath: "pwsh",
    workingDir: "",
    settings: { ...DEFAULT_SETTINGS, disableAi: false },
    settingsLoaded: true,
    scratchDir: "",
    variables: [],
    modules: [],
    modulesLoading: false,
    sidebarVisible: false,
    sidebarPosition: "left",
    bottomPanelTab: "assistant",
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
const props = {
  onDebugStart: vi.fn(),
  onDebugContinue: vi.fn(),
  onDebugStepOver: vi.fn(),
  onDebugStepInto: vi.fn(),
  onDebugStepOut: vi.fn(),
  onDebugSelectFrame: vi.fn(),
  onDebugRefreshInspector: vi.fn(),
  onDebugEvaluateWatch: vi.fn(),
  onStop: vi.fn(),
};

async function renderPane() {
  await act(async () => root.render(<OutputPane {...props} />));
}

beforeEach(async () => {
  currentState = makeState();
  testDispatch.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await renderPane();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Assistant bottom-tab lifecycle", () => {
  it("keeps an in-flight response alive and accessibly hides the pane", async () => {
    const pending = deferred<{
      answer: string;
      provider: string;
      model: string;
    }>();
    vi.mocked(askAi).mockReturnValue(pending.promise);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue?.call(textarea, "Why did this fail?");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(askAi).toHaveBeenCalledOnce();

    currentState = { ...currentState, bottomPanelTab: "terminal" };
    await renderPane();
    const hiddenPanel = container.querySelector<HTMLElement>(
      "[data-testid=assistant-panel]",
    );
    const hiddenState = hiddenPanel
      ? { hidden: hiddenPanel.hidden, display: hiddenPanel.style.display }
      : null;

    await act(async () => {
      pending.resolve({ answer: "late answer", provider: "test", model: "model" });
      await pending.promise;
      await Promise.resolve();
    });
    currentState = { ...currentState, bottomPanelTab: "assistant" };
    await renderPane();

    expect(container.textContent).toContain("late answer");
    expect(hiddenState).toEqual({ hidden: true, display: "none" });
    expect(
      container.querySelector<HTMLElement>("[data-testid=assistant-panel]")?.hidden,
    ).toBe(false);
  });
});
