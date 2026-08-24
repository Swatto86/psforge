import { describe, expect, it } from "vitest";
import {
  buildDirectTerminalRunCommand,
  formatDirectRunArg,
  isSavedDiskScript,
  psSingleQuote,
} from "../direct-run";

describe("isSavedDiskScript", () => {
  const tab = {
    id: "tab-1",
    title: "script.ps1",
    filePath: "C:\\Scripts\\script.ps1",
    content: "",
    savedContent: "",
    encoding: "utf8",
    language: "powershell",
    isDirty: false,
    tabType: "code" as const,
  };

  it("treats a real path as a disk script", () => {
    expect(isSavedDiskScript(tab, tab.filePath, "")).toBe(true);
  });

  it("treats scratch-backed paths as direct-runnable", () => {
    expect(
      isSavedDiskScript(
        tab,
        "C:\\Temp\\scratch\\tab-1.ps1",
        "C:\\Temp\\scratch",
      ),
    ).toBe(true);
  });

  it("rejects an empty path", () => {
    expect(isSavedDiskScript(tab, "", "C:\\Temp\\scratch")).toBe(false);
  });
});

describe("psSingleQuote", () => {
  it("wraps and doubles apostrophes", () => {
    expect(psSingleQuote("C:\\Scripts\\script.ps1")).toBe(
      "'C:\\Scripts\\script.ps1'",
    );
    expect(psSingleQuote("O'Brien's.ps1")).toBe("'O''Brien''s.ps1'");
  });
});

describe("formatDirectRunArg", () => {
  it("keeps named-parameter tokens bare", () => {
    expect(formatDirectRunArg("-Name")).toBe("-Name");
    expect(formatDirectRunArg("-Switch:$true")).toBe("-Switch:$true");
    expect(formatDirectRunArg("-Flag:$false")).toBe("-Flag:$false");
  });

  it("quotes plain values", () => {
    expect(formatDirectRunArg("Alice")).toBe("'Alice'");
    expect(formatDirectRunArg("O'Brien")).toBe("'O''Brien'");
  });
});

describe("buildDirectTerminalRunCommand", () => {
  it("cds then invokes the saved script in the current session", () => {
    expect(
      buildDirectTerminalRunCommand({
        scriptPath: "C:\\Scripts\\script.ps1",
        workingDir: "C:\\Scripts",
        executionPolicy: "Default",
      }),
    ).toBe(
      "Set-Location -LiteralPath 'C:\\Scripts'; & 'C:\\Scripts\\script.ps1'",
    );
  });

  it("applies a process-scoped execution policy when set", () => {
    expect(
      buildDirectTerminalRunCommand({
        scriptPath: "/tmp/a.ps1",
        workingDir: "/tmp",
        executionPolicy: "Bypass",
      }),
    ).toBe(
      "Set-ExecutionPolicy -Scope Process -ExecutionPolicy 'Bypass' -Force; Set-Location -LiteralPath '/tmp'; & '/tmp/a.ps1'",
    );
  });

  it("appends named args without quoting the -Param token", () => {
    expect(
      buildDirectTerminalRunCommand({
        scriptPath: "C:\\a.ps1",
        workingDir: "C:\\",
        executionPolicy: "Default",
        scriptArgs: ["-Name", "x"],
      }),
    ).toBe("Set-Location -LiteralPath 'C:\\'; & 'C:\\a.ps1' -Name 'x'");
  });
});
