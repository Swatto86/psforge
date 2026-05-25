import { describe, expect, it } from "vitest";
import {
  sanitizePastedText,
  sanitizePastedTextWithSummary,
  FULL_PASTE_SANITIZE_OPTIONS,
} from "../sanitize-paste";

describe("sanitizePastedText", () => {
  it("strips markdown fences", () => {
    const input = "```powershell\nGet-ChildItem\n```";
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(
      "Get-ChildItem",
    );
  });

  it("replaces curly quotes with ASCII quotes", () => {
    const input = "Write-Host ‘hello’";
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(
      "Write-Host 'hello'",
    );
  });

  it("removes PS prompt prefixes per line", () => {
    const input = "PS C:\\> Get-Process\r\n>> Sort-Object Name";
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(
      "Get-Process\nSort-Object Name",
    );
  });

  it("records summary when fence is stripped", () => {
    const { summary } = sanitizePastedTextWithSummary(
      "```powershell\nGet-ChildItem\n```",
      FULL_PASTE_SANITIZE_OPTIONS,
    );
    expect(summary.changed).toBe(true);
    expect(
      summary.markdownFenceStripped || summary.embeddedFenceExtracted,
    ).toBe(true);
  });
});
