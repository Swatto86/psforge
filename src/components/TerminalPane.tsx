/** PSForge Integrated Terminal.
 *  Renders xterm.js backed by a real PTY PowerShell host (ConPTY on Windows).
 *  Input is passed through as raw bytes; output is rendered directly from PTY.
 */

import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "xterm/css/xterm.css";
import { useAppState } from "../store";
import * as cmd from "../commands";

// ---------------------------------------------------------------------------
// Terminal input syntax highlighting (E2E helper compatibility)
// ---------------------------------------------------------------------------

/**
 * Tokenises a PowerShell command string and wraps each token in ANSI 24-bit
 * colour codes that approximate VS Code Dark+ PowerShell colours.
 *
 * This is primarily retained for E2E compatibility via window.__psforge_highlight_ps.
 * The PTY terminal path now renders shell-native highlighting/editing directly.
 */
function highlightPs(text: string): string {
  // 24-bit ANSI: \x1b[38;2;R;G;Bm
  const K = "\x1b[38;2;86;156;214m"; // keyword / -param  #569cd6
  const F = "\x1b[38;2;220;220;170m"; // cmdlet Verb-Noun   #dcdcaa
  const V = "\x1b[38;2;156;220;254m"; // $variable          #9cdcfe
  const S = "\x1b[38;2;206;145;120m"; // string             #ce9178
  const C = "\x1b[38;2;106;153;85m"; // comment            #6a9955
  const N = "\x1b[38;2;181;206;168m"; // number             #b5cea8
  const R = "\x1b[0m"; // reset

  const KEYWORDS = new Set([
    "if",
    "else",
    "elseif",
    "for",
    "foreach",
    "while",
    "do",
    "until",
    "switch",
    "break",
    "continue",
    "return",
    "function",
    "filter",
    "param",
    "begin",
    "process",
    "end",
    "try",
    "catch",
    "finally",
    "throw",
    "class",
    "enum",
    "using",
    "in",
    "trap",
    "exit",
    "hidden",
    "static",
    "data",
  ]);

  let result = "";
  let i = 0;
  while (i < text.length) {
    // Comment: # to end of line
    if (text[i] === "#") {
      result += C + text.slice(i) + R;
      break;
    }
    // Single-quoted string
    if (text[i] === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j++;
      if (j < text.length) j++;
      result += S + text.slice(i, j) + R;
      i = j;
      continue;
    }
    // Double-quoted string (honour backtick escapes)
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "`" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      result += S + text.slice(i, j) + R;
      i = j;
      continue;
    }
    // Variable: $name or ${name}
    if (text[i] === "$" && i + 1 < text.length && /[\w{?]/.test(text[i + 1])) {
      let j = i + 1;
      if (text[j] === "{") {
        j++;
        while (j < text.length && text[j] !== "}") j++;
        if (j < text.length) j++;
      } else {
        while (j < text.length && /[\w?]/.test(text[j])) j++;
      }
      result += V + text.slice(i, j) + R;
      i = j;
      continue;
    }
    // -Parameter or -Operator (e.g. -eq, -like, -Path)
    if (
      text[i] === "-" &&
      i + 1 < text.length &&
      /[a-zA-Z]/.test(text[i + 1])
    ) {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
      result += K + text.slice(i, j) + R;
      i = j;
      continue;
    }
    // Number at a word boundary
    if (/\d/.test(text[i]) && (i === 0 || /\W/.test(text[i - 1]))) {
      let j = i;
      while (j < text.length && /[\d._xXa-fA-FoObBeE+-]/.test(text[j])) j++;
      result += N + text.slice(i, j) + R;
      i = j;
      continue;
    }
    // Word: keyword or plain identifier / cmdlet name (Verb-Noun)
    if (/[a-zA-Z_]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) j++;
      // Don't consume a trailing hyphen — it belongs to the next token.
      while (j > i + 1 && text[j - 1] === "-") j--;
      const word = text.slice(i, j);
      if (KEYWORDS.has(word.toLowerCase())) {
        result += K + word + R;
      } else if (
        /^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z][a-zA-Z0-9]*)+$/.test(word)
      ) {
        result += F + word + R;
      } else {
        result += word;
      }
      i = j;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

