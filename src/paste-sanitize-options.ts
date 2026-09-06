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

