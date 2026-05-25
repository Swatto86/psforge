import type { PasteSanitizeSummary } from "./types";

/** User-facing one-line or short multi-part paste cleanup description. */
export function formatPasteSummaryMessage(summary: PasteSanitizeSummary): string {
  if (!summary.changed) {
    return "Paste unchanged — no cleanup needed.";
  }

  const parts: string[] = [];
  if (summary.markdownFenceStripped) {
    parts.push("markdown fence removed");
  }
  if (summary.embeddedFenceExtracted) {
    parts.push("code block extracted");
  }
  if (summary.proseLinesRemoved > 0) {
    parts.push(
      `${summary.proseLinesRemoved} prose line${summary.proseLinesRemoved === 1 ? "" : "s"} removed`,
    );
  }
  if (summary.typographyReplacements > 0) {
    parts.push(
      `${summary.typographyReplacements} smart character${summary.typographyReplacements === 1 ? "" : "s"} fixed`,
    );
  }
  if (summary.promptPrefixesStripped > 0) {
    parts.push(
      `${summary.promptPrefixesStripped} prompt prefix${summary.promptPrefixesStripped === 1 ? "" : "es"} stripped`,
    );
  }
  if (summary.lineGuttersStripped > 0) {
    parts.push(
      `${summary.lineGuttersStripped} line number gutter${summary.lineGuttersStripped === 1 ? "" : "s"} removed`,
    );
  }
  if (summary.htmlTagsStripped > 0) {
    parts.push(`${summary.htmlTagsStripped} HTML tag(s) removed`);
  }
  if (summary.controlCharsRemoved > 0) {
    parts.push(`${summary.controlCharsRemoved} control character(s) removed`);
  }
  if (summary.newlinesNormalized) {
    parts.push("line endings normalized");
  }

  if (parts.length === 0) {
    return "Paste cleaned.";
  }
  return `Paste cleaned: ${parts.join(", ")}.`;
}
