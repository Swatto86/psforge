import { describe, expect, it } from "vitest";
import {
  isPssaErrorSeverity,
  resolveExecutionWorkDir,
  resolveExecutionWorkDirWithOverride,
} from "../run-utils";
import type { EditorTab } from "../types";

const tab = (filePath: string): EditorTab => ({
  id: "tab-1",
  title: "script.ps1",
  filePath,
  content: "",
  savedContent: "",
  encoding: "utf8",
  language: "powershell",
  isDirty: false,
});

describe("resolveExecutionWorkDir", () => {
  it("uses pinned directory when mode is pinned", () => {
    const dir = resolveExecutionWorkDir(
      tab(""),
      "",
      "pinned",
      "",
      "C:\\Pinned",
      () => "/",
    );
    expect(dir).toBe("C:\\Pinned");
  });

  it("uses custom directory when mode is custom", () => {
    const dir = resolveExecutionWorkDir(
      tab("C:\\Scripts\\a.ps1"),
      "C:\\State",
      "custom",
      "C:\\Custom",
      "",
      () => "/",
    );
    expect(dir).toBe("C:\\Custom");
  });

  it("falls back to file directory in file mode", () => {
    const dir = resolveExecutionWorkDir(
      tab("C:\\Scripts\\a.ps1"),
      "",
      "file",
      "",
      "",
      () => "/home",
    );
    expect(dir).toBe("C:\\Scripts");
  });
});

describe("resolveExecutionWorkDirWithOverride", () => {
  it("prefers one-shot override", () => {
    const dir = resolveExecutionWorkDirWithOverride(
      tab(""),
      "",
      { workingDirMode: "pinned", customWorkingDir: "", pinnedRunDir: "C:\\Pin" },
      () => "/",
      "C:\\Override",
    );
    expect(dir).toBe("C:\\Override");
  });
});

describe("isPssaErrorSeverity", () => {
  it("treats Error and ParseError as blocking severities", () => {
    expect(isPssaErrorSeverity("Error")).toBe(true);
    expect(isPssaErrorSeverity("ParseError")).toBe(true);
    expect(isPssaErrorSeverity("Warning")).toBe(false);
  });
});
