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

  it("extracts a fenced block wrapped in recognizable prose", () => {
    const input =
      "Here's the script:\n```powershell\nGet-ChildItem\n```\nNote: run as admin";
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(
      "Get-ChildItem",
    );
  });

  it("does NOT extract a fence embedded inside a real script", () => {
    const input = [
      "function New-Report {",
      '  $body = @"',
      "```powershell",
      'Write-Host "example"',
      "```",
      '"@',
      "  Set-Content report.md -Value $body",
      "}",
      "New-Report",
    ].join("\n");
    const { text, summary } = sanitizePastedTextWithSummary(
      input,
      FULL_PASTE_SANITIZE_OPTIONS,
    );
    expect(text).toContain("function New-Report {");
    expect(text).toContain("Set-Content report.md");
    expect(summary.embeddedFenceExtracted).toBe(false);
  });

  it("preserves HTML tags inside PowerShell string literals", () => {
    const input = '$body = "<div>Report</div><p>Done</p>"';
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(input);
  });

  it("preserves HTML tags inside here-strings", () => {
    const input = '$html = @"\n<div class="x">hi</div>\n"@';
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(input);
  });

  it("still strips HTML tags outside string literals", () => {
    const input = "<pre>Get-Process</pre>";
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(
      "Get-Process",
    );
  });

  it("does NOT strip a lone Pester-style integer pipeline", () => {
    const input = "1 | Should -Be 1";
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(input);
  });

  it("still strips genuine line-number gutters", () => {
    const input = "1 | Get-Process\n2 | Sort-Object CPU\n3 | Select-Object -First 5";
    expect(sanitizePastedText(input, FULL_PASTE_SANITIZE_OPTIONS)).toBe(
      "Get-Process\nSort-Object CPU\nSelect-Object -First 5",
    );
  });
});
