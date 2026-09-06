import { expect, it, vi } from "vitest";
import { waitForTerminalReady } from "../terminal/wait-for-ready";
import type { TerminalSessionHandle } from "../components/TerminalSession";

it("does not restart a PowerShell process that is still reaching its first prompt", async () => {
  vi.useFakeTimers();
  const handle = { isReady: vi.fn(() => false), isStarting: () => true, restart: vi.fn() };
  try {
    const ready = waitForTerminalReady(() => handle as unknown as TerminalSessionHandle);
    await vi.advanceTimersByTimeAsync(200);
    expect(handle.restart).not.toHaveBeenCalled();
    handle.isReady.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await ready).toBe(handle);
  } finally { vi.useRealTimers(); }
});
