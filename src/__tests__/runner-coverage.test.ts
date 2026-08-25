import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDirectTerminalRunCommand,
  formatDirectRunArg,
} from "../direct-run";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "runner-coverage.ps1",
);

describe("runner coverage fixture", () => {
  it("is valid stress content without $$ parse traps", () => {
    const text = readFileSync(fixturePath, "utf8");
    expect(text).toContain("PSFORGE_COVERAGE_OK");
    expect(text).toContain("Section \"SUMMARY\"");
    expect(text.includes("$$(")).toBe(false);
    expect(text.includes("Item-$$_")).toBe(false);
    expect(text).toMatch(/Dog\(\[string\]\$n, \[int\]\$a\) : base\(/);
  });

  it("builds a live-console & invoke for the fixture path", () => {
    const { command, workingDir } = buildDirectTerminalRunCommand({
      scriptPath: fixturePath,
      workingDir: dirname(fixturePath),
      executionPolicy: "Default",
      scriptArgs: ["-Name", "Alice", "-Switch:$true"],
    });
    expect(workingDir).toBe(dirname(fixturePath));
    expect(command).toContain(`& '${fixturePath.replace(/'/g, "''")}'`);
    expect(command).toContain(" -Name 'Alice' ");
    expect(command).toContain(" -Switch:$true");
    expect(formatDirectRunArg("-Name")).toBe("-Name");
    expect(formatDirectRunArg("-Switch:$true")).toBe("-Switch:$true");
  });
});
