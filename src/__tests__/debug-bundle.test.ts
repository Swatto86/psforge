import { describe, expect, it } from "vitest";
import { buildDebugBundleMarkdown } from "../debug-bundle";
import type { EditorTab } from "../types";

const tab: EditorTab = {
  id: "tab-1",
  title: "test.ps1",
  filePath: "C:\\Scripts\\test.ps1",
  content: "Get-Process",
  savedContent: "Get-Process",
  encoding: "utf8",
  language: "powershell",
  isDirty: false,
};

describe("buildDebugBundleMarkdown", () => {
  it("includes exit code and PSSA errors", () => {
    const md = buildDebugBundleMarkdown({
      tab,
      lastRun: { exitCode: 1, durationMs: 120 },
      workingDir: "C:\\Scripts",
      problems: [
        {
          message: "Avoid Write-Host",
          severity: "Error",
          ruleName: "PSAvoidUsingWriteHost",
          line: 3,
          column: 1,
          endLine: 3,
          endColumn: 10,
        },
      ],
      getRunOutput: () => "Write-Host hi\n",
    });
    expect(md).toContain("exit 1");
    expect(md).toContain("PSAvoidUsingWriteHost");
    expect(md).toContain("Write-Host hi");
    expect(md).toContain("Get-Process");
  });
});
