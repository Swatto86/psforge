import type { AppSettings } from "./types";

/** Options for cleaning text pasted from the web, Teams, or terminal captures. */
export interface PasteSanitizeOptions {
  /** Replace curly quotes, em dashes, NBSP, and zero-width characters. */
  fixTypography: boolean;
  /** Strip markdown ``` fences (optional language tag on first line). */
  stripMarkdownFences: boolean;
  /** Remove leading `12 |` or `12:` line-number gutters from blog snippets. */
  stripLineNumberGutters: boolean;
  /** Remove `PS>` / `PS C:\path>` / `>>` prompt prefixes per line. */
  stripPromptPrefixes: boolean;
  /** Normalize CRLF/CR to LF. */
  normalizeNewlines: boolean;
  /** Remove ASCII control characters except tab and newline. */
  stripControlChars: boolean;
}

/** Full cleanup used by Paste Clean + Format and when paste sanitization is enabled. */
export const FULL_PASTE_SANITIZE_OPTIONS: PasteSanitizeOptions = {
  fixTypography: true,
  stripMarkdownFences: true,
  stripLineNumberGutters: true,
  stripPromptPrefixes: true,
  normalizeNewlines: true,
  stripControlChars: true,
};

export function pasteSanitizeOptionsFromSettings(
  settings: AppSettings,
): PasteSanitizeOptions {
  const enabled = settings.sanitizePasteOnPaste !== false;
  return enabled
    ? FULL_PASTE_SANITIZE_OPTIONS
    : {
        fixTypography: false,
        stripMarkdownFences: false,
        stripLineNumberGutters: false,
        stripPromptPrefixes: false,
        normalizeNewlines: false,
        stripControlChars: false,
      };
}

/// Substitutions for "smart" typographic characters that Word, Teams, and
/// many web pages introduce when copying text. PowerShell's parser rejects
/// curly quotes and en/em dashes, so pastes from those sources fail to run
/// until manually cleaned.
const SUBSTITUTIONS: ReadonlyArray<readonly [number, string]> = [
  [0x2018, "'"],
  [0x2019, "'"],
  [0x201a, "'"],
  [0x201b, "'"],
  [0x2032, "'"],
  [0x201c, '"'],
  [0x201d, '"'],
  [0x201e, '"'],
  [0x201f, '"'],
  [0x2033, '"'],
  [0x2013, "-"],
  [0x2014, "-"],
  [0x2015, "-"],
  [0x2212, "-"],
  [0x2026, "..."],
  [0x00a0, " "],
  [0x202f, " "],
  [0x2007, " "],
  [0x200b, ""],
  [0x200c, ""],
  [0x200d, ""],
  [0xfeff, ""],
];

const REPLACEMENTS: Record<string, string> = Object.fromEntries(
  SUBSTITUTIONS.map(([cp, replacement]) => [
    String.fromCharCode(cp),
    replacement,
  ]),
);
const TYPOGRAPHY_PATTERN = new RegExp(
  `[${SUBSTITUTIONS.map(([cp]) => `\\u${cp.toString(16).padStart(4, "0")}`).join("")}]`,
  "g",
);

const MARKDOWN_FENCE_RE =
  /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```[\s]*$/;
const LINE_NUMBER_GUTTER_RE = /^\s*\d{1,5}\s*[|:]\s?/;
const PROMPT_PREFIX_RE =
  /^(?:PS(?:\s+[^\r\n>]+)?>\s*|>>\s*)/i;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function fixTypography(input: string): string {
  return input.replace(TYPOGRAPHY_PATTERN, (ch) => REPLACEMENTS[ch] ?? ch);
}

function stripMarkdownFences(input: string): string {
  const trimmed = input.trim();
  const match = MARKDOWN_FENCE_RE.exec(trimmed);
  return match ? match[1].trimEnd() : input;
}

function stripLineNumberGutters(input: string): string {
  return input
    .split("\n")
    .map((line) => line.replace(LINE_NUMBER_GUTTER_RE, ""))
    .join("\n");
}

function stripPromptPrefixes(input: string): string {
  return input
    .split("\n")
    .map((line) => line.replace(PROMPT_PREFIX_RE, ""))
    .join("\n");
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripControlChars(input: string): string {
  return input.replace(CONTROL_CHAR_RE, "");
}

/**
 * Cleans clipboard or paste buffer text for PowerShell editing.
 * When `options` is omitted, only typographic character fixes run (legacy behavior).
 */
export function sanitizePastedText(
  input: string,
  options?: Partial<PasteSanitizeOptions>,
): string {
  const opts: PasteSanitizeOptions = {
    ...FULL_PASTE_SANITIZE_OPTIONS,
    ...options,
  };

  let text = input;
  if (opts.normalizeNewlines) {
    text = normalizeNewlines(text);
  }
  if (opts.stripControlChars) {
    text = stripControlChars(text);
  }
  if (opts.stripMarkdownFences) {
    text = stripMarkdownFences(text);
  }
  if (opts.stripLineNumberGutters) {
    text = stripLineNumberGutters(text);
  }
  if (opts.stripPromptPrefixes) {
    text = stripPromptPrefixes(text);
  }
  if (opts.fixTypography) {
    text = fixTypography(text);
  }
  return text;
}
