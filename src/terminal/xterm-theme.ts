/**
 * Map CSS custom properties (PSForge themes) to an xterm.js ITheme.
 */

import type { ITheme } from "@xterm/xterm";

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

/** Build an xterm theme from the active `data-theme` CSS variables. */
export function terminalThemeFromCss(): ITheme {
  return {
    background: cssVar("--terminal-bg", cssVar("--bg-primary", "#1e1e1e")),
    foreground: cssVar("--terminal-fg", cssVar("--text-primary", "#cccccc")),
    cursor: cssVar("--terminal-cursor", "#ffffff"),
    cursorAccent: cssVar("--terminal-cursor-accent", "#1e1e1e"),
    selectionBackground: cssVar(
      "--terminal-selection",
      "rgba(0, 122, 204, 0.35)",
    ),
    black: cssVar("--terminal-ansi-black", "#1e1e1e"),
    red: cssVar("--terminal-ansi-red", "#f44747"),
    green: cssVar("--terminal-ansi-green", "#4ec9b0"),
    yellow: cssVar("--terminal-ansi-yellow", "#dcdcaa"),
    blue: cssVar("--terminal-ansi-blue", "#569cd6"),
    magenta: cssVar("--terminal-ansi-magenta", "#c586c0"),
    cyan: cssVar("--terminal-ansi-cyan", "#4fc1ff"),
    white: cssVar("--terminal-ansi-white", "#d4d4d4"),
    brightBlack: cssVar("--terminal-ansi-bright-black", "#808080"),
    brightRed: cssVar("--terminal-ansi-bright-red", "#f44747"),
    brightGreen: cssVar("--terminal-ansi-bright-green", "#4ec9b0"),
    brightYellow: cssVar("--terminal-ansi-bright-yellow", "#dcdcaa"),
    brightBlue: cssVar("--terminal-ansi-bright-blue", "#569cd6"),
    brightMagenta: cssVar("--terminal-ansi-bright-magenta", "#c586c0"),
    brightCyan: cssVar("--terminal-ansi-bright-cyan", "#4fc1ff"),
    brightWhite: cssVar("--terminal-ansi-bright-white", "#ffffff"),
  };
}
