import type { AppSettings } from "./types";

/** Options for cleaning text pasted from the web, Teams, or terminal captures. */
export interface PasteSanitizeOptions {
  /** Replace curly quotes, em dashes, NBSP, and zero-width characters. */
  fixTypography: boolean;
  /** Strip markdown ``` fences (optional language tag on first line). */
  stripMarkdownFences: boolean;
  /** Pull script bodies out of ```powershell blocks embedded in chat prose. */
  extractEmbeddedFences: boolean;
  /** Drop common AI intro/outro lines before and after code. */
  stripProseWrappers: boolean;
  /** Remove leading `12 |` or `12:` line-number gutters from blog snippets. */
  stripLineNumberGutters: boolean;
  /** Remove `PS>` / `PS C:\path>` / `>>` prompt prefixes per line. */
  stripPromptPrefixes: boolean;
  /** Normalize CRLF/CR to LF. */
  normalizeNewlines: boolean;
  /** Remove ASCII control characters except tab and newline. */
  stripControlChars: boolean;
  /** Strip simple HTML tags often copied from docs pages. */
  stripSimpleHtml: boolean;
}

/** Full cleanup used by Paste Clean + Format and when paste sanitization is enabled. */
export const FULL_PASTE_SANITIZE_OPTIONS: PasteSanitizeOptions = {
  fixTypography: true,
  stripMarkdownFences: true,
  extractEmbeddedFences: true,
  stripProseWrappers: true,
  stripLineNumberGutters: true,
  stripPromptPrefixes: true,
  normalizeNewlines: true,
  stripControlChars: true,
  stripSimpleHtml: true,
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
        extractEmbeddedFences: false,
        stripProseWrappers: false,
        stripLineNumberGutters: false,
        stripPromptPrefixes: false,
        normalizeNewlines: false,
        stripControlChars: false,
        stripSimpleHtml: false,
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
  /^\s*```[\w.#+-]*\r?\n([\s\S]*?)\r?\n```[\s]*$/;
const EMBEDDED_FENCE_RE = /```([\w.#+-]*)\r?\n([\s\S]*?)```/g;
const PS_FENCE_LANG_RE = /^(?:powershell|ps1|ps|pwsh|psm1)$/i;
const LINE_NUMBER_GUTTER_RE = /^\s*\d{1,5}\s*[|:]\s?/;
const PROMPT_PREFIX_RE =
  /^(?:PS(?:\s+[^\r\n>]+)?>\s*|>>\s*)/i;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const SIMPLE_HTML_RE =
  /<\/?(?:pre|code|div|span|p|br)\b[^>]*>|<br\s*\/?>/gi;

/** Lines that look like AI/chat preamble or epilogue, not PowerShell. */
const PROSE_LINE_RE =
  /^(?:\*{0,2}\s*)?(?:here(?:'s| is)|below (?:is|are)|copy(?: and)? (?:paste|the)|paste (?:this|the)|run (?:this|the following)?|the (?:following )?(?:script|code|powershell)|use (?:this|the following)|i(?:'ve| have) (?:written|provided|included)|note:|warning:|tip:|usage:|expected (?:output|result):)/i;

function fixTypography(input: string): string {
  return input.replace(TYPOGRAPHY_PATTERN, (ch) => REPLACEMENTS[ch] ?? ch);
}

function stripSimpleHtml(input: string): string {
  return input.replace(SIMPLE_HTML_RE, (tag) =>
    /^<br\b/i.test(tag) ? "\n" : "",
  );
}

function stripMarkdownFences(input: string): string {
  const trimmed = input.trim();
  const match = MARKDOWN_FENCE_RE.exec(trimmed);
  return match ? match[1].trimEnd() : input;
}

function extractEmbeddedMarkdownFences(input: string): string {
  const blocks: { lang: string; body: string }[] = [];
  for (const match of input.matchAll(EMBEDDED_FENCE_RE)) {
    blocks.push({
      lang: (match[1] ?? "").trim(),
      body: match[2] ?? "",
    });
  }
  if (blocks.length === 0) return input;

  const psBlock = blocks.find((b) => PS_FENCE_LANG_RE.test(b.lang));
  if (psBlock) return psBlock.body.trimEnd();

  const longest = blocks.reduce((best, current) =>
    current.body.length > best.body.length ? current : best,
  );
  return longest.body.trimEnd();
}

function stripProseWrappers(input: string): string {
  const lines = input.split("\n");
  let start = 0;
  let end = lines.length;

  while (start < end) {
    const line = lines[start]?.trim() ?? "";
    if (!line) {
      start++;
      continue;
    }
    if (PROSE_LINE_RE.test(line)) {
      start++;
      continue;
    }
    break;
  }

  while (end > start) {
    const line = lines[end - 1]?.trim() ?? "";
    if (!line) {
      end--;
      continue;
    }
    if (PROSE_LINE_RE.test(line)) {
      end--;
      continue;
    }
    break;
  }

  return lines.slice(start, end).join("\n");
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
  if (opts.stripSimpleHtml) {
    text = stripSimpleHtml(text);
  }
  if (opts.extractEmbeddedFences) {
    text = extractEmbeddedMarkdownFences(text);
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
  if (opts.stripProseWrappers) {
    text = stripProseWrappers(text);
  }
  if (opts.fixTypography) {
    text = fixTypography(text);
  }
  return text;
}
