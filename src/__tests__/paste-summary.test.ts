import { describe, expect, it } from "vitest";
import { formatPasteSummaryMessage } from "../paste-summary";
import type { PasteSanitizeSummary } from "../types";

describe("formatPasteSummaryMessage", () => {
  it("reports unchanged paste", () => {
    expect(
      formatPasteSummaryMessage({
        changed: false,
        typographyReplacements: 0,
        markdownFenceStripped: false,
        embeddedFenceExtracted: false,
        proseLinesRemoved: 0,
        lineGuttersStripped: 0,
        promptPrefixesStripped: 0,
        htmlTagsStripped: 0,
        controlCharsRemoved: 0,
        newlinesNormalized: false,
      }),
    ).toContain("unchanged");
  });

  it("lists cleanup steps", () => {
    const msg = formatPasteSummaryMessage({
      changed: true,
      typographyReplacements: 4,
      markdownFenceStripped: true,
      embeddedFenceExtracted: false,
      proseLinesRemoved: 0,
      lineGuttersStripped: 0,
      promptPrefixesStripped: 2,
      htmlTagsStripped: 0,
      controlCharsRemoved: 0,
      newlinesNormalized: false,
    });
    expect(msg).toContain("fence");
    expect(msg).toContain("4 smart");
    expect(msg).toContain("2 prompt");
  });
});
