/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAppUpdates,
  waitUntilIdle,
  type AppUpdates,
} from "../use-app-updates";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const download = vi.fn(async () => {});
const install = vi.fn(async () => {});
const close = vi.fn(async () => {});
const relaunch = vi.fn(async () => {});
let nextUpdate: { version: string } | null = null;
const check = vi.fn(async () =>
  nextUpdate ? { ...nextUpdate, download, install, close } : null,
);

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));

let latest: AppUpdates | undefined;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

function Harness(props: { autoCheckEnabled: boolean; isRunning: boolean }) {
  latest = useAppUpdates(props);
  return null;
}

async function render(props: { autoCheckEnabled: boolean; isRunning: boolean }) {
  await act(async () => {
    root!.render(<Harness {...props} />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
  nextUpdate = null;
  download.mockClear();
  install.mockClear();
  close.mockClear();
  relaunch.mockClear();
  check.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
});

describe("useAppUpdates", () => {
  it("installs a found update on the launch check without asking", async () => {
    nextUpdate = { version: "9.9.9" };
    await render({ autoCheckEnabled: true, isRunning: false });
    for (let i = 0; i < 5 && relaunch.mock.calls.length === 0; i++) await flush();

    expect(check).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(latest?.updateStatus).toEqual({ phase: "installing", version: "9.9.9" });
  });

  it("a manual check with nothing new reports up to date, and never installs", async () => {
    await render({ autoCheckEnabled: false, isRunning: false });
    expect(check).not.toHaveBeenCalled(); // auto check off: nothing at mount
    await act(async () => {
      await latest!.checkForUpdates(true);
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    expect(latest?.updateStatus).toEqual({ phase: "upToDate" });
  });

  it("a failed install is reported, not swallowed", async () => {
    nextUpdate = { version: "9.9.9" };
    install.mockRejectedValueOnce(new Error("disk full"));
    await render({ autoCheckEnabled: true, isRunning: false });
    for (let i = 0; i < 5 && latest?.updateStatus.phase !== "error"; i++) await flush();
    expect(latest?.updateStatus).toEqual({ phase: "error", message: "disk full" });
    expect(relaunch).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("waitUntilIdle", () => {
  it("polls until the runner is idle and only then resolves", async () => {
    let running = true;
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 3) running = false;
    });
    await waitUntilIdle(() => !running, 5_000, sleep);
    expect(sleeps).toEqual([5_000, 5_000, 5_000]);
  });

  it("returns at once when already idle", async () => {
    const sleep = vi.fn(async () => {});
    await waitUntilIdle(() => true, 5_000, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });
});
