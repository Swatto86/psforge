import { describe, expect, it } from "vitest";
import { startupPtyDims } from "../terminal-utils";
import terminalPane from "../components/TerminalPane.tsx?raw";

describe("integrated terminal startup size", () => {
  it("ignores xterm's degenerate minimum when the pane has no layout yet", () => {
    // WebKitGTK mounts the console before the flex layout resolves, so xterm
    // reports its own 2x1 floor. Booting PowerShell at 2 columns shreds the
    // prompt; start at the defaults and let the ResizeObserver correct it.
    expect(startupPtyDims(false, 2, 1)).toEqual({ cols: 120, rows: 30 });
  });

  it("uses the measured pane size once the pane is laid out", () => {
    expect(startupPtyDims(true, 158, 41)).toEqual({ cols: 158, rows: 41 });
  });

  it("keeps the RawUI row floor for short panes", () => {
    expect(startupPtyDims(true, 80, 3)).toEqual({ cols: 80, rows: 5 });
  });
});

describe("integrated terminal cursor position reports", () => {
  it("reads TerminalPane source", () => {
    expect(terminalPane).toContain("cmd.startTerminal(");
  });

  it("never fabricates a cursor position report on session start", () => {
    // A DSR reply the terminal was never asked for is queued as keyboard
    // input: on a real PTY it echoes as literal `^[[1;1R` and desynchronises
    // PSReadLine's own cursor query. xterm.js already answers CSI 6 n itself.
    expect(terminalPane).not.toContain("buffer.active.cursorY");
    expect(terminalPane).not.toContain("R`, true)");
  });
});
