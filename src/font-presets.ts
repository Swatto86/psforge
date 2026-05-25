/** Emoji/symbol fallbacks appended to monospace stacks for terminal output. */
export const MONOSPACE_EMOJI_FALLBACK =
  "'Segoe UI Emoji', 'Segoe UI Symbol', 'Apple Color Emoji', 'Noto Color Emoji'";

/** Common editor/terminal monospace presets (persisted as full CSS font-family strings). */
export const MONOSPACE_FONT_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  family: string;
}> = [
  {
    id: "cascadia",
    label: "Cascadia Code",
    family: `Cascadia Code, Consolas, ${MONOSPACE_EMOJI_FALLBACK}, monospace`,
  },
  {
    id: "consolas",
    label: "Consolas",
    family: `Consolas, ${MONOSPACE_EMOJI_FALLBACK}, monospace`,
  },
  {
    id: "fira",
    label: "Fira Code",
    family: `'Fira Code', Consolas, ${MONOSPACE_EMOJI_FALLBACK}, monospace`,
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    family: `'JetBrains Mono', Consolas, ${MONOSPACE_EMOJI_FALLBACK}, monospace`,
  },
  {
    id: "source",
    label: "Source Code Pro",
    family: `'Source Code Pro', Consolas, ${MONOSPACE_EMOJI_FALLBACK}, monospace`,
  },
  {
    id: "courier",
    label: "Courier New",
    family: `'Courier New', Courier, ${MONOSPACE_EMOJI_FALLBACK}, monospace`,
  },
];

export function presetIdForFamily(family: string): string {
  const normalized = family.trim().toLowerCase();
  const match = MONOSPACE_FONT_PRESETS.find(
    (p) => p.family.trim().toLowerCase() === normalized,
  );
  if (match) return match.id;
  const byPrimary = MONOSPACE_FONT_PRESETS.find((p) =>
    normalized.startsWith(p.label.toLowerCase()),
  );
  return byPrimary?.id ?? "custom";
}