/** Reads a CSS custom property from the document root, with a fallback. */
function cssVar(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

type TerminalOutputEvent = {
  sessionId: number;
  data: string;
};

type TerminalExitEvent = {
  sessionId: number;
  exitCode: number | null;
};

/** Best-effort parser for PowerShell command-not-found error text (English locale). */
const MISSING_COMMAND_RE =
  /The term ['"`]([^'"`\r\n]+)['"`] is not recognized as (?:the )?name of a cmdlet, function, script file, or (?:executable|operable) program\./gi;

/** Removes common ANSI escape/control sequences from terminal text chunks. */
function stripAnsi(text: string): string {
  return (
    text
      // CSI sequences (colors, cursor movement, etc.)
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // OSC sequences (title updates, hyperlinks, etc.)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  );
}

export function TerminalPane() {
  const { state } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const isReadyRef = useRef<boolean>(false);
  const isStoppingRef = useRef<boolean>(false);
  const sessionIdRef = useRef<number>(0);
  const startInFlightRef = useRef<boolean>(false);
  const pendingOldSessionIdRef = useRef<number>(0);

  const writeQueueRef = useRef<string>("");
  const writeInFlightRef = useRef<boolean>(false);
  const fitRafRef = useRef<number | null>(null);
  const outputTailRef = useRef<string>("");
  const suggestedCommandsRef = useRef<Set<string>>(new Set());
  const suggestInFlightRef = useRef<Set<string>>(new Set());

  const fontFamilyRef = useRef(state.settings.outputFontFamily);
  const fontSizeRef = useRef(state.settings.outputFontSize);
  const shellPathRef = useRef(state.selectedPsPath);
  const loadProfileRef = useRef(state.settings.terminalLoadProfile === true);

  // Keep snapshot refs current for async callbacks.
  fontFamilyRef.current = state.settings.outputFontFamily;
  fontSizeRef.current = state.settings.outputFontSize;
  shellPathRef.current = state.selectedPsPath;
  loadProfileRef.current = state.settings.terminalLoadProfile === true;

  useEffect(() => {
    if (!containerRef.current) return;

    isStoppingRef.current = false;
    let cancelled = false;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "block",
      scrollback: 10_000,
      fontFamily: fontFamilyRef.current,
      fontSize: fontSizeRef.current,
      theme: {
        background: cssVar("--bg-primary", "#1e1e1e"),
        foreground: cssVar("--text-primary", "#cccccc"),
        cursor: "#ffffff",
        cursorAccent: cssVar("--bg-primary", "#1e1e1e"),
        selectionBackground: cssVar("--accent", "#007acc"),
        black: "#1e1e1e",
        red: "#f44747",
        green: "#4ec9b0",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#4fc1ff",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#4ec9b0",
        brightYellow: "#dcdcaa",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#4fc1ff",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    const safeFit = () => {
      if (cancelled) return;
      const host = containerRef.current;
      // FitAddon can throw if called during StrictMode teardown/race windows.
      if (!host || !host.isConnected) return;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fitAddon.fit();
      } catch {
        // Best-effort: next resize/focus event will retry.
      }
    };

    const scheduleFit = () => {
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
      }
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        safeFit();
      });
    };

    // Defer initial fit until after first layout pass.
    scheduleFit();

    termRef.current = term;
    fitRef.current = fitAddon;

    const syncSizeToBackend = () => {
      if (!isReadyRef.current) return;
      const cols = Math.max(term.cols || 120, 1);
      const rows = Math.max(term.rows || 30, 1);
      void cmd.terminalResize(cols, rows).catch(() => {});
    };

    const flushWriteQueue = (allowWhenNotReady = false) => {
      if (!allowWhenNotReady && !isReadyRef.current) return;
      if (writeInFlightRef.current) return;
      const chunk = writeQueueRef.current;
      if (!chunk) return;

      writeQueueRef.current = "";
      writeInFlightRef.current = true;
      void cmd
        .terminalWrite(chunk)
        .catch((err: unknown) => {
          term.write(`\r\n\x1b[31m[Terminal write failed: ${String(err)}]\x1b[0m\r\n`);
        })
        .finally(() => {
          writeInFlightRef.current = false;
          flushWriteQueue();
        });
    };

    const queueInput = (data: string, allowWhenNotReady = false) => {
      if (isStoppingRef.current || cancelled) return;
      if (!allowWhenNotReady && !isReadyRef.current) return;
      writeQueueRef.current += data;
      flushWriteQueue(allowWhenNotReady);
    };

    const startSession = async (showBanner = false) => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;

      isReadyRef.current = false;
      writeQueueRef.current = "";
      writeInFlightRef.current = false;
      outputTailRef.current = "";
      suggestedCommandsRef.current.clear();
      suggestInFlightRef.current.clear();
      pendingOldSessionIdRef.current = sessionIdRef.current;
      // Allow early PTY output for the new session to be accepted before the
      // invoke() promise resolves with the new session id.
      sessionIdRef.current = 0;

      const cols = Math.max(term.cols || 120, 1);
      const rows = Math.max(term.rows || 30, 1);

      try {
        const sessionId = await cmd.startTerminal(
          shellPathRef.current || "",
          cols,
          rows,
          loadProfileRef.current,
        );
        if (cancelled) return;

        sessionIdRef.current = sessionId;
        pendingOldSessionIdRef.current = 0;
        isReadyRef.current = true;
        flushWriteQueue();
        // Startup safeguard: if the initial DSR probe was emitted before
        // listeners were attached, proactively send a cursor report so
        // PSReadLine does not stall waiting on ESC[6n.
        const initRow = term.buffer.active.cursorY + 1;
        const initCol = term.buffer.active.cursorX + 1;
        queueInput(`\x1b[${initRow};${initCol}R`, true);

        if (showBanner) {
          term.write("\x1b[1;36mPSForge Terminal\x1b[0m\r\n");
          term.write("PTY host active (ConPTY on Windows).\r\n\r\n");
        }

        syncSizeToBackend();

        if (state.bottomPanelTab === "terminal") {
          term.focus();
        }
      } catch (err: unknown) {
        if (cancelled) return;
        pendingOldSessionIdRef.current = 0;
        term.write(
          `\r\n\x1b[1;31m[Failed to start terminal: ${String(err)}]\x1b[0m\r\n`,
        );
      } finally {
        startInFlightRef.current = false;
      }
    };

    const dataDisposable = term.onData((data) => {
      queueInput(data);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (!isReadyRef.current) return;
      void cmd.terminalResize(Math.max(cols, 1), Math.max(rows, 1)).catch(() => {});
    });

    const onWindowResize = () => {
      scheduleFit();
      syncSizeToBackend();
    };
    window.addEventListener("resize", onWindowResize);

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
      syncSizeToBackend();
    });
    resizeObserver.observe(containerRef.current);

    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let listenersAttached = false;
    let listenerRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const onTerminalOutput = (event: { payload: TerminalOutputEvent }) => {
      const activeSessionId = sessionIdRef.current;
      const pendingOldSessionId = pendingOldSessionIdRef.current;
      if (activeSessionId === 0 && pendingOldSessionId !== 0) {
        if (event.payload.sessionId === pendingOldSessionId) {
          // Ignore teardown bytes from the previous session during startup.
          return;
        }
      }
      if (activeSessionId !== 0 && event.payload.sessionId !== activeSessionId) {
        return;
      }
      // During startup, backend output can arrive before startTerminal()
      // resolves; latch the first output event's session id.
      if (activeSessionId === 0) {
        sessionIdRef.current = event.payload.sessionId;
      }
      const chunk = event.payload.data;
      term.write(chunk);

      // Command-not-found helper: suggest modules that export the missing cmdlet.
      const psPath = shellPathRef.current;
      if (psPath) {
        const plainChunk = stripAnsi(chunk);
        outputTailRef.current = (outputTailRef.current + plainChunk).slice(-12000);
        const tail = outputTailRef.current;

        MISSING_COMMAND_RE.lastIndex = 0;
        const commandsToSuggest: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = MISSING_COMMAND_RE.exec(tail)) !== null) {
          const commandName = m[1]?.trim();
          // PowerShell command names are single tokens; ignore multi-word captures.
          if (!commandName || /\s/.test(commandName)) continue;
          commandsToSuggest.push(commandName);
        }

        const sessionSnapshot = event.payload.sessionId;
        for (const commandName of commandsToSuggest) {
          const key = commandName.toLowerCase();
          if (
            suggestedCommandsRef.current.has(key) ||
            suggestInFlightRef.current.has(key)
          ) {
            continue;
          }
          suggestInFlightRef.current.add(key);
          void cmd
            .suggestModulesForCommand(psPath, commandName)
            .then((suggestions) => {
              if (cancelled) return;
              if (sessionIdRef.current !== sessionSnapshot) return;
              if (!suggestions.length) return;

              term.write(
                `\r\n\x1b[36m[PSForge] '${commandName}' may be available in:\x1b[0m\r\n`,
              );
              for (const item of suggestions.slice(0, 5)) {
                const parts = [item.name];
                if (item.version) parts.push(item.version);
                if (item.repository) parts.push(`(${item.repository})`);
                term.write(`\x1b[36m  - ${parts.join(" ")}\x1b[0m\r\n`);
                term.write(`\x1b[36m    ${item.installCommand}\x1b[0m\r\n`);
              }
            })
            .catch(() => {})
            .finally(() => {
              suggestInFlightRef.current.delete(key);
              suggestedCommandsRef.current.add(key);
            });
        }
      }

      // PSReadLine may probe cursor position with DSR (ESC[6n). In some
      // WebView2/xterm attach timings this response can be missed, which
      // stalls prompt rendering. Reply explicitly with current cursor coords.
      if (chunk.includes("\x1b[6n")) {
        const row = term.buffer.active.cursorY + 1;
        const col = term.buffer.active.cursorX + 1;
        // Reply even during startup: PSReadLine may request DSR before the
        // startTerminal() invoke promise resolves on the frontend.
        queueInput(`\x1b[${row};${col}R`, true);
      }
    };

    const onTerminalExit = (event: { payload: TerminalExitEvent }) => {
      if (sessionIdRef.current === 0) return;
      if (event.payload.sessionId !== sessionIdRef.current) return;
      isReadyRef.current = false;
      if (isStoppingRef.current) return;
      term.write("\r\n\x1b[33m[Terminal session ended. Use Restart to start a new shell.]\x1b[0m\r\n");
    };

    const attachListeners = async (attempt = 1): Promise<void> => {
      if (cancelled || listenersAttached) return;
      try {
        const [outputFn, exitFn] = await Promise.all([
          listen<TerminalOutputEvent>("terminal-output", onTerminalOutput),
          listen<TerminalExitEvent>("terminal-exit", onTerminalExit),
        ]);
        if (cancelled) {
          outputFn();
          exitFn();
          return;
        }
        unlistenOutput = outputFn;
        unlistenExit = exitFn;
        listenersAttached = true;
      } catch {
        if (cancelled) return;
        const delayMs = Math.min(250 * attempt, 2000);
        if (listenerRetryTimer !== null) {
          clearTimeout(listenerRetryTimer);
        }
        listenerRetryTimer = setTimeout(() => {
          listenerRetryTimer = null;
          void attachListeners(attempt + 1);
        }, delayMs);
      }
    };

    const w = window as unknown as Record<string, unknown>;
    w.__psforge_terminal_clear = () => {
      if (cancelled) return;
      term.clear();
    };
    w.__psforge_terminal_focus = () => {
      if (cancelled) return;
      scheduleFit();
      syncSizeToBackend();
      term.focus();
    };
    w.__psforge_terminal_restart = () => {
      if (cancelled) return;
      void startSession(false);
    };
    w.__psforge_terminal_get_content = (lineCount?: number) => {
      const count = lineCount ?? 80;
      const buf = term.buffer.active;
      const lines: string[] = [];
      const start = Math.max(0, buf.length - count);
      for (let i = start; i < buf.length; i++) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines.join("\n");
    };
    w.__psforge_terminal_is_ready = () => isReadyRef.current;
    w.__psforge_terminal_submit_current_input = () => {
      queueInput("\r");
    };
    w.__psforge_terminal_reset_input = () => {
      queueInput("\u0003");
    };
    w.__psforge_highlight_ps = highlightPs;

    // Initial startup: give event listeners a short head-start so the first
    // PTY control/query burst is not dropped.
    const startAfterListenerWarmup = async () => {
      void attachListeners();
      const deadline = Date.now() + 2000;
      while (!cancelled && !listenersAttached && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (cancelled) return;
      void startSession(true);
    };
    void startAfterListenerWarmup();

    return () => {
      cancelled = true;
      isStoppingRef.current = true;
      isReadyRef.current = false;

      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      if (listenerRetryTimer !== null) {
        clearTimeout(listenerRetryTimer);
        listenerRetryTimer = null;
      }

      delete w.__psforge_terminal_clear;
      delete w.__psforge_terminal_focus;
      delete w.__psforge_terminal_restart;
      delete w.__psforge_terminal_get_content;
      delete w.__psforge_terminal_is_ready;
      delete w.__psforge_terminal_submit_current_input;
      delete w.__psforge_terminal_reset_input;
      delete w.__psforge_highlight_ps;

      unlistenOutput?.();
      unlistenExit?.();

      void cmd.stopTerminal().catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply font updates live.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontFamily = state.settings.outputFontFamily;
    termRef.current.options.fontSize = state.settings.outputFontSize;
    try {
      fitRef.current?.fit();
    } catch {
      // Ignore transient fit races; resize observer will recover.
    }
    if (isReadyRef.current && termRef.current) {
      const cols = Math.max(termRef.current.cols || 120, 1);
      const rows = Math.max(termRef.current.rows || 30, 1);
      void cmd.terminalResize(cols, rows).catch(() => {});
    }
  }, [state.settings.outputFontFamily, state.settings.outputFontSize]);

  // Refit/focus when terminal tab becomes visible.
  useEffect(() => {
    if (state.bottomPanelTab !== "terminal" || !termRef.current) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Ignore transient fit races; resize observer will recover.
      }
      termRef.current?.focus();
      if (isReadyRef.current && termRef.current) {
        const cols = Math.max(termRef.current.cols || 120, 1);
        const rows = Math.max(termRef.current.rows || 30, 1);
        void cmd.terminalResize(cols, rows).catch(() => {});
      }
    });
  }, [state.bottomPanelTab]);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-container"
      className="w-full h-full"
      style={{
        backgroundColor: "var(--bg-primary)",
        minHeight: 0,
      }}
    />
  );
}
