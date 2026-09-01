/**
 * A live integrated console: one xterm.js terminal bound to one PowerShell PTY
 * in the Rust backend.
 *
 * This is deliberately plain TypeScript. The React component owns mounting and
 * prop changes; everything below — spawn, input queue, resize, output, exit,
 * teardown — is session lifecycle, and keeping it out of an effect closure is
 * what lets callers hold a stable object instead of a bag of function refs.
 */

import type { ITerminalOptions, ITheme, Terminal } from "@xterm/xterm";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as cmd from "../commands";
import { clampPtyDims, startupPtyDims } from "../terminal-utils";
import { createTerminalWithAddons } from "./xterm-setup";
import { wipeTerminalDisplay } from "./wipe-display";
import { createOutputPump } from "./output-pump";
import { createSessionReaders, type SessionReaders } from "./session-readers";
import { createMissingCommandNotifier } from "./missing-command-suggest";

type TerminalOutputEvent = {
  sessionId: number;
  data: string;
};

type TerminalExitEvent = {
  sessionId: number;
  exitCode: number | null;
};

/** What the session needs to read from the owning component, when it asks. */
export type ConsoleSessionContext = {
  shellPath: () => string;
  loadProfile: () => boolean;
  /** Command sent once per PTY, e.g. Enter-PSSession for a remote tab. */
  startupCommand: () => string;
  /** Whether this console is the visible one; gates module suggestions. */
  isActive: () => boolean;
};

export type ConsoleSession = {
  readonly term: Terminal;
  readonly readers: SessionReaders;
  /** Wipe the display and (re)spawn PowerShell. Also the Clear action. */
  restart: () => void;
  isReady: () => boolean;
  queueInput: (data: string, allowWhenNotReady?: boolean) => void;
  exec: (command: string) => Promise<number | null>;
  focus: () => void;
  /** Clear the xterm buffer without touching the PowerShell session. */
  clearBuffer: () => void;
  writeLocal: (text: string) => void;
  pasteText: (text: string) => void;
  applyFont: (fontFamily: string, fontSize: number) => void;
  applyTheme: (theme: ITheme) => void;
  /** Re-fit, repaint and focus after this console becomes visible. */
  syncActive: () => void;
  dispose: () => void;
};

