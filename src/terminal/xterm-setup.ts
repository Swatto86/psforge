/**
 * Shared xterm.js setup: WebGL renderer (with safe fallback), fit, and web links.
 */

import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

export type TerminalPerformanceAddons = {
  fit: FitAddon;
  /** Present when WebGL2 initialized; disposed on context loss or teardown. */
  webgl: WebglAddon | null;
  dispose: () => void;
};

/** Defaults tuned for PTY streaming and fast wheel scrolling in a desktop IDE. */
export const TERMINAL_PERFORMANCE_OPTIONS: ITerminalOptions = {
  scrollback: 25_000,
  /** Hold Alt while scrolling to move through scrollback quickly. */
  fastScrollModifier: "alt",
  fastScrollSensitivity: 8,
  scrollSensitivity: 1,
  /** Instant scroll — avoids animation fighting high-throughput PTY output. */
  smoothScrollDuration: 0,
  /** Draw box-drawing / powerline glyph cells with the terminal font metrics. */
  customGlyphs: true,
  rescaleOverlappingGlyphs: true,
};

/**
 * Attempts to attach the WebGL2 renderer. Disabled by default: multiple xterm
 * WebGL contexts in Tauri/WebView2 on Windows can blank the entire webview
 * when a second integrated console tab is opened.
 */
export function tryLoadWebglAddon(_term: Terminal): WebglAddon | null {
  return null;
}

async function copyTerminalSelection(term: Terminal): Promise<boolean> {
  const text = term.getSelection();
  if (!text) return false;
  await navigator.clipboard.writeText(text);
  return true;
}

export function createTerminalWithAddons(
  container: HTMLElement,
  options: ITerminalOptions,
): { terminal: Terminal; addons: TerminalPerformanceAddons } {
  const fit = new FitAddon();
  const term = new Terminal({
    ...TERMINAL_PERFORMANCE_OPTIONS,
    ...options,
  });

  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(container);

  const webgl = tryLoadWebglAddon(term);

  // Classic console: right-click copies the selection when one exists,
  // otherwise pastes. App-wide contextmenu suppress means we own this path.
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (term.hasSelection()) {
      void copyTerminalSelection(term).catch(() => {});
      return;
    }
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) term.paste(text);
      })
      .catch(() => {});
  };
  container.addEventListener("contextmenu", onContextMenu);

  // Ctrl+Shift+C copies the selection (Windows Terminal / xterm convention).
  // Ctrl+C alone stays interrupt when there is no selection.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    if (!(ev.ctrlKey && ev.shiftKey) || ev.altKey || ev.metaKey) return true;
    if (ev.key.toLowerCase() !== "c") return true;
    if (!term.hasSelection()) return true;
    void copyTerminalSelection(term).catch(() => {});
    return false;
  });

  return {
    terminal: term,
    addons: {
      fit,
      webgl,
      dispose: () => {
        container.removeEventListener("contextmenu", onContextMenu);
        webgl?.dispose();
        fit.dispose();
      },
    },
  };
}
