/** PSForge Integrated Terminal (multi-console + remote tabs). */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "xterm/css/xterm.css";
import { useAppState } from "../store";
import * as cmd from "../commands";

function highlightPs(text: string): string {
  const K = "\x1b[38;2;86;156;214m";
  const F = "\x1b[38;2;220;220;170m";
  const V = "\x1b[38;2;156;220;254m";
  const S = "\x1b[38;2;206;145;120m";
  const C = "\x1b[38;2;106;153;85m";
  const N = "\x1b[38;2;181;206;168m";
  const R = "\x1b[0m";

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
    if (text[i] === "#") {
      result += C + text.slice(i) + R;
      break;
    }
    if (text[i] === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j++;
      if (j < text.length) j++;
      result += S + text.slice(i, j) + R;
      i = j;
      continue;
    }
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
    if (text[i] === "-" && i + 1 < text.length && /[a-zA-Z]/.test(text[i + 1])) {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
      result += K + text.slice(i, j) + R;
      i = j;
      continue;
    }
    if (/\d/.test(text[i]) && (i === 0 || /\W/.test(text[i - 1]))) {
      let j = i;
      while (j < text.length && /[\d._xXa-fA-FoObBeE+-]/.test(text[j])) j++;
      result += N + text.slice(i, j) + R;
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) j++;
      while (j > i + 1 && text[j - 1] === "-") j--;
      const word = text.slice(i, j);
      if (KEYWORDS.has(word.toLowerCase())) {
        result += K + word + R;
      } else if (/^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z][a-zA-Z0-9]*)+$/.test(word)) {
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

const MISSING_COMMAND_RE =
  /The term ['"`]([^'"`\r\n]+)['"`] is not recognized as (?:the )?name of a cmdlet, function, script file, or (?:executable|operable) program\./gi;

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function quotePs(value: string): string {
  if (!/[\s'"`]/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

interface TerminalSessionHandle {
  clear: () => void;
  focus: () => void;
  restart: () => void;
  getContent: (lineCount?: number) => string;
  isReady: () => boolean;
  submitCurrentInput: () => void;
  resetInput: () => void;
}

interface TerminalSessionProps {
  active: boolean;
  shellPath: string;
  loadProfile: boolean;
  fontFamily: string;
  fontSize: number;
  startupCommand?: string;
}

const TerminalSession = forwardRef<TerminalSessionHandle, TerminalSessionProps>(
  function TerminalSession(
    { active, shellPath, loadProfile, fontFamily, fontSize, startupCommand },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);

    const isReadyRef = useRef(false);
    const isStoppingRef = useRef(false);
    const startInFlightRef = useRef(false);
    const sessionIdRef = useRef(0);

    const writeQueueRef = useRef("");
    const writeInFlightRef = useRef(false);
    const fitRafRef = useRef<number | null>(null);
    const outputTailRef = useRef("");
    const suggestedCommandsRef = useRef<Set<string>>(new Set());
    const suggestInFlightRef = useRef<Set<string>>(new Set());
    const startupSentForSessionRef = useRef(0);

    const shellPathRef = useRef(shellPath);
    const loadProfileRef = useRef(loadProfile);
    const startupCommandRef = useRef(startupCommand ?? "");
    shellPathRef.current = shellPath;
    loadProfileRef.current = loadProfile;
    startupCommandRef.current = startupCommand ?? "";

    const queueInputFnRef = useRef<
      ((data: string, allowWhenNotReady?: boolean) => void) | null
    >(null);
    const startSessionFnRef = useRef<((showBanner: boolean) => void) | null>(
      null,
    );
    const focusFnRef = useRef<(() => void) | null>(null);
    const clearFnRef = useRef<(() => void) | null>(null);
    const contentFnRef = useRef<((lineCount?: number) => string) | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        clear: () => clearFnRef.current?.(),
        focus: () => focusFnRef.current?.(),
        restart: () => startSessionFnRef.current?.(false),
        getContent: (lineCount?: number) => contentFnRef.current?.(lineCount) ?? "",
        isReady: () => isReadyRef.current,
        submitCurrentInput: () => queueInputFnRef.current?.("\r", true),
        resetInput: () => queueInputFnRef.current?.("\u0003", true),
      }),
      [],
    );

    useEffect(() => {
      if (!containerRef.current) return;

      isStoppingRef.current = false;
      let cancelled = false;

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        cursorInactiveStyle: "block",
        scrollback: 10_000,
        fontFamily,
        fontSize,
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
      termRef.current = term;
      fitRef.current = fitAddon;

      const safeFit = () => {
        const host = containerRef.current;
        if (cancelled || !host || !host.isConnected) return;
        if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
        try {
          fitAddon.fit();
        } catch {
          // best effort
        }
      };

      const scheduleFit = () => {
        if (fitRafRef.current !== null) cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = requestAnimationFrame(() => {
          fitRafRef.current = null;
          safeFit();
        });
      };

      const syncSizeToBackend = () => {
        if (!isReadyRef.current || sessionIdRef.current <= 0) return;
        const cols = Math.max(term.cols || 120, 1);
        const rows = Math.max(term.rows || 30, 1);
        void cmd.terminalResize(sessionIdRef.current, cols, rows).catch(() => {});
      };

      const flushWriteQueue = (allowWhenNotReady = false) => {
        if (!allowWhenNotReady && !isReadyRef.current) return;
        if (writeInFlightRef.current || sessionIdRef.current <= 0) return;
        const chunk = writeQueueRef.current;
        if (!chunk) return;

        writeQueueRef.current = "";
        writeInFlightRef.current = true;
        const sid = sessionIdRef.current;
        void cmd
          .terminalWrite(sid, chunk)
          .catch((err: unknown) => {
            term.write(
              `\r\n\x1b[31m[Terminal write failed: ${String(err)}]\x1b[0m\r\n`,
            );
          })
          .finally(() => {
            writeInFlightRef.current = false;
            flushWriteQueue();
          });
      };

      const queueInput = (data: string, allowWhenNotReady = false) => {
        if (cancelled || isStoppingRef.current) return;
        if (!allowWhenNotReady && !isReadyRef.current) return;
        writeQueueRef.current += data;
        flushWriteQueue(allowWhenNotReady);
      };

      const focusTerminal = () => {
        scheduleFit();
        term.focus();
        syncSizeToBackend();
      };

      const startSession = async (showBanner: boolean) => {
        if (startInFlightRef.current) return;
        startInFlightRef.current = true;
        isReadyRef.current = false;
        writeQueueRef.current = "";
        writeInFlightRef.current = false;
        outputTailRef.current = "";
        suggestedCommandsRef.current.clear();
        suggestInFlightRef.current.clear();

        const existing = sessionIdRef.current;
        if (existing > 0) {
          await cmd.stopTerminal(existing).catch(() => {});
          sessionIdRef.current = 0;
        }

        const cols = Math.max(term.cols || 120, 1);
        const rows = Math.max(term.rows || 30, 1);

        try {
          const sid = await cmd.startTerminal(
            shellPathRef.current || "",
            cols,
            rows,
            loadProfileRef.current,
          );
          if (cancelled) return;
          sessionIdRef.current = sid;
          isReadyRef.current = true;
          flushWriteQueue();

          const initRow = term.buffer.active.cursorY + 1;
          const initCol = term.buffer.active.cursorX + 1;
          queueInput(`\x1b[${initRow};${initCol}R`, true);

          if (showBanner) {
            term.write("\x1b[1;36mPSForge Terminal\x1b[0m\r\n");
            term.write("PTY host active (ConPTY on Windows).\r\n\r\n");
          }

          if (startupCommandRef.current.trim()) {
            if (startupSentForSessionRef.current !== sid) {
              startupSentForSessionRef.current = sid;
              queueInput(`${startupCommandRef.current.trim()}\r`, true);
            }
          }

          syncSizeToBackend();
          if (active) focusTerminal();
        } catch (err: unknown) {
          if (!cancelled) {
            term.write(
              `\r\n\x1b[1;31m[Failed to start terminal: ${String(err)}]\x1b[0m\r\n`,
            );
          }
        } finally {
          startInFlightRef.current = false;
        }
      };

      queueInputFnRef.current = queueInput;
      startSessionFnRef.current = (showBanner: boolean) => {
        void startSession(showBanner);
      };
      focusFnRef.current = focusTerminal;
      clearFnRef.current = () => term.clear();
      contentFnRef.current = (lineCount?: number) => {
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

      const dataDisposable = term.onData((data) => queueInput(data));
      const resizeDisposable = term.onResize(({ cols, rows }) => {
        if (!isReadyRef.current || sessionIdRef.current <= 0) return;
        void cmd.terminalResize(sessionIdRef.current, cols, rows).catch(() => {});
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

      const onTerminalOutput = (event: { payload: TerminalOutputEvent }) => {
        if (event.payload.sessionId !== sessionIdRef.current) return;
        const chunk = event.payload.data;
        term.write(chunk);

        const psPath = shellPathRef.current;
        if (psPath) {
          const plainChunk = stripAnsi(chunk);
          outputTailRef.current = (outputTailRef.current + plainChunk).slice(-12000);
          const tail = outputTailRef.current;
          MISSING_COMMAND_RE.lastIndex = 0;

          let m: RegExpExecArray | null;
          while ((m = MISSING_COMMAND_RE.exec(tail)) !== null) {
            const commandName = m[1]?.trim();
            if (!commandName || /\s/.test(commandName)) continue;
            const key = commandName.toLowerCase();
            if (
              suggestedCommandsRef.current.has(key) ||
              suggestInFlightRef.current.has(key)
            ) {
              continue;
            }

            suggestInFlightRef.current.add(key);
            const sid = sessionIdRef.current;
            void cmd
              .suggestModulesForCommand(psPath, commandName)
              .then((suggestions) => {
                if (cancelled || sessionIdRef.current !== sid || !suggestions.length) {
                  return;
                }
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

        if (chunk.includes("\x1b[6n")) {
          const row = term.buffer.active.cursorY + 1;
          const col = term.buffer.active.cursorX + 1;
          queueInput(`\x1b[${row};${col}R`, true);
        }
      };

      const onTerminalExit = (event: { payload: TerminalExitEvent }) => {
        if (event.payload.sessionId !== sessionIdRef.current) return;
        isReadyRef.current = false;
        if (isStoppingRef.current) return;
        term.write(
          "\r\n\x1b[33m[Terminal session ended. Use Restart to start a new shell.]\x1b[0m\r\n",
        );
      };

      let unlistenOutput: UnlistenFn | null = null;
      let unlistenExit: UnlistenFn | null = null;
      void Promise.all([
        listen<TerminalOutputEvent>("terminal-output", onTerminalOutput),
        listen<TerminalExitEvent>("terminal-exit", onTerminalExit),
      ])
        .then(([outFn, exitFn]) => {
          if (cancelled) {
            outFn();
            exitFn();
            return;
          }
          unlistenOutput = outFn;
          unlistenExit = exitFn;
          void startSession(true);
        })
        .catch((err: unknown) => {
          term.write(
            `\r\n\x1b[1;31m[Failed to attach terminal listeners: ${String(err)}]\x1b[0m\r\n`,
          );
        });

      scheduleFit();

      return () => {
        cancelled = true;
        isStoppingRef.current = true;
        isReadyRef.current = false;

        unlistenOutput?.();
        unlistenExit?.();
        window.removeEventListener("resize", onWindowResize);
        resizeObserver.disconnect();
        dataDisposable.dispose();
        resizeDisposable.dispose();

        if (fitRafRef.current !== null) {
          cancelAnimationFrame(fitRafRef.current);
          fitRafRef.current = null;
        }

        queueInputFnRef.current = null;
        startSessionFnRef.current = null;
        focusFnRef.current = null;
        clearFnRef.current = null;
        contentFnRef.current = null;

        const sid = sessionIdRef.current;
        sessionIdRef.current = 0;
        if (sid > 0) {
          void cmd.stopTerminal(sid).catch(() => {});
        }
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      term.options.fontFamily = fontFamily;
      term.options.fontSize = fontSize;
      try {
        fitRef.current?.fit();
      } catch {
        // best effort
      }
      if (isReadyRef.current && sessionIdRef.current > 0) {
        const cols = Math.max(term.cols || 120, 1);
        const rows = Math.max(term.rows || 30, 1);
        void cmd.terminalResize(sessionIdRef.current, cols, rows).catch(() => {});
      }
    }, [fontFamily, fontSize]);

    useEffect(() => {
      if (!active || !termRef.current) return;
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // best effort
        }
        termRef.current?.focus();
        if (isReadyRef.current && sessionIdRef.current > 0 && termRef.current) {
          const cols = Math.max(termRef.current.cols || 120, 1);
          const rows = Math.max(termRef.current.rows || 30, 1);
          void cmd.terminalResize(sessionIdRef.current, cols, rows).catch(() => {});
        }
      });
    }, [active]);

    return (
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ backgroundColor: "var(--bg-primary)", minHeight: 0 }}
      />
    );
  },
);

interface ConsoleTabModel {
  id: string;
  title: string;
  shellPath: string;
  loadProfile: boolean;
  startupCommand?: string;
}

export function TerminalPane() {
  const { state } = useAppState();
  const tabCounterRef = useRef(1);
  const sessionRefs = useRef<Record<string, TerminalSessionHandle | null>>({});
  const [tabs, setTabs] = useState<ConsoleTabModel[]>(() => [
    {
      id: "console-1",
      title: "Console 1",
      shellPath: state.selectedPsPath || "",
      loadProfile: state.settings.terminalLoadProfile === true,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState("console-1");

  const getActiveHandle = () => sessionRefs.current[activeTabId] ?? null;

  const addLocalTab = () => {
    tabCounterRef.current += 1;
    const id = `console-${tabCounterRef.current}`;
    const tab: ConsoleTabModel = {
      id,
      title: `Console ${tabCounterRef.current}`,
      shellPath: state.selectedPsPath || "",
      loadProfile: state.settings.terminalLoadProfile === true,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  };

  const addRemoteTab = () => {
    const targetRaw = window.prompt(
      "Remote target for Enter-PSSession -ComputerName:",
      "",
    );
    const target = targetRaw?.trim() ?? "";
    if (!target) return;

    tabCounterRef.current += 1;
    const id = `console-${tabCounterRef.current}`;
    const tab: ConsoleTabModel = {
      id,
      title: `Remote: ${target}`,
      shellPath: state.selectedPsPath || "",
      loadProfile: state.settings.terminalLoadProfile === true,
      startupCommand: `Enter-PSSession -ComputerName ${quotePs(target)}`,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  };

  const closeTab = (id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const index = prev.findIndex((tab) => tab.id === id);
      if (index === -1) return prev;
      const next = prev.filter((tab) => tab.id !== id);
      if (activeTabId === id) {
        const fallback = next[Math.min(index, next.length - 1)];
        if (fallback) setActiveTabId(fallback.id);
      }
      delete sessionRefs.current[id];
      return next;
    });
  };

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_terminal_clear = () => getActiveHandle()?.clear();
    w.__psforge_terminal_focus = () => getActiveHandle()?.focus();
    w.__psforge_terminal_restart = () => getActiveHandle()?.restart();
    w.__psforge_terminal_get_content = (lineCount?: number) =>
      getActiveHandle()?.getContent(lineCount as number | undefined) ?? "";
    w.__psforge_terminal_is_ready = () => getActiveHandle()?.isReady() ?? false;
    w.__psforge_terminal_submit_current_input = () =>
      getActiveHandle()?.submitCurrentInput();
    w.__psforge_terminal_reset_input = () => getActiveHandle()?.resetInput();
    w.__psforge_highlight_ps = highlightPs;
    return () => {
      delete w.__psforge_terminal_clear;
      delete w.__psforge_terminal_focus;
      delete w.__psforge_terminal_restart;
      delete w.__psforge_terminal_get_content;
      delete w.__psforge_terminal_is_ready;
      delete w.__psforge_terminal_submit_current_input;
      delete w.__psforge_terminal_reset_input;
      delete w.__psforge_highlight_ps;
    };
  }, [activeTabId]);

  useEffect(() => {
    if (state.bottomPanelTab !== "terminal") return;
    requestAnimationFrame(() => {
      getActiveHandle()?.focus();
    });
  }, [state.bottomPanelTab, activeTabId]);

  return (
    <div className="flex flex-col h-full" data-testid="terminal-multi-root">
      <div
        className="flex items-center gap-2 px-2 py-1"
        style={{
          borderBottom: "1px solid var(--border-primary)",
          backgroundColor: "var(--bg-secondary)",
        }}
      >
        <div className="flex items-center gap-1 flex-1 overflow-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className="flex items-center"
                style={{
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--border-primary)"}`,
                  borderRadius: "3px",
                  backgroundColor: isActive ? "var(--bg-hover)" : "transparent",
                }}
              >
                <button
                  onClick={() => setActiveTabId(tab.id)}
                  style={{
                    backgroundColor: "transparent",
                    color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                    padding: "2px 8px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tab.title}
                </button>
                {tabs.length > 1 && (
                  <button
                    onClick={() => closeTab(tab.id)}
                    style={{
                      backgroundColor: "transparent",
                      color: "var(--text-muted)",
                      padding: "2px 6px",
                    }}
                    title="Close console tab"
                  >
                    x
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <button
          onClick={addLocalTab}
          style={{ backgroundColor: "transparent", color: "var(--text-secondary)" }}
          title="New local console tab"
        >
          + Local
        </button>
        <button
          onClick={addRemoteTab}
          style={{ backgroundColor: "transparent", color: "var(--text-secondary)" }}
          title="New remote console tab (Enter-PSSession)"
        >
          + Remote
        </button>
        <button
          onClick={() => getActiveHandle()?.clear()}
          style={{ backgroundColor: "transparent", color: "var(--text-secondary)" }}
          title="Clear active console"
        >
          Clear
        </button>
        <button
          onClick={() => getActiveHandle()?.restart()}
          style={{ backgroundColor: "transparent", color: "var(--text-secondary)" }}
          title="Restart active console"
        >
          Restart
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              display: tab.id === activeTabId ? "flex" : "none",
              width: "100%",
              height: "100%",
            }}
          >
            <TerminalSession
              ref={(instance) => {
                sessionRefs.current[tab.id] = instance;
              }}
              active={tab.id === activeTabId}
              shellPath={tab.shellPath}
              loadProfile={tab.loadProfile}
              startupCommand={tab.startupCommand}
              fontFamily={
                state.settings.outputFontFamily ?? "Cascadia Code, Consolas, monospace"
              }
              fontSize={state.settings.outputFontSize ?? 13}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