export function createConsoleSession(
  container: HTMLElement,
  options: ITerminalOptions,
  context: ConsoleSessionContext,
): ConsoleSession {
  const { terminal: term, addons } = createTerminalWithAddons(
    container,
    options,
  );
  const readers = createSessionReaders(term);

  let disposed = false;
  let stopping = false;
  let ready = false;
  let startInFlight = false;
  let sessionId = 0;
  let startupSentForSession = 0;

  let writeQueue = "";
  let writeInFlight = false;
  let fitRaf: number | null = null;

  let pendingExecutions: Array<{
    resolve: (exitCode: number | null) => void;
    reject: (error: Error) => void;
  }> = [];

  const safeFit = () => {
    if (disposed || !container.isConnected) return;
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
    try {
      addons.fit.fit();
    } catch {
      // best effort
    }
  };

  const scheduleFit = () => {
    if (fitRaf !== null) cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => {
      fitRaf = null;
      safeFit();
    });
  };

  const resizeBackend = () => {
    if (!ready || sessionId <= 0) return;
    const { cols, rows } = clampPtyDims(term.cols, term.rows);
    void cmd.terminalResize(sessionId, cols, rows).catch(() => {});
  };

  const rejectPendingExecutions = (message: string) => {
    const pending = pendingExecutions;
    pendingExecutions = [];
    for (const entry of pending) {
      entry.reject(new Error(message));
    }
  };

  const flushWriteQueue = (allowWhenNotReady = false) => {
    if (!allowWhenNotReady && !ready) return;
    if (writeInFlight || sessionId <= 0) return;
    const chunk = writeQueue;
    if (!chunk) return;

    writeQueue = "";
    writeInFlight = true;
    void cmd
      .terminalWrite(sessionId, chunk)
      .catch((err: unknown) => {
        term.write(
          `\r\n\x1b[31m[Terminal write failed: ${String(err)}]\x1b[0m\r\n`,
        );
      })
      .finally(() => {
        writeInFlight = false;
        flushWriteQueue();
      });
  };

  const queueInput = (data: string, allowWhenNotReady = false) => {
    if (disposed || stopping) return;
    if (!allowWhenNotReady && !ready) return;
    writeQueue += data;
    flushWriteQueue(allowWhenNotReady);
  };

  const focus = () => {
    scheduleFit();
    term.focus();
    resizeBackend();
  };

  // Background consoles stay quiet: an empty host skips the lookup entirely.
  const missingCommands = createMissingCommandNotifier(
    (text) => term.write(text),
    () => (context.isActive() ? context.shellPath() : ""),
  );

  const processOutputChunk = (chunk: string) => {
    readers.feed(chunk);

    for (const match of chunk.matchAll(
      /\x1b]633;D;(-?\d+)(?:\x07|\x1b\\)/g,
    )) {
      const exitCode = Number.parseInt(match[1] ?? "", 10);
      const pending = pendingExecutions.shift();
      if (pending) {
        pending.resolve(Number.isFinite(exitCode) ? exitCode : null);
      }
    }

    missingCommands.feed(chunk);
  };

  const pump = createOutputPump(term, processOutputChunk);

  const startSession = async () => {
    if (startInFlight) return;
    startInFlight = true;
    // Wipe first so the new prompt is not painted under leftover scrollback
    // (Clear used to restart alone and leave the old prompt above).
    wipeTerminalDisplay(term);
    ready = false;
    writeQueue = "";
    writeInFlight = false;
    pump.reset();
    missingCommands.reset();
    rejectPendingExecutions(
      "Terminal session restarted before command completion.",
    );

    if (sessionId > 0) {
      await cmd.stopTerminal(sessionId).catch(() => {});
      sessionId = 0;
    }

    // Measure first: the console can mount before its pane has a layout, and a
    // PTY started from xterm's placeholder size never recovers.
    safeFit();
    const paneIsLaidOut =
      container.clientWidth > 0 && container.clientHeight > 0;
    const { cols, rows } = startupPtyDims(paneIsLaidOut, term.cols, term.rows);

    try {
      const sid = await cmd.startTerminal(
        context.shellPath() || "",
        cols,
        rows,
        context.loadProfile(),
      );
      if (disposed) {
        // The owning tab unmounted while the backend was still spawning: its
        // teardown ran before sessionId was set, so nothing else will ever stop
        // this session. Stop it here or the PTY process leaks for the rest of
        // the app run.
        void cmd.stopTerminal(sid).catch(() => {});
        return;
      }
      sessionId = sid;
      ready = true;
      flushWriteQueue();

      const startup = context.startupCommand().trim();
      if (startup && startupSentForSession !== sid) {
        startupSentForSession = sid;
        queueInput(`${startup}\r`, true);
      }

      resizeBackend();
      scheduleFit();
      if (context.isActive()) {
        requestAnimationFrame(() => {
          scheduleFit();
          if (term.rows > 0) term.refresh(0, term.rows - 1);
          focus();
        });
      }
    } catch (err: unknown) {
      rejectPendingExecutions(`Failed to start terminal session: ${String(err)}`);
      if (!disposed) {
        term.write(
          `\r\n\x1b[1;31m[Failed to start terminal: ${String(err)}]\x1b[0m\r\n`,
        );
      }
    } finally {
      startInFlight = false;
    }
  };

  const dataDisposable = term.onData((data) => queueInput(data));
  const resizeDisposable = term.onResize(({ cols, rows }) => {
    if (!ready || sessionId <= 0) return;
    void cmd.terminalResize(sessionId, cols, rows).catch(() => {});
  });

  const onWindowResize = () => {
    scheduleFit();
    resizeBackend();
  };
  window.addEventListener("resize", onWindowResize);
  const resizeObserver = new ResizeObserver(onWindowResize);
  resizeObserver.observe(container);

  const onTerminalOutput = (event: { payload: TerminalOutputEvent }) => {
    if (event.payload.sessionId !== sessionId) return;
    pump.push(event.payload.data);
  };

  const onTerminalExit = (event: { payload: TerminalExitEvent }) => {
    if (event.payload.sessionId !== sessionId) return;
    ready = false;
    rejectPendingExecutions("Terminal session ended before command completion.");
    if (stopping) return;
    term.write(
      "\r\n\x1b[33m[Terminal session ended. Use Restart Session to start a new shell.]\x1b[0m\r\n",
    );
  };

  let unlistenOutput: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  void Promise.all([
    listen<TerminalOutputEvent>("terminal-output", onTerminalOutput),
    listen<TerminalExitEvent>("terminal-exit", onTerminalExit),
  ])
    .then(([outFn, exitFn]) => {
      if (disposed) {
        outFn();
        exitFn();
        return;
      }
      unlistenOutput = outFn;
      unlistenExit = exitFn;
      void startSession();
    })
    .catch((err: unknown) => {
      term.write(
        `\r\n\x1b[1;31m[Failed to attach terminal listeners: ${String(err)}]\x1b[0m\r\n`,
      );
    });

  scheduleFit();

  return {
    term,
    readers,
    restart: () => {
      void startSession();
    },
    isReady: () => ready,
    queueInput,
    exec: (command: string) => {
      if (disposed || stopping) {
        return Promise.reject(new Error("Terminal session is unavailable."));
      }
      const trimmed = command.trim();
      if (!trimmed) return Promise.resolve(0);
      if (!ready || sessionId <= 0) {
        return Promise.reject(new Error("Terminal session is not ready."));
      }

      const sid = sessionId;
      return new Promise<number | null>((resolve, reject) => {
        const pending = { resolve, reject };
        pendingExecutions.push(pending);
        void cmd.terminalExec(sid, trimmed).catch((err: unknown) => {
          pendingExecutions = pendingExecutions.filter(
            (candidate) => candidate !== pending,
          );
          reject(new Error(`Failed to execute in terminal: ${String(err)}`));
        });
      });
    },
    focus,
    clearBuffer: () => term.clear(),
    writeLocal: (text: string) => {
      if (!text) return;
      term.write(text.replace(/\r?\n/g, "\r\n"));
    },
    pasteText: (text: string) => {
      if (!text) return;
      term.paste(text);
    },
    applyFont: (fontFamily: string, fontSize: number) => {
      term.options.fontFamily = fontFamily;
      term.options.fontSize = fontSize;
      safeFit();
      resizeBackend();
    },
    applyTheme: (theme: ITheme) => {
      term.options.theme = theme;
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    },
    syncActive: () => {
      safeFit();
      if (term.rows > 0) term.refresh(0, term.rows - 1);
      term.focus();
      resizeBackend();
    },
    dispose: () => {
      disposed = true;
      stopping = true;
      ready = false;

      unlistenOutput?.();
      unlistenExit?.();
      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();

      if (fitRaf !== null) {
        cancelAnimationFrame(fitRaf);
        fitRaf = null;
      }
      pump.drain();
      missingCommands.reset();

      addons.dispose();
      rejectPendingExecutions("Terminal session was disposed.");

      const sid = sessionId;
      sessionId = 0;
      if (sid > 0) {
        void cmd.stopTerminal(sid).catch(() => {});
      }
      term.dispose();
    },
  };
}
