/**
 * @vitest-environment happy-dom
 */
import { act, type Dispatch, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import * as cmd from "../commands";
import { SettingsPanel } from "../components/SettingsPanel";
import { StatusBar } from "../components/StatusBar";
import { AppProvider, useAppState, type Action, type AppState } from "../store";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type EditorTab,
  type ScriptRunRecord,
} from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;
let closeHandler: CloseHandler | undefined;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async (handler: CloseHandler) => {
      closeHandler = handler;
      return () => {
        closeHandler = undefined;
      };
    }),
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../commands", () => ({
  getPsVersions: vi.fn(),
  loadSettings: vi.fn(),
  readFileContent: vi.fn(),
  saveSettings: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface LatestContext {
  state: AppState;
  dispatch: Dispatch<Action>;
}

let latest: LatestContext | undefined;
let root: Root;
let container: HTMLDivElement;

function Harness() {
  latest = useAppState();
  return null;
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settlePromises() {
  for (let i = 0; i < 5; i++) await flushPromises();
}

async function render(children: ReactNode) {
  await act(async () => {
    root.render(
      <AppProvider>
        <Harness />
        {children}
      </AppProvider>,
    );
  });
  for (let i = 0; i < 8 && (!latest?.state.settingsLoaded || !closeHandler); i++) {
    await flushPromises();
  }
  expect(latest?.state.settingsLoaded).toBe(true);
  expect(closeHandler).toBeDefined();
}

async function dispatch(action: Action) {
  await act(async () => {
    latest!.dispatch(action);
  });
  await flushPromises();
}

async function advanceDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  await settlePromises();
}

function element(selector: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

function browseButton(): HTMLElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Browse…",
  );
  if (!found) throw new Error("Missing directory Browse button");
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
  await flushPromises();
}

async function flushInitialSettingsSave() {
  await advanceDebounce();
  vi.mocked(cmd.saveSettings).mockClear();
}

const runRecord: ScriptRunRecord = {
  scriptPath: "C:\\Scripts\\during-dialog.ps1",
  tabTitle: "during-dialog.ps1",
  exitCode: 0,
  durationMs: 25,
  runAt: "2026-11-03T22:00:00.000Z",
  workingDir: "C:\\Scripts",
};

async function changeStateWhileDialogIsOpen() {
  await dispatch({ type: "APPEND_RUN_RECORD", record: runRecord });
  await dispatch({
    type: "SET_SETTINGS",
    settings: { ...latest!.state.settings, fontSize: 22 },
  });
}

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  localStorage.clear();
  localStorage.setItem("psforge.welcomed", "1");
  latest = undefined;
  closeHandler = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(cmd.loadSettings).mockResolvedValue({ ...DEFAULT_SETTINGS });
  vi.mocked(cmd.getPsVersions).mockResolvedValue([]);
  vi.mocked(cmd.readFileContent).mockResolvedValue({
    content: "",
    encoding: "utf8",
    path: "",
  });
  vi.mocked(cmd.saveSettings).mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("directory pickers preserve current settings", () => {
  it("SettingsPanel applies only the selected directory after the dialog resolves", async () => {
    const selection = deferred<string | null>();
    vi.mocked(open).mockReturnValue(selection.promise);
    await render(<SettingsPanel />);
    await click(element('[data-testid="settings-nav-rundir"]'));
    await click(element('input[name="workingDirMode"][value="pinned"]'));
    await click(browseButton());
    expect(open).toHaveBeenCalledTimes(1);

    await changeStateWhileDialogIsOpen();
    await act(async () => {
      selection.resolve("C:\\Chosen\\Settings");
      await selection.promise;
    });
    await settlePromises();

    expect(latest!.state.settings.pinnedRunDir).toBe("C:\\Chosen\\Settings");
    expect(latest!.state.settings.fontSize).toBe(22);
    expect(latest!.state.settings.recentRuns).toEqual([runRecord]);
  });

  it("StatusBar applies only its run-directory patch after the dialog resolves", async () => {
    const selection = deferred<string | null>();
    vi.mocked(open).mockReturnValue(selection.promise);
    await render(
      <StatusBar
        updateStatus={{ phase: "idle" }}
        onCheckForUpdates={vi.fn()}
        onInstallUpdate={vi.fn()}
      />,
    );
    await dispatch({ type: "ADD_TAB", tab: codeTab() });
    await click(element('[data-testid="status-run-cwd"]'));
    await click(element('[data-testid="run-dir-browse"]'));
    expect(open).toHaveBeenCalledTimes(1);

    await changeStateWhileDialogIsOpen();
    await act(async () => {
      selection.resolve("C:\\Chosen\\Status");
      await selection.promise;
    });
    await settlePromises();

    expect(latest!.state.settings.workingDirMode).toBe("pinned");
    expect(latest!.state.settings.pinnedRunDir).toBe("C:\\Chosen\\Status");
    expect(latest!.state.settings.fontSize).toBe(22);
    expect(latest!.state.settings.recentRuns).toEqual([runRecord]);
  });
});

