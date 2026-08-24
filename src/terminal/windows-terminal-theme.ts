/**
 * Parse Windows Terminal settings.json so PSForge consoles can match its
 * colour scheme and glyph-capable font face.
 */

import type { ITheme } from "@xterm/xterm";
import { MONOSPACE_EMOJI_FALLBACK } from "../font-presets";

/** One colour scheme entry from Terminal settings.schemes. */
export type WindowsTerminalScheme = {
  name: string;
  background: string;
  foreground: string;
  cursorColor?: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightPurple: string;
  brightCyan: string;
  brightWhite: string;
};

/** Resolved appearance from the default Terminal profile. */
export type WindowsTerminalAppearance = {
  colorSchemeName: string | null;
  fontFace: string | null;
  fontSize: number | null;
  scheme: WindowsTerminalScheme | null;
};

type WtProfile = {
  guid?: string;
  colorScheme?: string;
  font?: { face?: string; size?: number };
};

type WtSettings = {
  defaultProfile?: string;
  profiles?: {
    defaults?: WtProfile;
    list?: WtProfile[];
  };
  schemes?: WindowsTerminalScheme[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseScheme(raw: unknown): WindowsTerminalScheme | null {
  const o = asRecord(raw);
  if (!o) return null;
  const name = asString(o.name);
  const background = asString(o.background);
  const foreground = asString(o.foreground);
  const black = asString(o.black);
  const red = asString(o.red);
  const green = asString(o.green);
  const yellow = asString(o.yellow);
  const blue = asString(o.blue);
  const purple = asString(o.purple);
  const cyan = asString(o.cyan);
  const white = asString(o.white);
  const brightBlack = asString(o.brightBlack);
  const brightRed = asString(o.brightRed);
  const brightGreen = asString(o.brightGreen);
  const brightYellow = asString(o.brightYellow);
  const brightBlue = asString(o.brightBlue);
  const brightPurple = asString(o.brightPurple);
  const brightCyan = asString(o.brightCyan);
  const brightWhite = asString(o.brightWhite);
  if (
    !name ||
    !background ||
    !foreground ||
    !black ||
    !red ||
    !green ||
    !yellow ||
    !blue ||
    !purple ||
    !cyan ||
    !white ||
    !brightBlack ||
    !brightRed ||
    !brightGreen ||
    !brightYellow ||
    !brightBlue ||
    !brightPurple ||
    !brightCyan ||
    !brightWhite
  ) {
    return null;
  }
  return {
    name,
    background,
    foreground,
    cursorColor: asString(o.cursorColor) ?? undefined,
    selectionBackground: asString(o.selectionBackground) ?? undefined,
    black,
    red,
    green,
    yellow,
    blue,
    purple,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightPurple,
    brightCyan,
    brightWhite,
  };
}

function parseProfile(raw: unknown): WtProfile | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fontRaw = asRecord(o.font);
  return {
    guid: asString(o.guid) ?? undefined,
    colorScheme: asString(o.colorScheme) ?? undefined,
    font: fontRaw
      ? {
          face: asString(fontRaw.face) ?? undefined,
          size: asNumber(fontRaw.size) ?? undefined,
        }
      : undefined,
  };
}

/**
 * Parse Terminal settings JSON into the default profile's scheme and font.
 * Returns null when the JSON is invalid or empty.
 */
export function parseWindowsTerminalAppearance(
  jsonText: string,
): WindowsTerminalAppearance | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const settings = root as WtSettings;
  const defaults = parseProfile(settings.profiles?.defaults) ?? {};
  const defaultGuid = asString(settings.defaultProfile);
  const list = Array.isArray(settings.profiles?.list)
    ? settings.profiles.list
        .map(parseProfile)
        .filter((p): p is WtProfile => p !== null)
    : [];
  const listed =
    defaultGuid != null
      ? (list.find(
          (p) => p.guid?.toLowerCase() === defaultGuid.toLowerCase(),
        ) ?? {})
      : {};

  const colorSchemeName =
    listed.colorScheme ?? defaults.colorScheme ?? null;
  const fontFace = listed.font?.face ?? defaults.font?.face ?? null;
  const fontSize = listed.font?.size ?? defaults.font?.size ?? null;

  const schemes = Array.isArray(settings.schemes)
    ? settings.schemes
        .map(parseScheme)
        .filter((s): s is WindowsTerminalScheme => s !== null)
    : [];
  const scheme =
    colorSchemeName != null
      ? (schemes.find(
          (s) => s.name.toLowerCase() === colorSchemeName.toLowerCase(),
        ) ?? null)
      : null;

  return { colorSchemeName, fontFace, fontSize, scheme };
}

/** Map a Terminal scheme to an xterm.js theme (purple → magenta). */
export function windowsTerminalSchemeToXtermTheme(
  scheme: WindowsTerminalScheme,
): ITheme {
  return {
    background: scheme.background,
    foreground: scheme.foreground,
    cursor: scheme.cursorColor ?? scheme.foreground,
    cursorAccent: scheme.background,
    selectionBackground: scheme.selectionBackground ?? undefined,
    black: scheme.black,
    red: scheme.red,
    green: scheme.green,
    yellow: scheme.yellow,
    blue: scheme.blue,
    magenta: scheme.purple,
    cyan: scheme.cyan,
    white: scheme.white,
    brightBlack: scheme.brightBlack,
    brightRed: scheme.brightRed,
    brightGreen: scheme.brightGreen,
    brightYellow: scheme.brightYellow,
    brightBlue: scheme.brightBlue,
    brightMagenta: scheme.brightPurple,
    brightCyan: scheme.brightCyan,
    brightWhite: scheme.brightWhite,
  };
}

/**
 * Quote a Terminal font.face string for CSS `font-family`.
 * `"JetBrainsMono Nerd Font, Cascadia Code"` → quoted CSS stack + emoji fallbacks.
 */
export function cssFontFamilyFromWtFace(face: string): string {
  const parts = face
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((name) => {
      if (name.includes(" ") || name.toLowerCase().includes("nerd")) {
        return `'${name.replace(/'/g, "\\'")}'`;
      }
      return name;
    });
  if (parts.length === 0) {
    return `Cascadia Code, Consolas, ${MONOSPACE_EMOJI_FALLBACK}, monospace`;
  }
  return `${parts.join(", ")}, ${MONOSPACE_EMOJI_FALLBACK}, monospace`;
}

/** Preferred glyph-capable stack when Terminal settings are unavailable. */
export const GLYPH_TERMINAL_FONT_STACK = `'JetBrainsMono Nerd Font', 'CaskaydiaCove Nerd Font', 'CaskaydiaCove NF', 'Cascadia Code NF', Cascadia Code, Consolas, ${MONOSPACE_EMOJI_FALLBACK}, monospace`;

/** Prefer Terminal face, else a Nerd Font stack, else the settings value. */
export function resolveConsoleFontFamily(
  wtFace: string | null | undefined,
  settingsFont: string | null | undefined,
): string {
  if (wtFace && wtFace.trim() !== "") {
    return cssFontFamilyFromWtFace(wtFace);
  }
  const trimmed = settingsFont?.trim() ?? "";
  if (trimmed !== "") return trimmed;
  return GLYPH_TERMINAL_FONT_STACK;
}
