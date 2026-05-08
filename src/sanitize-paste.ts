/// Substitutions for "smart" typographic characters that Word, Teams, and
/// many web pages introduce when copying text. PowerShell's parser rejects
/// curly quotes and en/em dashes, so pastes from those sources fail to run
/// until manually cleaned. The list below is intentionally narrow: only
/// well-known typographic substitutes plus invisible/zero-width characters.
/// Genuine Unicode (paths, regex literals, log strings, comments) is left
/// untouched.
///
/// Codepoints are written as numeric escapes because several of these
/// characters (e.g. the space variants and zero-width chars) are
/// indistinguishable from ASCII at a glance.
const SUBSTITUTIONS: ReadonlyArray<readonly [number, string]> = [
  // Single quotes / primes
  [0x2018, "'"], // LEFT SINGLE QUOTATION MARK
  [0x2019, "'"], // RIGHT SINGLE QUOTATION MARK
  [0x201a, "'"], // SINGLE LOW-9 QUOTATION MARK
  [0x201b, "'"], // SINGLE HIGH-REVERSED-9 QUOTATION MARK
  [0x2032, "'"], // PRIME

  // Double quotes / primes
  [0x201c, '"'], // LEFT DOUBLE QUOTATION MARK
  [0x201d, '"'], // RIGHT DOUBLE QUOTATION MARK
  [0x201e, '"'], // DOUBLE LOW-9 QUOTATION MARK
  [0x201f, '"'], // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
  [0x2033, '"'], // DOUBLE PRIME

  // Dashes and minus
  [0x2013, "-"], // EN DASH
  [0x2014, "-"], // EM DASH
  [0x2015, "-"], // HORIZONTAL BAR
  [0x2212, "-"], // MINUS SIGN

  // Ellipsis
  [0x2026, "..."], // HORIZONTAL ELLIPSIS

  // Non-breaking / unusual spaces
  [0x00a0, " "], // NO-BREAK SPACE
  [0x202f, " "], // NARROW NO-BREAK SPACE
  [0x2007, " "], // FIGURE SPACE

  // Zero-width / BOM (stripped entirely)
  [0x200b, ""], // ZERO WIDTH SPACE
  [0x200c, ""], // ZERO WIDTH NON-JOINER
  [0x200d, ""], // ZERO WIDTH JOINER
  [0xfeff, ""], // ZERO WIDTH NO-BREAK SPACE / BOM
];

const REPLACEMENTS: Record<string, string> = Object.fromEntries(
  SUBSTITUTIONS.map(([cp, replacement]) => [
    String.fromCharCode(cp),
    replacement,
  ]),
);
const PATTERN = new RegExp(
  `[${SUBSTITUTIONS.map(([cp]) => `\\u${cp.toString(16).padStart(4, "0")}`).join("")}]`,
  "g",
);

export function sanitizePastedText(input: string): string {
  return input.replace(PATTERN, (ch) => REPLACEMENTS[ch] ?? ch);
}
