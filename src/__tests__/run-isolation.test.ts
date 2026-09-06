import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDirectTerminalRunCommand, psSingleQuote } from "../direct-run";

describe("saved script process isolation", () => {
  it("keeps globals, environment, functions and location out of subsequent runs", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "psforge-isolation-")));
    try {
      const first = join(dir, "first.ps1");
      const second = join(dir, "O'Brien-second.ps1");
      writeFileSync(first, "$global:psforgeLeak = 42; $env:PSFORGE_SWEEP_LEAK = 'dirty'; function global:PsforgeLeakFn { 1 }; New-Module -Name PsforgeSweepModule -ScriptBlock { function Get-Sweep { 1 }; Export-ModuleMember -Function Get-Sweep } | Import-Module -Global; Set-Location /; 'FIRST'");
      writeFileSync(second, "[pscustomobject]@{ variable = $null -ne (Get-Variable psforgeLeak -ErrorAction SilentlyContinue); environment = $env:PSFORGE_SWEEP_LEAK; fn = $null -ne (Get-Command PsforgeLeakFn -ErrorAction SilentlyContinue); module = $null -ne (Get-Module PsforgeSweepModule); cwd = $PWD.Path; root = $PSScriptRoot; path = $PSCommandPath } | ConvertTo-Json -Compress");
      const run = (scriptPath: string) => buildDirectTerminalRunCommand({ scriptPath, workingDir: dir, executionPolicy: "Default" }).command;
      const output = execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", `Set-Location -LiteralPath ${psSingleQuote(dir)}; ${run(first)}; ${run(second)}; ${run(second)}`], { encoding: "utf8" });
      const results = output.trim().split(/\r?\n/);
      expect(results[0]).toBe("FIRST");
      for (const line of results.slice(1)) {
        expect(JSON.parse(line)).toEqual({ variable: false, environment: null, fn: false, module: false, cwd: dir, root: dir, path: second });
      }
      expect(results).toHaveLength(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
