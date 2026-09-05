/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createOutputPump, MAX_TERMINAL_WRITE_PER_FRAME } from "../terminal/output-pump";
import { createConsoleSession, type ConsoleSession } from "../terminal/console-session";
import { createCommandCompletionReader } from "../terminal/command-completion";

const { handlers, terminal } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  terminal: {
    write: vi.fn(), reset: vi.fn(), focus: vi.fn(), refresh: vi.fn(),
    dispose: vi.fn(), clear: vi.fn(), paste: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    cols: 120, rows: 30, options: {},
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
vi.mock("../commands", () => ({
  startTerminal: vi.fn(async () => 1),
  stopTerminal: vi.fn(async () => {}),
  terminalResize: vi.fn(async () => {}),
  terminalExec: vi.fn(async () => {}),
  terminalWrite: vi.fn(async () => {}),
}));
vi.mock("../terminal/xterm-setup", () => ({
  createTerminalWithAddons: () => ({
    terminal,
    addons: { fit: { fit: vi.fn() }, dispose: vi.fn() },
  }),
}));

let frames: Map<number, FrameRequestCallback>;
let session: ConsoleSession | undefined;
let container: HTMLDivElement;
function frame() {
  const queued = [...frames.values()];
  frames.clear();
  queued.forEach((callback) => callback(0));
}
function output(data: string) {
  handlers.get("terminal-output")!({ payload: { sessionId: 1, data } });
  frame();
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  frames = new Map();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  session?.dispose();
  session = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

describe("terminal output pump", () => {
  it("processes each byte once while draining a batch across frames", () => {
    const seen = vi.fn();
    const pump = createOutputPump(terminal as unknown as Terminal, seen);
    const first = "a".repeat(MAX_TERMINAL_WRITE_PER_FRAME) + "tail";
    pump.push(first);
    frame();
    pump.push("new");
    frame();
    expect(seen.mock.calls.map(([text]) => text).join("")).toBe(first + "new");
    expect(terminal.write.mock.calls.map(([text]) => text).join("")).toBe(first + "new");
  });

  it("does not reprocess a partially painted batch on teardown", () => {
    const seen = vi.fn();
    const pump = createOutputPump(terminal as unknown as Terminal, seen);
    const text = "x".repeat(MAX_TERMINAL_WRITE_PER_FRAME + 20);
    pump.push(text);
    frame();
    pump.drain();
    expect(seen.mock.calls.map(([chunk]) => chunk).join("")).toBe(text);
  });
});

describe("terminal command completion", () => {
  it("consumes each marker once and resets incomplete markers between sessions", () => {
    const reader = createCommandCompletionReader();
    expect(reader.feed("\x1b]633;D;0\x07\x1b]633;D;-1\x1b\\")).toEqual([0, -1]);
    expect(reader.feed("ordinary output")).toEqual([]);
    expect(reader.feed("\x1b]633;D;")).toEqual([]);
    reader.reset();
    expect(reader.feed("7\x07")).toEqual([]);
  });

  it.each(["\x07", "\x1b\\"])("handles every split of a completion marker ending in %j", async (end) => {
    session = createConsoleSession(container, {}, {
      shellPath: () => "", loadProfile: () => false,
      startupCommand: () => "", isActive: () => false,
    });
    await vi.waitFor(() => expect(session!.isReady()).toBe(true));
    const marker = `\x1b]633;D;7${end}`;
    for (let split = 1; split < marker.length; split++) {
      const complete = vi.fn();
      void session.exec("Write-Output test").then(complete, complete);
      output(marker.slice(0, split));
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
      output(marker.slice(split));
      await Promise.resolve();
      expect(complete).toHaveBeenCalledExactlyOnceWith(7);
    }
  });
});