describe("settings persistence ordering", () => {
  function deferSaves() {
    const saves: { settings: AppSettings; finish: () => void }[] = [];
    let disk: AppSettings | undefined;
    vi.mocked(cmd.saveSettings).mockImplementation((settings) => {
      const write = deferred<void>();
      saves.push({ settings, finish: () => write.resolve() });
      return write.promise.then(() => {
        disk = settings;
      });
    });
    return { saves, disk: () => disk };
  }

  it("keeps newest snapshot B on disk when old save A would finish last", async () => {
    await render(null);
    await flushInitialSettingsSave();
    const { saves, disk } = deferSaves();
    const settingsA = { ...latest!.state.settings, fontSize: 16 };
    const settingsB = { ...settingsA, fontSize: 17 };

    await dispatch({ type: "SET_SETTINGS", settings: settingsA });
    await advanceDebounce();
    expect(saves.map((save) => save.settings.fontSize)).toEqual([16]);
    await dispatch({ type: "SET_SETTINGS", settings: settingsB });
    await advanceDebounce();

    if (saves.length === 2) {
      // Reproduce the original race: B completes before A, leaving A on disk.
      saves[1]!.finish();
      await settlePromises();
      saves[0]!.finish();
      await settlePromises();
    } else {
      // Serialized writes start B only after A; the final result must still be B.
      saves[0]!.finish();
      await settlePromises();
      expect(saves.map((save) => save.settings.fontSize)).toEqual([16, 17]);
      saves[1]!.finish();
      await settlePromises();
    }

    expect(disk()).toEqual(settingsB);
  });

  it("close waits for an active write and leaves the newest snapshot on disk", async () => {
    await render(null);
    await flushInitialSettingsSave();
    const { saves, disk } = deferSaves();
    const settingsA = { ...latest!.state.settings, fontSize: 16 };
    const settingsB = { ...settingsA, fontSize: 17 };

    await dispatch({ type: "SET_SETTINGS", settings: settingsA });
    await advanceDebounce();
    await dispatch({ type: "SET_SETTINGS", settings: settingsB });
    let closed = false;
    const closing = closeHandler!({ preventDefault: vi.fn() }).then(() => {
      closed = true;
    });
    await settlePromises();

    let closeFinishedBeforeA = false;
    if (saves.length === 2) {
      // Original close flush: B finishes, close resolves, then stale A wins.
      saves[1]!.finish();
      await settlePromises();
      closeFinishedBeforeA = closed;
      saves[0]!.finish();
    } else {
      // Shared queue: close remains pending while A finishes, then writes B.
      closeFinishedBeforeA = closed;
      saves[0]!.finish();
      await settlePromises();
      expect(saves.map((save) => save.settings.fontSize)).toEqual([16, 17]);
      saves[1]!.finish();
    }
    await settlePromises();
    await closing;

    expect(disk()).toEqual(settingsB);
    expect(closeFinishedBeforeA).toBe(false);
  });
});
