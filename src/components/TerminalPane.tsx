/** PSForge Integrated Terminal.
 *  Renders an xterm.js terminal backed by an interactive PowerShell session.
 *  The session is started when this component mounts and stopped on unmount.
 *  Output lines arrive via Tauri events emitted by terminal.rs.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { useAppState } from "../store";
import * as cmd from "../commands";

// ---------------------------------------------------------------------------
// Terminal input syntax highlighting
// ---------------------------------------------------------------------------

/**
 * Tokenises a PowerShell command string and wraps each token in ANSI 24-bit
 * colour codes that approximate VS Code Dark+ PowerShell colours.
 *
 * The returned string has identical *visual* width to the input — ANSI escape
 * sequences are non-printing and do not affect xterm.js cursor-position
 * arithmetic.  All callers must therefore use the *raw* text length (not the
 * highlighted string length) for cursor movement calculations.
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
        // PS control-flow keyword
        result += K + word + R;
      } else if (
        /^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z][a-zA-Z0-9]*)+$/.test(word)
      ) {
        // Verb-Noun cmdlet pattern (e.g. Write-Host, Get-ChildItem)
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

type TabCompletionCycle = {
  seedInput: string;
  tokenStart: number;
  tokenEnd: number;
  items: string[];
  index: number;
  renderedInput: string;
  renderedCursor: number;
};

/** PowerShell token boundary characters used for completion replacement. */
const TOKEN_BOUNDARY_RE = /[\s,;|(){}\[\]`"'<>@#%&*!?+^]/;

/** Extracts `Get-Foo` from stderr text like: The term 'Get-Foo' is not recognized... */
function extractMissingCommandName(line: string): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const patterns = [
    /The term ['"]([^'"]+)['"] is not recognized\b/i,
    /CommandNotFoundException:\s*(?:The term )?['"]([^'"]+)['"]/i,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }
  return null;
}

export function TerminalPane() {
  const { state } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Characters typed by the user but not yet submitted. */
  const inputBufferRef = useRef<string>("");
  /** Cursor position within inputBufferRef.current (0 = before first char). */
  const cursorPosRef = useRef<number>(0);
  /** Command history (oldest first, capped at 500). */
  const historyRef = useRef<string[]>([]);
  /** Index into historyRef during Up/Down navigation; -1 = editing new line. */
  const historyIdxRef = useRef<number>(-1);
  /**
   * Partial escape sequence accumulator.  xterm.js delivers escape sequences
   * as complete strings in a single onData call, but we accumulate across calls
   * to be safe.  Reset to "" once the terminator character is detected.
   */
  const escapeSeqRef = useRef<string>("");
  /** Whether the session is ready to accept commands. */
  const isReadyRef = useRef<boolean>(false);
  /** Snapshot of font settings used at mount time; updated separately.
   *  Uses the output-specific font settings, not the editor font, so the
   *  terminal respects the Output section of the Settings panel. */
  const fontFamilyRef = useRef(state.settings.outputFontFamily);
  const fontSizeRef = useRef(state.settings.outputFontSize);
  const shellPathRef = useRef(state.selectedPsPath);
  /**
   * Current working directory as reported by the REPL script via the
   * terminal-cwd Tauri event.  Updated before every terminal-done event so
   * the prompt always reflects the directory after the last command.
   */
  const cwdRef = useRef<string>("");
  /**
   * Set to true by startSession() after the session spawns successfully.
   * Cleared (and writePrompt() called) by the terminal-cwd listener when the
   * REPL's startup CWD line arrives.  This ensures the initial prompt always
   * shows the correct path instead of the empty string that cwdRef holds
   * before the first terminal-cwd event fires.
   */
  const pendingInitialPromptRef = useRef<boolean>(false);
  /** State for cycling through TabExpansion2 completions across repeated Tab presses. */
  const tabCompletionRef = useRef<TabCompletionCycle | null>(null);
  /** Monotonic sequence to discard stale async completion responses. */
  const completionSeqRef = useRef<number>(0);
  /** Missing command name captured from the latest stderr line for this command run. */
  const missingCommandRef = useRef<string | null>(null);
  /** Commands already hinted in this session so we do not repeat lookup spam. */
  const hintedMissingCommandsRef = useRef<Set<string>>(new Set());

  // Keep snapshot refs current so the mount effect captures up-to-date values.
  fontFamilyRef.current = state.settings.outputFontFamily;
  fontSizeRef.current = state.settings.outputFontSize;
  shellPathRef.current = state.selectedPsPath;

  // Ref that holds the restart timer so it can be cancelled on unmount.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Consecutive restart attempts; reset to 0 on first terminal-done (proven working session). */
  const restartAttemptsRef = useRef<number>(0);
  /** Upper bound on automatic restart attempts before giving up. */
  const MAX_RESTART_ATTEMPTS = 5;
  /**
   * Set to true in the effect cleanup so that terminal-exit events fired by
   * our own deliberate stopTerminal() call (e.g. React StrictMode
   * mount→unmount→remount in dev, or component teardown) do NOT schedule
   * an auto-restart.  Reset to false at the start of each effect run.
   */
  const isStoppingRef = useRef<boolean>(false);
  /**
   * True for a short window after each startTerminal() call.  The Rust
   * start_terminal command always calls kill_session() internally before
   * spawning the new process — the resulting terminal-exit event arrives
   * asynchronously from a Rust thread and will be delivered AFTER isStoppingRef
   * has already been reset to false in the new React effect run.  Treating it
   * as an unexpected crash would immediately schedule a restart, killing the
   * just-started session and looping forever.  We ignore terminal-exit events
   * received while settling is active.  See SETTLE_MS below.
   */
  const settlingRef = useRef<boolean>(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * How long (ms) to ignore terminal-exit events after calling startTerminal.
   *
   * When startTerminal is called it internally invokes kill_session(), which
   * closes stdin and calls child.kill() on the old process.  The Rust stdout-
   * reader thread then reads EOF and emits terminal-exit via Tauri IPC.  The
   * total latency of that chain (OS kill → pipe close → Rust thread unblock →
   * Tauri IPC queue → JS event loop) can exceed 500 ms on busy or slower
   * Windows machines, causing the stale exit event to arrive after the settle
   * window closes and be mistaken for a genuine crash of the NEW session —
   * triggering an immediate restart that kills the new session, which then emits
   * another terminal-exit, looping forever at "attempt 1/5".
   *
   * 3 000 ms is a generous but safe bound: it covers the worst-case IPC delay
   * while still catching genuine new-session crashes (which require the PS
   * process to start and then fail, a sequence that takes well over 3 s only
   * in pathological environments).  The downside is that a crash within the
   * first 3 s of a fresh session delays the restart by the remaining settle
   * time; this is acceptable given the rarity of such crashes.
   */
  const SETTLE_MS = 3000;

  // Mount: initialise xterm.js, start the PS session, wire Tauri events.
  // The effect runs once on mount; settings changes are applied via a separate effect.
  useEffect(() => {
    if (!containerRef.current) return;
    // Reset session-guard flags for this effect invocation.
    // isStoppingRef is set true by the cleanup; clear it so fresh crashes are caught.
    // settlingRef is set true HERE (not just inside startSession) to close the race
    // window where stopTerminal() from the previous cleanup's terminal-exit fires
    // after isStoppingRef is reset but before startSession() sets settlingRef.
    // startSession() will extend the settle window via its own timer.
    isStoppingRef.current = false;
    settlingRef.current = true;
    // Local cancellation flag: set to true in cleanup so that async Promise
    // callbacks from THIS effect run are silently discarded after unmount.
    // Without this, the first React StrictMode run's startTerminal() Promise
    // resolves AFTER cleanup has disposed the xterm instance; writing to a
    // disposed terminal throws, the .catch() fires, and settlingRef is cleared
    // prematurely -- which causes the next terminal-exit event (from the just-
    // started session's old kill) to be treated as a crash and schedule a restart.
    let cancelled = false;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      // Use "block" when unfocused instead of "outline": the outline variant
      // can be nearly invisible at small font sizes or in certain WebView2
      // GPU rendering paths used in release builds.
      cursorInactiveStyle: "block",
      scrollback: 10_000,
      fontFamily: fontFamilyRef.current,
      fontSize: fontSizeRef.current,
      theme: {
        background: cssVar("--bg-primary", "#1e1e1e"),
        foreground: cssVar("--text-primary", "#cccccc"),
        // Bright white cursor for maximum contrast in all rendering contexts.
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
    // Defer initial fit so the container has its final dimensions.
    setTimeout(() => fitAddon.fit(), 0);

    termRef.current = term;
    fitRef.current = fitAddon;
    inputBufferRef.current = "";
    cursorPosRef.current = 0;
    historyIdxRef.current = -1;
    escapeSeqRef.current = "";
    isReadyRef.current = false;

    // Starts (or restarts) the PowerShell back-end session.
    // Extracted so it can be called both on initial mount and after an exit.
    // The Tauri event listeners do not need re-registration — they remain
    // active for the lifetime of the mount effect.
    /**
     * Starts (or restarts) the PS backend session.
     *
     * Sets settlingRef=true before each startTerminal() call so that the
     * asynchronous terminal-exit event fired by start_terminal's internal
     * kill_session() (which kills the previously running session) is ignored.
     * settlingRef is cleared after SETTLE_MS, giving the stale event time to
     * arrive and be discarded before we accept new exits as unexpected crashes.
     */
    const startSession = (showBanner = false) => {
      isReadyRef.current = false;
      inputBufferRef.current = "";
      cursorPosRef.current = 0;
      historyIdxRef.current = -1;
      escapeSeqRef.current = "";

      // Begin settle window: ignore terminal-exit until SETTLE_MS after spawn.
      settlingRef.current = true;
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);

      const shellPath = shellPathRef.current || "";
      cmd
        .startTerminal(shellPath)
        .then(() => {
          // Stale promise from a previous (unmounted) effect run -- discard.
          if (cancelled) return;
          // New process is running.  Keep settling for SETTLE_MS so any
          // in-flight terminal-exit from the just-killed old session is ignored.
          settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            settlingRef.current = false;
          }, SETTLE_MS);
          isReadyRef.current = true;
          // Do NOT reset restartAttemptsRef here -- only reset on terminal-done.
          if (showBanner) {
            term.write("\x1b[1;36mPSForge Terminal\x1b[0m\r\n");
            term.write("Type PowerShell commands and press Enter.\r\n\r\n");
          } else {
            // Ensure the new prompt starts on its own line regardless of where
            // the cursor was left after the previous session ended.
            term.write("\r\n");
          }
          // Do NOT call writePrompt() here -- cwdRef is still empty because
          // the REPL's startup <<PSF_CWD>> line hasn't arrived yet via IPC.
          // pendingInitialPromptRef tells the terminal-cwd listener to write
          // the first prompt as soon as the path is known.
          pendingInitialPromptRef.current = true;
          term.focus();
          // Restart the cursor blink timer.  In WebView2 the blink animation
          // can fail to start when the xterm canvas initialises while the app
          // window is still hidden (visible:false in tauri.conf.json).  Toggling
          // cursorBlink off then on forces xterm to re-arm its internal interval.
          term.options.cursorBlink = false;
          requestAnimationFrame(() => {
            if (!cancelled) term.options.cursorBlink = true;
          });
        })
        .catch((err: unknown) => {
          // Stale promise from a previous (unmounted) effect run -- discard.
          if (cancelled) return;
          settlingRef.current = false;
          if (settleTimerRef.current !== null) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
          }
          term.write(
            `\x1b[1;31m[Failed to start terminal: ${String(err)}]\x1b[0m\r\n`,
          );
        });
    };

    // Expose terminal actions as window globals so OutputPane's action bar
    // can trigger them without prop drilling.  Cleaned up on unmount.
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_terminal_clear = () => {
      if (!cancelled) {
        term.clear();
        writePrompt();
      }
    };
    w.__psforge_terminal_focus = () => {
      if (!cancelled) {
        term.focus();
        fitRef.current?.fit();
      }
    };
    w.__psforge_terminal_restart = () => {
      if (cancelled) return;
      // User-initiated restart: grant a full set of retries.
      restartAttemptsRef.current = 0;
      startSession(false);
    };
    /**
     * Reads the last `lineCount` lines from the active xterm buffer as plain
     * text.  Exposed as a window global so E2E tests can retrieve terminal
     * content even when the canvas renderer is active (canvas text is not
     * directly accessible via the WebDriver DOM API).
     */
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
    /** Returns true if the session is ready to accept keyboard input. */
    w.__psforge_terminal_is_ready = () => isReadyRef.current;
    /**
     * Exposes the module-level highlightPs tokeniser so E2E tests can call it
     * directly from browser.execute() and verify ANSI output without needing
     * to drive keyboard input and inspect xterm canvas rendering.
     */
    w.__psforge_highlight_ps = highlightPs;
    /**
     * Submits the current input buffer as if the user pressed Enter.
     * Exposed as a window global so E2E tests can verify command execution
     * independently of whether the keyboard Enter path is functional.
     * This is the same logic as the "\r" branch of onData.
     */
    w.__psforge_terminal_submit_current_input = () => {
      if (cancelled || !isReadyRef.current) return;
      const command = inputBufferRef.current;
      const charsToEnd = command.length - cursorPosRef.current;
      if (charsToEnd > 0) term.write(`\x1b[${charsToEnd}C`);
      inputBufferRef.current = "";
      cursorPosRef.current = 0;
      tabCompletionRef.current = null;
      term.write("\r\n");
      if (command.trim()) {
        missingCommandRef.current = null;
        const hist = historyRef.current;
        if (hist.length === 0 || hist[hist.length - 1] !== command) {
          hist.push(command);
          if (hist.length > 500) hist.shift();
        }
        historyIdxRef.current = -1;
        const normalized = command.trim().toLowerCase();
        if (
          normalized === "clear" ||
          normalized === "cls" ||
          normalized === "clear-host"
        ) {
          term.clear();
          writePrompt();
        } else {
          cmd.terminalExec(command).catch((err: unknown) => {
            term.write(`\x1b[31m[Error: ${String(err)}]\x1b[0m\r\n`);
            writePrompt();
          });
        }
      } else {
        missingCommandRef.current = null;
        historyIdxRef.current = -1;
        writePrompt();
      }
    };
    /**
     * Resets the input line to an empty state and writes a fresh prompt.
     * Used by E2E tests in beforeEach to reliably reach a clean state without
     * depending on Ctrl+C being forwarded by the WebDriver bridge.
     */
    w.__psforge_terminal_reset_input = () => {
      if (cancelled) return;
      inputBufferRef.current = "";
      cursorPosRef.current = 0;
      tabCompletionRef.current = null;
      missingCommandRef.current = null;
      historyIdxRef.current = -1;
      term.write("\r\n");
      writePrompt();
    };

    // Initial session start.
    startSession(true);

    // ---- Prompt helper ----
    // Writes the PS prompt using the most recently received CWD.  Called after
    // each terminal-done, Ctrl+C, Ctrl+L, empty-enter, and exec error.
    const writePrompt = () => {
      const dir = cwdRef.current;
      if (dir) {
        term.write(`PS \x1b[33m${dir}\x1b[0m\x1b[36m>\x1b[0m `);
      } else {
        term.write("PS\x1b[36m>\x1b[0m ");
      }
    };

    /**
     * Looks up installable modules for a missing command and prints actionable
     * hints below the current prompt.
     */
    const writeMissingCommandHint = async (commandName: string) => {
      const key = commandName.trim().toLowerCase();
      if (!key || hintedMissingCommandsRef.current.has(key)) return;

      const psPath = shellPathRef.current;
      if (!psPath) return;

      const suggestions = await cmd
        .suggestModulesForCommand(psPath, commandName)
        .catch(() => []);
      if (
        cancelled ||
        isStoppingRef.current ||
        suggestions.length === 0 ||
        inputBufferRef.current.length > 0 ||
        cursorPosRef.current > 0
      ) {
        return;
      }

      const top = suggestions.slice(0, 3);
      const names = top.map((s) => s.name).join(", ");
      term.write(
        `\r\n\x1b[2m[Hint] '${commandName}' may be available in module${top.length > 1 ? "s" : ""}: ${names}\x1b[0m\r\n`,
      );
      for (const suggestion of top) {
        const repo = suggestion.repository
          ? ` (${suggestion.repository})`
          : "";
        term.write(
          `\x1b[2m  ${suggestion.installCommand}${repo}\x1b[0m\r\n`,
        );
      }
      hintedMissingCommandsRef.current.add(key);
      writePrompt();
    };

    // ---- Tauri event listeners ----

    // A line of stdout from the running command.
    const unlistenOutput = listen<string>("terminal-output", (event) => {
      // Normalise newlines for xterm (\r\n required for correct line breaks).
      term.write(event.payload.replace(/\r?\n/g, "\r\n") + "\r\n");
    });

    // A line of stderr from the running command -- shown in red.
    const unlistenStderr = listen<string>("terminal-stderr", (event) => {
      const missingCommand = extractMissingCommandName(event.payload);
      if (missingCommand) {
        missingCommandRef.current = missingCommand;
      }
      const line = event.payload.replace(/\r?\n/g, "\r\n");
      term.write(`\x1b[31m${line}\x1b[0m\r\n`);
    });

    // CWD update: emitted by REPL before every terminal-done.  Updating cwdRef
    // here (before terminal-done fires) ensures writePrompt() reads the fresh
    // directory for the very next prompt.
    // On session startup the REPL emits one CWD line before entering its read
    // loop.  pendingInitialPromptRef is set by startSession() and tells us to
    // write the first prompt here once the path is known.
    const unlistenCwd = listen<string>("terminal-cwd", (event) => {
      cwdRef.current = event.payload;
      if (pendingInitialPromptRef.current) {
        pendingInitialPromptRef.current = false;
        writePrompt();
      }
    });

    // Command completed -- show a new prompt and confirm the session works.
    const unlistenDone = listen<null>("terminal-done", () => {
      // Discard stale done events that were already buffered in the OS pipe
      // when the previous session was killed by start_terminal's internal
      // kill_session().  These arrive after settlingRef has been set to true
      // but before the new session's .then() fires -- without this guard they
      // write a second prompt onto the same line as the one the .then() just
      // wrote, producing the "PS C:\> PS C:\>" doubling the user sees.
      // Also discard if the session is being deliberately stopped.
      if (settlingRef.current || isStoppingRef.current) return;
      // Session has successfully executed at least one command: it is healthy.
      // Reset the restart counter so future exits get a full set of retries.
      restartAttemptsRef.current = 0;
      writePrompt();
      const missingCommand = missingCommandRef.current;
      missingCommandRef.current = null;
      if (missingCommand) {
        void writeMissingCommandHint(missingCommand);
      }
    });

    // The session process has exited.  Only auto-restart if the exit was NOT
    // caused by our own stopTerminal() call (isStoppingRef guards this), and
    // not during the settle window after a fresh startTerminal() call
    // (settlingRef guards the stale exit fired by start_terminal's internal
    // kill_session() when it replaces a previous session).
    const unlistenExit = listen<null>("terminal-exit", () => {
      // Guard BEFORE touching isReadyRef: stale exits (fired by start_terminal's
      // internal kill_session when it replaces a previous session) arrive during
      // the settle window and must not corrupt isReadyRef.current for the new
      // live session.  In React StrictMode the first effect run is cleaned up
      // immediately, its session killed, and a stale terminal-exit for that
      // killed session arrives while the second effect run's settle window is
      // active -- without this guard isReadyRef is permanently left as false
      // even though the second session is running normally.
      if (isStoppingRef.current || settlingRef.current) {
        // Deliberate stop or stale exit from the previous killed session.
        return;
      }
      isReadyRef.current = false;

      const attempt = restartAttemptsRef.current + 1;
      restartAttemptsRef.current = attempt;

      if (attempt > MAX_RESTART_ATTEMPTS) {
        term.write(
          `\r\n\x1b[31m[Session exited and could not be restarted after ${MAX_RESTART_ATTEMPTS} attempts. Check that PowerShell is installed and accessible.]\x1b[0m\r\n`,
        );
        return;
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 32000);
      term.write(
        `\r\n\x1b[33m[Session ended. Restarting in ${delayMs / 1000}s (attempt ${attempt}/${MAX_RESTART_ATTEMPTS})...]\x1b[0m\r\n`,
      );
      if (restartTimerRef.current !== null)
        clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (isStoppingRef.current) return; // component unmounted during delay
        term.write("\x1b[33m[Restarting session...]\x1b[0m\r\n");
        startSession(false);
      }, delayMs);
    });

    // ---- Keyboard input handling ----
    // xterm.js onData delivers multi-character strings on paste AND full VT
    // escape sequences for special keys (arrows, Home/End, Delete, etc.).
    // We need to parse escape sequences explicitly so their payload characters
    // (e.g. the '[' and 'D' from a left-arrow \x1b[D) are never appended to
    // the input buffer as visible text.

    /**
     * Atomically replaces the input line in the terminal with highlighted text
     * and positions the cursor at newCursor within that text.
     *
     * All VT sequences are accumulated into one string and issued in a single
     * term.write() call so xterm.js renders the transition in one pass with no
     * intermediate frames — this prevents the visible flash (cursor briefly at
     * position 0) that occurred when writes were issued sequentially.
     *
     * Visual-width arithmetic always uses RAW text lengths because ANSI escape
     * sequences produced by highlightPs are non-printing.
     */
    const setInputLine = (
      newText: string,
      newCursor: number,
      preserveTabCompletion = false,
    ) => {
      if (!preserveTabCompletion) {
        tabCompletionRef.current = null;
      }
      const currentPos = cursorPosRef.current;
      const currentText = inputBufferRef.current;
      let seq = "";
      // Move cursor back to the start of the input area.
      if (currentPos > 0) seq += `\x1b[${currentPos}D`;
      // Write highlighted text (or nothing if empty).
      if (newText.length > 0) seq += highlightPs(newText) + "\x1b[0m";
      // Erase any leftover characters when the new text is shorter.
      if (currentText.length > newText.length) {
        const extra = currentText.length - newText.length;
        seq += " ".repeat(extra) + `\x1b[${extra}D`;
      }
      // Reposition cursor within the new text.
      const charsBack = newText.length - newCursor;
      if (charsBack > 0) seq += `\x1b[${charsBack}D`;
      if (seq) term.write(seq);
      inputBufferRef.current = newText;
      cursorPosRef.current = newCursor;
    };

    /**
     * Returns the index of the start of the word to the left of `pos`.
     * Skips trailing whitespace then the preceding word (bash readline Alt+B /
     * Ctrl+Left semantics: word = run of non-space characters).
     */
    const wordLeft = (buf: string, pos: number): number => {
      let i = pos;
      while (i > 0 && buf[i - 1] === " ") i--; // skip whitespace
      while (i > 0 && buf[i - 1] !== " ") i--; // skip word
      return i;
    };

    /**
     * Returns the index of the end of the word to the right of `pos`.
     * Skips leading whitespace then the following word (bash readline Alt+F /
     * Ctrl+Right semantics).
     */
    const wordRight = (buf: string, pos: number): number => {
      let i = pos;
      while (i < buf.length && buf[i] === " ") i++; // skip whitespace
      while (i < buf.length && buf[i] !== " ") i++; // skip word
      return i;
    };

    /** Finds the start of the current PowerShell token ending at `pos`. */
    const completionTokenStart = (buf: string, pos: number): number => {
      let start = pos;
      while (start > 0 && !TOKEN_BOUNDARY_RE.test(buf[start - 1])) {
        start--;
      }
      return start;
    };

    /** Deduplicates completion text values while preserving source order. */
    const uniqueCompletionTexts = (
      items: Awaited<ReturnType<typeof cmd.getCompletions>>,
    ): string[] => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of items) {
        const text = item.completionText || "";
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
      }
      return out;
    };

    /** Applies a completion item from a cycle snapshot to the input buffer. */
    const applyCompletionCandidate = (
      cycle: TabCompletionCycle,
      nextIndex: number,
    ) => {
      const candidate = cycle.items[nextIndex];
      const nextText =
        cycle.seedInput.slice(0, cycle.tokenStart) +
        candidate +
        cycle.seedInput.slice(cycle.tokenEnd);
      const nextCursor = cycle.tokenStart + candidate.length;
      cycle.index = nextIndex;
      cycle.renderedInput = nextText;
      cycle.renderedCursor = nextCursor;
      setInputLine(nextText, nextCursor, true);
    };

    /** Handles terminal Tab completion via the existing get_completions API. */
    const triggerTabCompletion = async () => {
      const currentBuf = inputBufferRef.current;
      const currentPos = cursorPosRef.current;
      const existing = tabCompletionRef.current;
      if (
        existing &&
        currentBuf === existing.renderedInput &&
        currentPos === existing.renderedCursor &&
        existing.items.length > 0
      ) {
        const next = (existing.index + 1) % existing.items.length;
        applyCompletionCandidate(existing, next);
        return;
      }

      const psPath = shellPathRef.current;
      if (!psPath) return;

      const tokenStart = completionTokenStart(currentBuf, currentPos);
      const requestSeq = completionSeqRef.current + 1;
      completionSeqRef.current = requestSeq;
      const results = await cmd
        .getCompletions(psPath, currentBuf, currentPos)
        .catch(() => []);

      if (
        cancelled ||
        completionSeqRef.current !== requestSeq ||
        inputBufferRef.current !== currentBuf ||
        cursorPosRef.current !== currentPos
      ) {
        return;
      }

      const items = uniqueCompletionTexts(results);
      if (items.length === 0) {
        tabCompletionRef.current = null;
        return;
      }

      const cycle: TabCompletionCycle = {
        seedInput: currentBuf,
        tokenStart,
        tokenEnd: currentPos,
        items,
        index: -1,
        renderedInput: currentBuf,
        renderedCursor: currentPos,
      };
      tabCompletionRef.current = cycle;
      applyCompletionCandidate(cycle, 0);
    };

    /** Handles a fully-assembled VT escape sequence (e.g. "\x1b[A"). */
    const handleEscapeSequence = (seq: string) => {
      const buf = inputBufferRef.current;
      const pos = cursorPosRef.current;
      const hist = historyRef.current;

      switch (seq) {
        // Up arrow -- navigate to previous history entry.
        case "\x1b[A":
        case "\x1bOA": {
          if (hist.length === 0) return;
          const newIdx =
            historyIdxRef.current === -1
              ? hist.length - 1
              : Math.max(0, historyIdxRef.current - 1);
          historyIdxRef.current = newIdx;
          setInputLine(hist[newIdx], hist[newIdx].length);
          return;
        }
        // Down arrow -- navigate to next history entry (or blank new line).
        case "\x1b[B":
        case "\x1bOB": {
          if (historyIdxRef.current === -1) return;
          if (historyIdxRef.current >= hist.length - 1) {
            historyIdxRef.current = -1;
            setInputLine("", 0);
          } else {
            historyIdxRef.current++;
            const entry = hist[historyIdxRef.current];
            setInputLine(entry, entry.length);
          }
          return;
        }
        // Right arrow -- move cursor one character right.
        case "\x1b[C":
        case "\x1bOC":
          if (pos < buf.length) {
            cursorPosRef.current = pos + 1;
            term.write("\x1b[C");
          }
          return;
        // Left arrow -- move cursor one character left.
        case "\x1b[D":
        case "\x1bOD":
          if (pos > 0) {
            cursorPosRef.current = pos - 1;
            term.write("\x1b[D");
          }
          return;
        // Home -- move cursor to start of input.
        case "\x1b[H":
        case "\x1b[1~":
        case "\x1bOH":
          if (pos > 0) {
            term.write(`\x1b[${pos}D`);
            cursorPosRef.current = 0;
          }
          return;
        // End -- move cursor to end of input.
        case "\x1b[F":
        case "\x1b[4~":
        case "\x1bOF":
          if (pos < buf.length) {
            term.write(`\x1b[${buf.length - pos}C`);
            cursorPosRef.current = buf.length;
          }
          return;
        // Delete key -- delete character at cursor position.
        case "\x1b[3~": {
          if (pos < buf.length) {
            setInputLine(buf.slice(0, pos) + buf.slice(pos + 1), pos);
          }
          return;
        }
        // Ctrl+Right / Alt+F -- move one word right.
        case "\x1b[1;5C":
        case "\x1b[5C":
        case "\x1bf": {
          const newPos = wordRight(buf, pos);
          if (newPos !== pos) {
            term.write(`\x1b[${newPos - pos}C`);
            cursorPosRef.current = newPos;
          }
          return;
        }
        // Ctrl+Left / Alt+B -- move one word left.
        case "\x1b[1;5D":
        case "\x1b[5D":
        case "\x1bb": {
          const newPos = wordLeft(buf, pos);
          if (newPos !== pos) {
            term.write(`\x1b[${pos - newPos}D`);
            cursorPosRef.current = newPos;
          }
          return;
        }
        // Alt+D -- delete word forward (from cursor to end of next word).
        case "\x1bd": {
          const end = wordRight(buf, pos);
          if (end !== pos)
            setInputLine(buf.slice(0, pos) + buf.slice(end), pos);
          return;
        }
        // Alt+Backspace -- delete word backward (from cursor to start of prev word).
        case "\x1b\x7f": {
          const start = wordLeft(buf, pos);
          if (start !== pos)
            setInputLine(buf.slice(0, start) + buf.slice(pos), start);
          return;
        }
        // Unknown / unhandled sequences are silently discarded.
        default:
          return;
      }
    };

    term.onData((data: string) => {
      if (!isReadyRef.current) return;

      // Paste detection: key events always arrive one character at a time;
      // if more than one character arrives in a single callback it is a paste.
      // Process the entire chunk as a single buffer insertion rather than
      // running each byte through the per-character pipeline, which would call
      // setInputLine() once per character and produce visible triple-redraws.
      // Only the first logical line is accepted (text up to the first CR/LF);
      // multi-line pastes are truncated at the first newline.
      if (data.length > 1) {
        let pasteText = "";
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") break;
          // Keep printable characters and tab; discard all other control chars.
          if ((ch >= " " && ch !== "\x7f") || ch === "\t") pasteText += ch;
        }
        if (pasteText) {
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          const newBuf = buf.slice(0, pos) + pasteText + buf.slice(pos);
          setInputLine(newBuf, pos + pasteText.length);
        }
        return;
      }

      for (const ch of data) {
        // ── Escape sequence accumulation ──────────────────────────────────
        // When an ESC (\x1b) byte arrives, start collecting the sequence.
        // All subsequent characters belong to the sequence until a recognised
        // terminator is seen.  While accumulating, `continue` skips normal
        // character processing entirely so no escape payload bytes can leak
        // into the input buffer.
        if (escapeSeqRef.current.length > 0 || ch === "\x1b") {
          if (ch === "\x1b" && escapeSeqRef.current.length === 0) {
            escapeSeqRef.current = "\x1b";
            continue;
          }
          escapeSeqRef.current += ch;
          const seq = escapeSeqRef.current;

          // CSI sequences: \x1b[ param* terminator  (terminator = letter or '~')
          if (seq.startsWith("\x1b[")) {
            if (seq.length < 3) continue; // need at least one more character
            const last = seq[seq.length - 1];
            const terminated =
              (last >= "A" && last <= "Z") ||
              (last >= "a" && last <= "z") ||
              last === "~";
            if (terminated) {
              escapeSeqRef.current = "";
              handleEscapeSequence(seq);
            }
            continue;
          }
          // SS3 sequences: \x1bO followed by exactly one letter.
          if (seq.startsWith("\x1bO")) {
            if (seq.length < 3) continue;
            escapeSeqRef.current = "";
            handleEscapeSequence(seq);
            continue;
          }
          // Any other 2-character escape (e.g. \x1b followed by a letter or
          // \x1b\x7f for Alt+Backspace): route through handleEscapeSequence so
          // Alt+B, Alt+F, Alt+D, Alt+Backspace etc. are properly handled.
          // handleEscapeSequence's default case silently discards unknowns.
          if (seq.length >= 2) {
            escapeSeqRef.current = "";
            handleEscapeSequence(seq);
          }
          continue;
        }

        // ── Normal character processing ───────────────────────────────────
        if (ch === "\r" || ch === "\n") {
          // Enter / newline: submit the buffered command.
          const command = inputBufferRef.current;
          // If cursor is not at end, move it there visually before submitting.
          const charsToEnd = command.length - cursorPosRef.current;
          if (charsToEnd > 0) term.write(`\x1b[${charsToEnd}C`);
          inputBufferRef.current = "";
          cursorPosRef.current = 0;
          tabCompletionRef.current = null;
          term.write("\r\n");

          if (command.trim()) {
            missingCommandRef.current = null;
            // Add to history, deduplicating consecutive identical entries.
            const hist = historyRef.current;
            if (hist.length === 0 || hist[hist.length - 1] !== command) {
              hist.push(command);
              if (hist.length > 500) hist.shift();
            }
            historyIdxRef.current = -1;
            // Intercept clear/cls/Clear-Host: PowerShell's Clear-Host sets
            // $Host.UI.RawUI.CursorPosition which throws "The handle is
            // invalid" in a CREATE_NO_WINDOW (non-console) process.  Handle
            // purely on the frontend via xterm.clear() instead.
            const normalized = command.trim().toLowerCase();
            if (
              normalized === "clear" ||
              normalized === "cls" ||
              normalized === "clear-host"
            ) {
              term.clear();
              writePrompt();
            } else {
              cmd.terminalExec(command).catch((err: unknown) => {
                term.write(`\x1b[31m[Error: ${String(err)}]\x1b[0m\r\n`);
                writePrompt();
              });
            }
          } else {
            missingCommandRef.current = null;
            historyIdxRef.current = -1;
            // Empty line: just show a new prompt.
            writePrompt();
          }
          // After submitting, stop processing characters in this data chunk so
          // the rest of a pasted multi-line string does not leak into the buffer.
          break;
        } else if (ch === "\x7f") {
          // Backspace: erase the character immediately before the cursor.
          const pos = cursorPosRef.current;
          if (pos > 0) {
            const buf = inputBufferRef.current;
            setInputLine(buf.slice(0, pos - 1) + buf.slice(pos), pos - 1);
          }
        } else if (ch === "\x03") {
          // Ctrl+C: cancel current input.
          inputBufferRef.current = "";
          cursorPosRef.current = 0;
          tabCompletionRef.current = null;
          historyIdxRef.current = -1;
          term.write("^C\r\n");
          writePrompt();
        } else if (ch === "\x0c") {
          // Ctrl+L: clear screen, redraw prompt + current input (highlighted).
          term.clear();
          writePrompt();
          if (inputBufferRef.current) {
            term.write(highlightPs(inputBufferRef.current) + "\x1b[0m");
            const charsBack =
              inputBufferRef.current.length - cursorPosRef.current;
            if (charsBack > 0) term.write(`\x1b[${charsBack}D`);
          }
        } else if (ch === "\x01") {
          // Ctrl+A: select the typed input (not the prompt, not prior output).
          // Compute where the input starts on the current terminal row by
          // subtracting the cursor's offset within the buffer from the terminal's
          // current cursor column.  Then select exactly inputBuffer.length chars.
          const inputBuf = inputBufferRef.current;
          if (inputBuf.length > 0) {
            const active = term.buffer.active;
            const cursorCol = active.cursorX;
            const cursorRow = active.baseY + active.cursorY;
            const inputStartCol = cursorCol - cursorPosRef.current;
            term.select(inputStartCol, cursorRow, inputBuf.length);
          }
        } else if (ch === "\x02") {
          // Ctrl+B: move cursor one character left (readline).
          const pos = cursorPosRef.current;
          if (pos > 0) {
            cursorPosRef.current = pos - 1;
            term.write("\x1b[D");
          }
        } else if (ch === "\x04") {
          // Ctrl+D: forward-delete character at cursor; if buffer is empty,
          // treat as EOF (signals intent to close -- show notice but don't exit).
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          if (buf.length > 0) {
            if (pos < buf.length)
              setInputLine(buf.slice(0, pos) + buf.slice(pos + 1), pos);
          } else {
            term.write(
              "\r\n\x1b[2m[Ctrl+D received -- use `exit` to close the session]\x1b[0m\r\n",
            );
            writePrompt();
          }
        } else if (ch === "\x05") {
          // Ctrl+E: move cursor to end of line (readline).
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          if (pos < buf.length) {
            term.write(`\x1b[${buf.length - pos}C`);
            cursorPosRef.current = buf.length;
          }
        } else if (ch === "\x06") {
          // Ctrl+F: move cursor one character right (readline).
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          if (pos < buf.length) {
            cursorPosRef.current = pos + 1;
            term.write("\x1b[C");
          }
        } else if (ch === "\x0b") {
          // Ctrl+K: kill from cursor to end of line (readline).
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          if (pos < buf.length) setInputLine(buf.slice(0, pos), pos);
        } else if (ch === "\x0e") {
          // Ctrl+N: next history entry (same as Down arrow, readline).
          if (historyIdxRef.current === -1) {
            // nothing to do -- already on new line
          } else if (historyIdxRef.current >= historyRef.current.length - 1) {
            historyIdxRef.current = -1;
            setInputLine("", 0);
          } else {
            historyIdxRef.current++;
            const entry = historyRef.current[historyIdxRef.current];
            setInputLine(entry, entry.length);
          }
        } else if (ch === "\x10") {
          // Ctrl+P: previous history entry (same as Up arrow, readline).
          const hist = historyRef.current;
          if (hist.length > 0) {
            const newIdx =
              historyIdxRef.current === -1
                ? hist.length - 1
                : Math.max(0, historyIdxRef.current - 1);
            historyIdxRef.current = newIdx;
            setInputLine(hist[newIdx], hist[newIdx].length);
          }
        } else if (ch === "\x15") {
          // Ctrl+U: kill from cursor to start of line (readline).
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          if (pos > 0) setInputLine(buf.slice(pos), 0);
        } else if (ch === "\x17") {
          // Ctrl+W: delete word backward (bash / readline).
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          const start = wordLeft(buf, pos);
          if (start !== pos)
            setInputLine(buf.slice(0, start) + buf.slice(pos), start);
        } else if (ch === "\t") {
          // Tab: trigger PowerShell completion for the current token.
          void triggerTabCompletion();
        } else if (ch >= " ") {
          // Printable character: insert at cursor position then
          // re-render the whole input line with syntax highlighting.
          const pos = cursorPosRef.current;
          const buf = inputBufferRef.current;
          setInputLine(buf.slice(0, pos) + ch + buf.slice(pos), pos + 1);
        }
        // Remaining control characters (other than those handled above) are
        // silently discarded -- they must not appear in the input buffer.
      }
    });

    // ---- Window focus handler ----
    // When the OS window regains focus after being alt-tabbed away, the xterm
    // canvas blink timer is paused by the browser.  Re-arming cursorBlink
    // restarts the internal interval so the cursor blinks again immediately.
    const handleWindowFocus = () => {
      if (cancelled || !termRef.current) return;
      const t = termRef.current;
      t.options.cursorBlink = false;
      requestAnimationFrame(() => {
        if (!cancelled && termRef.current) t.options.cursorBlink = true;
      });
    };
    window.addEventListener("focus", handleWindowFocus);

    // ---- Resize handling ----

    let rafId = 0;
    const observer = new ResizeObserver(() => {
      // Debounce fits via rAF to avoid excessive reflows.
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => fitAddon.fit());
    });
    observer.observe(containerRef.current);

    // ---- Cleanup on unmount ----
    return () => {
      // Mark this effect run as cancelled so any in-flight startTerminal()
      // Promises from THIS run are silently discarded and cannot corrupt the
      // shared refs that the NEW effect run depends on.
      cancelled = true;
      // Remove window globals registered by this effect run.
      delete w.__psforge_terminal_clear;
      delete w.__psforge_terminal_focus;
      delete w.__psforge_terminal_restart;
      delete w.__psforge_terminal_get_content;
      delete w.__psforge_terminal_is_ready;
      delete w.__psforge_highlight_ps;
      delete w.__psforge_terminal_reset_input;
      delete w.__psforge_terminal_submit_current_input;
      // Signal that the next terminal-exit event is intentional so the
      // listener does not schedule an auto-restart.
      isStoppingRef.current = true;
      settlingRef.current = false; // cleanup: reject settling, isStoppingRef takes priority
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      window.removeEventListener("focus", handleWindowFocus);
      cancelAnimationFrame(rafId);
      observer.disconnect();
      if (restartTimerRef.current !== null) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      unlistenOutput.then((fn) => fn());
      unlistenStderr.then((fn) => fn());
      unlistenCwd.then((fn) => fn());
      unlistenDone.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      cmd.stopTerminal().catch(() => {});
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus xterm whenever the Terminal tab is made active.
  // This runs synchronously with React's paint cycle so WebView2 treats it
  // as a direct user-gesture path -- unlike focus() inside a Promise .then()
  // which is blocked by the browser's out-of-user-gesture focus policy.
  useEffect(() => {
    if (state.bottomPanelTab === "terminal" && termRef.current) {
      // Small rAF delay so the container has transitioned from display:none
      // to display:flex and has non-zero dimensions before xterm measures it.
      const id = requestAnimationFrame(() => {
        termRef.current?.focus();
        fitRef.current?.fit();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [state.bottomPanelTab]);

  // Update xterm font options when output font settings change without remounting.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontFamily = state.settings.outputFontFamily;
      termRef.current.options.fontSize = state.settings.outputFontSize;
      fitRef.current?.fit();
    }
  }, [state.settings.outputFontFamily, state.settings.outputFontSize]);

  // Update xterm theme colors when the application theme changes so the
  // terminal does not retain stale colors from the previously active theme.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = {
        background: cssVar("--bg-primary", "#1e1e1e"),
        foreground: cssVar("--text-primary", "#cccccc"),
        // Keep cursor white so it remains clearly visible after theme switches.
        cursor: "#ffffff",
        selectionBackground: cssVar("--accent", "#007acc"),
      };
    }
  }, [state.settings.theme]);

  return (
    <div
      data-testid="terminal-container"
      ref={containerRef}
      onClick={() => termRef.current?.focus()}
      style={{
        flex: 1,
        minHeight: 0,
        padding: "4px",
        boxSizing: "border-box",
      }}
    />
  );
}
