import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { wipeTerminalDisplay } from "../terminal/wipe-display";

describe("wipeTerminalDisplay", () => {
  it("uses reset so the old prompt line is not kept as row 0", () => {
    const reset = vi.fn();
    const clear = vi.fn();
    wipeTerminalDisplay({ reset, clear } as unknown as Terminal);
    expect(reset).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
  });
});
