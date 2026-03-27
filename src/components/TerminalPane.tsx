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

const MAX_RESTART_ATTEMPTS = 5;

export function TerminalPane() {
  const { state } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const isReadyRef = useRef<boolean>(false);
  const isStoppingRef = useRef<boolean>(false);
  const sessionIdRef = useRef<number>(0);
  const restartAttemptsRef = useRef<number>(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writeQueueRef = useRef<string>("");
  const writeInFlightRef = useRef<boolean>(false);

  const fontFamilyRef = useRef(state.settings.outputFontFamily);
  const fontSizeRef = useRef(state.settings.outputFontSize);
  const shellPathRef = useRef(state.selectedPsPath);

  // Keep snapshot refs current for async callbacks.
  fontFamilyRef.current = state.settings.outputFontFamily;
  fontSizeRef.current = state.settings.outputFontSize;
  shellPathRef.current = state.selectedPsPath;

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
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    const syncSizeToBackend = () => {
      if (!isReadyRef.current) return;
      const cols = Math.max(term.cols || 120, 1);
      const rows = Math.max(term.rows || 30, 1);
      void cmd.terminalResize(cols, rows).catch(() => {});
    };

    const flushWriteQueue = () => {
      if (!isReadyRef.current || writeInFlightRef.current) return;
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

    const queueInput = (data: string) => {
      if (!isReadyRef.current || isStoppingRef.current || cancelled) return;
      writeQueueRef.current += data;
      flushWriteQueue();
    };

    const startSession = async (showBanner = false) => {
      isReadyRef.current = false;
      writeQueueRef.current = "";
      writeInFlightRef.current = false;

      const cols = Math.max(term.cols || 120, 1);
      const rows = Math.max(term.rows || 30, 1);

      try {
        const sessionId = await cmd.startTerminal(
          shellPathRef.current || "",
          cols,
          rows,
        );
        if (cancelled) return;

        sessionIdRef.current = sessionId;
        isReadyRef.current = true;

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
        term.write(
          `\r\n\x1b[1;31m[Failed to start terminal: ${String(err)}]\x1b[0m\r\n`,
        );
      }
    };

    const scheduleRestart = () => {
      const attempt = restartAttemptsRef.current + 1;
      restartAttemptsRef.current = attempt;

      if (attempt > MAX_RESTART_ATTEMPTS) {
        term.write(
          `\r\n\x1b[31m[Session exited and could not be restarted after ${MAX_RESTART_ATTEMPTS} attempts.]\x1b[0m\r\n`,
        );
        return;
      }

      const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 32000);
      term.write(
        `\r\n\x1b[33m[Session ended. Restarting in ${delayMs / 1000}s (attempt ${attempt}/${MAX_RESTART_ATTEMPTS})...]\x1b[0m\r\n`,
      );

      if (restartTimerRef.current !== null) {
        clearTimeout(restartTimerRef.current);
      }

      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (isStoppingRef.current || cancelled) return;
        term.write("\x1b[33m[Restarting session...]\x1b[0m\r\n");
        void startSession(false);
      }, delayMs);
    };

    const dataDisposable = term.onData((data) => {
      queueInput(data);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (!isReadyRef.current) return;
      void cmd.terminalResize(Math.max(cols, 1), Math.max(rows, 1)).catch(() => {});
    });

    const onWindowResize = () => {
      fitAddon.fit();
      syncSizeToBackend();
    };
    window.addEventListener("resize", onWindowResize);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      syncSizeToBackend();
    });
    resizeObserver.observe(containerRef.current);

    const unlistenOutputPromise: Promise<UnlistenFn> = listen<TerminalOutputEvent>(
      "terminal-output",
      (event) => {
        if (event.payload.sessionId !== sessionIdRef.current) return;
        // Session has produced output; treat it as healthy and reset backoff.
        restartAttemptsRef.current = 0;
        term.write(event.payload.data);
      },
    );

    const unlistenExitPromise: Promise<UnlistenFn> = listen<TerminalExitEvent>(
      "terminal-exit",
      (event) => {
        if (event.payload.sessionId !== sessionIdRef.current) return;
        isReadyRef.current = false;
        if (isStoppingRef.current) return;
        scheduleRestart();
      },
    );

    const w = window as unknown as Record<string, unknown>;
    w.__psforge_terminal_clear = () => {
      if (cancelled) return;
      term.clear();
    };
    w.__psforge_terminal_focus = () => {
      if (cancelled) return;
      fitAddon.fit();
      syncSizeToBackend();
      term.focus();
    };
    w.__psforge_terminal_restart = () => {
      if (cancelled) return;
      restartAttemptsRef.current = 0;
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

    // Initial startup.
    void startSession(true);

    return () => {
      cancelled = true;
      isStoppingRef.current = true;
      isReadyRef.current = false;

      if (restartTimerRef.current !== null) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }

      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();

      delete w.__psforge_terminal_clear;
      delete w.__psforge_terminal_focus;
      delete w.__psforge_terminal_restart;
      delete w.__psforge_terminal_get_content;
      delete w.__psforge_terminal_is_ready;
      delete w.__psforge_terminal_submit_current_input;
      delete w.__psforge_terminal_reset_input;
      delete w.__psforge_highlight_ps;

      void Promise.all([unlistenOutputPromise, unlistenExitPromise])
        .then((fns) => {
          for (const fn of fns) fn();
        })
        .catch(() => {});

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
    fitRef.current?.fit();
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
      fitRef.current?.fit();
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
