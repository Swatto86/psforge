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
};

/**
 * Attempts to attach the WebGL2 renderer. On failure or context loss, xterm.js
 * continues with its default canvas renderer.
 */
export function tryLoadWebglAddon(term: Terminal): WebglAddon | null {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
    });
    term.loadAddon(webgl);
    return webgl;
  } catch {
    return null;
  }
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

  return {
    terminal: term,
    addons: {
      fit,
      webgl,
      dispose: () => {
        webgl?.dispose();
        fit.dispose();
      },
    },
  };
}
