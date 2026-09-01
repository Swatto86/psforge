/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from "vitest";
import {
  appendOutputTail,
  formatModuleSuggestions,
  missingCommandNames,
  OUTPUT_TAIL_LIMIT,
} from "../terminal/missing-command-suggest";
import {
  enterPsSessionCommand,
  validateRemoteTarget,
} from "../terminal/remote-console";
import { installWindowBridge } from "../terminal-utils";

/** PowerShell 7 wording. */
const notRecognized = (name: string) =>
  `The term '${name}' is not recognized as a name of a cmdlet, function, script file, or executable program.`;

/** Windows PowerShell 5.1 wording. */
const notRecognizedLegacy = (name: string) =>
  `The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program.`;

describe("missing command detection", () => {
  it("names every distinct unrecognized command once", () => {
    const tail = [
      notRecognized("Get-MgUser"),
      notRecognized("Connect-MgGraph"),
      notRecognized("Get-MgUser"),
    ].join("\n");
    expect(missingCommandNames(tail)).toEqual(["Get-MgUser", "Connect-MgGraph"]);
  });

  it("matches both host wordings", () => {
    expect(missingCommandNames(notRecognized("kubectl"))).toEqual(["kubectl"]);
    expect(missingCommandNames(notRecognizedLegacy("kubectl"))).toEqual([
      "kubectl",
    ]);
  });

  it("drops names containing whitespace rather than querying a sentence", () => {
    expect(missingCommandNames(notRecognized("Get Mg User"))).toEqual([]);
  });

  it("finds nothing in ordinary output", () => {
    expect(missingCommandNames("PS C:\\> Get-Date\n01 January 2026")).toEqual(
      [],
    );
  });

  it("matches a message split across two PTY chunks", () => {
    const message = notRecognized("Get-MgUser");
    const half = Math.floor(message.length / 2);
    let tail = appendOutputTail("", message.slice(0, half));
    expect(missingCommandNames(tail)).toEqual([]);
    tail = appendOutputTail(tail, message.slice(half));
    expect(missingCommandNames(tail)).toEqual(["Get-MgUser"]);
  });

  it("strips ANSI colour and caps the retained tail", () => {
    const tail = appendOutputTail("", `\x1b[31m${"x".repeat(20000)}\x1b[0m`);
    expect(tail.length).toBe(OUTPUT_TAIL_LIMIT);
    expect(tail).not.toContain("\x1b");
  });
});

describe("module suggestion text", () => {
  it("writes nothing when there is nothing to suggest", () => {
    expect(formatModuleSuggestions("Get-MgUser", [])).toBe("");
  });

  it("lists name, version, repository and the install command", () => {
    const text = formatModuleSuggestions("Get-MgUser", [
      {
        name: "Microsoft.Graph.Users",
        version: "2.2.0",
        repository: "PSGallery",
        installCommand: "Install-Module Microsoft.Graph.Users",
      },
    ]);
    expect(text).toContain("'Get-MgUser' may be available in:");
    expect(text).toContain("Microsoft.Graph.Users 2.2.0 (PSGallery)");
    expect(text).toContain("Install-Module Microsoft.Graph.Users");
    // CRLF: the console is a raw PTY view, a bare \n would stair-step.
    expect(text.endsWith("\r\n")).toBe(true);
  });
});

describe("remote console targets", () => {
  it("accepts an ordinary host name", () => {
    expect(validateRemoteTarget("server01.contoso.local")).toBeNull();
  });

  it("rejects empty, spaced, flag-like and oversized targets", () => {
    expect(validateRemoteTarget("  ")).toContain("Enter a remote");
    expect(validateRemoteTarget("srv 01")).toBeTruthy();
    expect(validateRemoteTarget("-Force")).toContain("cannot start with");
    expect(validateRemoteTarget("a".repeat(256))).toContain("or fewer");
  });

  it("single-quotes the target so a quote cannot break out", () => {
    expect(enterPsSessionCommand("srv'; Remove-Item C:\\ #")).toBe(
      "Enter-PSSession -ComputerName 'srv''; Remove-Item C:\\ #'",
    );
  });
});

describe("window terminal bridge", () => {
  it("removes exactly the entries it installed", () => {
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_pre_existing = "keep";
    const teardown = installWindowBridge({
      __psforge_test_a: () => "a",
      __psforge_test_b: () => "b",
    });
    expect(typeof w.__psforge_test_a).toBe("function");
    expect(typeof w.__psforge_test_b).toBe("function");

    teardown();
    expect("__psforge_test_a" in w).toBe(false);
    expect("__psforge_test_b" in w).toBe(false);
    expect(w.__psforge_pre_existing).toBe("keep");
    delete w.__psforge_pre_existing;
  });
});
