import { describe, expect, it, vi } from "vitest";
import {
  EXIT_WHILE_BUSY_MESSAGE,
  handleExitRequest,
  type ExitRequestDeps,
} from "../exit-request";

function deps(overrides: Partial<ExitRequestDeps> = {}) {
  const calls: string[] = [];
  const base: ExitRequestDeps = {
    acknowledge: vi.fn(async () => {
      calls.push("ack");
    }),
    isBusy: () => false,
    confirm: vi.fn(async () => true),
    flushPendingSettings: vi.fn(async () => {
      calls.push("flush");
    }),
    exit: vi.fn(async () => {
      calls.push("exit");
    }),
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe("handleExitRequest", () => {
  it("exits without asking when nothing is running", async () => {
    const { deps: d, calls } = deps();
    await expect(handleExitRequest(d)).resolves.toBe(true);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(["ack", "flush", "exit"]);
  });

  it("keeps the app open when the user declines to stop running work", async () => {
    const { deps: d, calls } = deps({
      isBusy: () => true,
      confirm: vi.fn(async () => false),
    });
    await expect(handleExitRequest(d)).resolves.toBe(false);
    expect(d.confirm).toHaveBeenCalledWith(EXIT_WHILE_BUSY_MESSAGE);
    expect(calls).toEqual(["ack"]);
  });

  it("exits after the user confirms stopping running work", async () => {
    const { deps: d, calls } = deps({ isBusy: () => true });
    await expect(handleExitRequest(d)).resolves.toBe(true);
    expect(calls).toEqual(["ack", "flush", "exit"]);
  });

  it("asks once when File > Exit and tray Exit arrive together", async () => {
    let answer: (value: boolean) => void = () => {};
    const confirm = vi.fn(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const { deps: d, calls } = deps({ isBusy: () => true, confirm });
    const first = handleExitRequest(d);
    const second = handleExitRequest(d);
    await expect(second).resolves.toBe(false);
    answer(false);
    await expect(first).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["ack", "ack"]);

    // A later request is handled normally again.
    const { deps: later } = deps({ isBusy: () => true });
    await expect(handleExitRequest(later)).resolves.toBe(true);
  });

  it("still exits when the confirmation dialog cannot be shown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, calls } = deps({
      isBusy: () => true,
      confirm: vi.fn(async () => {
        throw new Error("no dialog");
      }),
    });
    await expect(handleExitRequest(d)).resolves.toBe(true);
    expect(calls).toEqual(["ack", "flush", "exit"]);
    error.mockRestore();
  });
});
