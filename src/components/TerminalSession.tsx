/**
 * React shell for one integrated console.
 *
 * All PTY lifecycle lives in `createConsoleSession`; this component only
 * mounts it, forwards prop changes, and exposes the imperative handle the
 * terminal pane drives.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  createConsoleSession,
  type ConsoleSession,
} from "../terminal/console-session";

export interface TerminalSessionHandle {
  /** Restart the PowerShell session (Clear button). */
  clear: () => void;
  /** Wipe the xterm buffer without killing the session (clear-on-run). */
  clearBuffer: () => void;
  exec: (command: string) => Promise<number | null>;
  focus: () => void;
  restart: () => void;
  getContent: (lineCount?: number) => string;
  /** Selected plain text in this console, or "" when nothing is selected. */
  getSelection: () => string;
  /** Register a reflow/eviction-safe marker at the current row as the
   *  "last run" output baseline (S3-13). */
  markRunStart: (command: string) => void;
  /** stdout/stderr from the last script run (prompt/command echo stripped). */
  getRunScriptOutput: () => string | null;
  /** Lines of output since the last markRunStart(), tracked via an xterm
   *  marker so it survives resize reflow and scrollback eviction. Returns
   *  null if no run has started or the baseline row was evicted. */
  getRunOutputLineCount: () => number | null;
  isReady: () => boolean;
  submitCurrentInput: () => void;
  resetInput: () => void;
  writeLocal: (text: string) => void;
  /** Paste text into the PTY (same path as terminal right-click paste). */
  pasteText: (text: string) => void;
}

export interface TerminalSessionProps {
  active: boolean;
  shellPath: string;
  loadProfile: boolean;
  fontFamily: string;
  fontSize: number;
  /** xterm colour theme (Windows Terminal scheme or PSForge CSS fallback). */
  theme: ITheme;
  startupCommand?: string;
}

export const TerminalSession = forwardRef<
  TerminalSessionHandle,
  TerminalSessionProps
>(function TerminalSession(
  {
    active,
    shellPath,
    loadProfile,
    fontFamily,
    fontSize,
    theme,
    startupCommand,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ConsoleSession | null>(null);

  // The session outlives every render, so it reads current props through refs
  // rather than closing over the values it was created with.
  const propsRef = useRef({ active, shellPath, loadProfile, startupCommand });
  propsRef.current = { active, shellPath, loadProfile, startupCommand };

  useImperativeHandle(
    ref,
    () => ({
      clear: () => sessionRef.current?.restart(),
      clearBuffer: () => sessionRef.current?.clearBuffer(),
      exec: (command: string) =>
        sessionRef.current?.exec(command) ??
        Promise.reject(new Error("Terminal session is unavailable.")),
      focus: () => sessionRef.current?.focus(),
      restart: () => sessionRef.current?.restart(),
      getContent: (lineCount?: number) =>
        sessionRef.current?.readers.getContent(lineCount) ?? "",
      getSelection: () => sessionRef.current?.readers.getSelection() ?? "",
      markRunStart: (command: string) =>
        sessionRef.current?.readers.markRunStart(command),
      getRunScriptOutput: () =>
        sessionRef.current?.readers.getRunScriptOutput() ?? null,
      getRunOutputLineCount: () =>
        sessionRef.current?.readers.getRunOutputLineCount() ?? null,
      isReady: () => sessionRef.current?.isReady() ?? false,
      submitCurrentInput: () => sessionRef.current?.queueInput("\r", true),
      resetInput: () => sessionRef.current?.queueInput("\u0003", true),
      writeLocal: (text: string) => sessionRef.current?.writeLocal(text),
      pasteText: (text: string) => sessionRef.current?.pasteText(text),
    }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const session = createConsoleSession(
      container,
      {
        cursorBlink: true,
        cursorStyle: "block",
        cursorInactiveStyle: "block",
        fontFamily,
        fontSize,
        theme,
      },
      {
        shellPath: () => propsRef.current.shellPath,
        loadProfile: () => propsRef.current.loadProfile,
        startupCommand: () => propsRef.current.startupCommand ?? "",
        isActive: () => propsRef.current.active,
      },
    );
    sessionRef.current = session;

    return () => {
      sessionRef.current = null;
      session.dispose();
    };
    // Appearance is applied by the effects below; re-creating the PTY when a
    // font or theme changes would kill the user's shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sessionRef.current?.applyFont(fontFamily, fontSize);
  }, [fontFamily, fontSize]);

  useEffect(() => {
    sessionRef.current?.applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    // Two frames: the newly shown console must finish flex layout before fit().
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => sessionRef.current?.syncActive());
    });
    return () => cancelAnimationFrame(outer);
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{
        backgroundColor: theme.background ?? "var(--bg-primary)",
        minHeight: 0,
      }}
    />
  );
});
