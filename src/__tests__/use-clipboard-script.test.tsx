/** @vitest-environment happy-dom */
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useClipboardScript } from "../use-clipboard-script";
import type { AppState } from "../store";
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn() }));
vi.mock("../commands", () => ({ formatScript: vi.fn(async (_host, script) => script) }));
vi.mock("../components/ToastStack", () => ({ showAppToast: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("waits for the pasted tab to commit instead of running the previous script on a timer", async () => {
  vi.useFakeTimers();
  vi.mocked(readText).mockResolvedValue("Write-Host fresh");
  const element = document.createElement("div");
  const root = createRoot(element);
  const dispatch = vi.fn();
  const run = vi.fn(async () => {});
  const notice = vi.fn(async () => {});
  let paste!: ReturnType<typeof useClipboardScript>;
  let state = { selectedPsPath: "pwsh", tabs: [], activeTabId: "old", isRunning: false, settings: { runAfterPasteCleanFormat: true } } as unknown as AppState;
  function Harness() {
    paste = useClipboardScript({ state, dispatch, writeTerminalNotice: notice, runScript: run });
    return null;
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => { await paste(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(run).not.toHaveBeenCalled();
    const tab = dispatch.mock.calls.find(([action]) => action.type === "ADD_TAB")![0].tab;
    state = { ...state, tabs: [tab], activeTabId: tab.id };
    await act(async () => root.render(<Harness />));
    expect(run).toHaveBeenCalledExactlyOnceWith({ newConsole: true });
    vi.mocked(readText).mockResolvedValue("Write-Host second");
    await act(async () => { await paste(); });
    const additions = dispatch.mock.calls.filter(([action]) => action.type === "ADD_TAB");
    expect(additions).toHaveLength(2);
    const second = additions[1][0].tab;
    expect(second.id).not.toBe(tab.id);
    expect(second.content).toBe("Write-Host second");
    state = { ...state, tabs: [tab, second], activeTabId: second.id };
    await act(async () => root.render(<Harness />));
    expect(run).toHaveBeenCalledTimes(2);
    state = { ...state, isRunning: true };
    await act(async () => root.render(<Harness />));
    await act(async () => { await paste(); });
    expect(dispatch.mock.calls.filter(([action]) => action.type === "ADD_TAB")).toHaveLength(2);

  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
