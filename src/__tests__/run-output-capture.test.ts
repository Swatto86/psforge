import { describe, expect, it } from "vitest";
import {
  createRunOutputCaptureState,
  feedRunOutputCapture,
  finalizeRunScriptOutput,
  getRunScriptOutputFromState,
  startRunOutputCapture,
} from "../run-output-capture";

const ESC = "\x1b";

function osc633(code: string, payload = ""): string {
  const body = payload ? `633;${code};${payload}` : `633;${code}`;
  return `${ESC}]${body}\x07`;
}

function osc633St(code: string, payload = ""): string {
  const body = payload ? `633;${code};${payload}` : `633;${code}`;
  return `${ESC}]${body}${ESC}\\`;
}

describe("run-output-capture", () => {
  it("handles every chunk split through colour codes and completion markers", () => {
    const stream = `\x1b[31mHello\x1b[0m\r\n${osc633St("D", "0")}`;
    for (let split = 1; split < stream.length; split++) {
      const state = createRunOutputCaptureState();
      startRunOutputCapture(state, "Write-Output Hello");
      feedRunOutputCapture(state, stream.slice(0, split));
      feedRunOutputCapture(state, stream.slice(split));
      expect(state.done, `split ${split}`).toBe(true);
      expect(getRunScriptOutputFromState(state), `split ${split}`).toBe("Hello");
    }
  });

  it("excludes text after completion in the same chunk", () => {
    const state = createRunOutputCaptureState();
    startRunOutputCapture(state, "Write-Output Hello");
    feedRunOutputCapture(state, `Hello\r\n${osc633("D", "0")}later command output`);
    expect(getRunScriptOutputFromState(state)).toBe("Hello");
  });

  it("captures stdout/stderr between command submit and prompt finish", () => {
    const state = createRunOutputCaptureState();
    startRunOutputCapture(state, "psrun 'Test.ps1'");

    feedRunOutputCapture(
      state,
      `${osc633("E", "psrun%20'Test.ps1'")}psrun 'Test.ps1'\r\nHello\r\nWorld\r\n${osc633("D", "0")}`,
    );

    expect(getRunScriptOutputFromState(state)).toBe("Hello\nWorld");
  });

  it("drops prompt text wrapped in OSC 633;A/B", () => {
    const state = createRunOutputCaptureState();
    startRunOutputCapture(state, "1+1");

    feedRunOutputCapture(
      state,
      `${osc633("E", "1%2B1")}1+1\r\n2\r\n${osc633("D", "0")}${osc633("A")}PS C:\\>${osc633("B")}`,
    );

    expect(getRunScriptOutputFromState(state)).toBe("2");
  });

  it("stops capturing at 633;D so post-run prompt is excluded", () => {
    const state = createRunOutputCaptureState();
    startRunOutputCapture(state, "Write-Output hi");

    feedRunOutputCapture(state, "Write-Output hi\r\n");
    feedRunOutputCapture(state, "hi\r\n");
    feedRunOutputCapture(state, osc633("D", "0"));
    feedRunOutputCapture(state, `${osc633("A")}fancy prompt>${osc633("B")}`);

    expect(getRunScriptOutputFromState(state)).toBe("hi");
  });

  it("strips echoed command line when PSReadLine omits 633;E", () => {
    const state = createRunOutputCaptureState();
    startRunOutputCapture(state, "& 'C:\\\\scripts\\\\Test.ps1'");

    feedRunOutputCapture(
      state,
      "& 'C:\\\\scripts\\\\Test.ps1'\r\nDone\r\n" + osc633("D", "0"),
    );

    expect(getRunScriptOutputFromState(state)).toBe("Done");
  });

  it("returns empty string when the run produced no output", () => {
    const state = createRunOutputCaptureState();
    startRunOutputCapture(state, "exit 0");
    feedRunOutputCapture(state, "exit 0\r\n" + osc633("D", "0"));
    expect(getRunScriptOutputFromState(state)).toBe("");
  });

  it("captures runs when OSC 633 is terminated with ST instead of BEL", () => {
    const state = createRunOutputCaptureState();
    startRunOutputCapture(state, "& 'C:\\\\scripts\\\\Test.ps1'");

    feedRunOutputCapture(
      state,
      `${osc633St("E", "&%20'C:\\\\scripts\\\\Test.ps1'")}& 'C:\\\\scripts\\\\Test.ps1'\r\nHello\r\n${osc633St("D", "0")}${osc633St("A")}PS C:\\>${osc633St("B")}`,
    );

    expect(getRunScriptOutputFromState(state)).toBe("Hello");
  });

  it("finalizeRunScriptOutput trims trailing blank lines", () => {
    expect(
      finalizeRunScriptOutput("line one\nline two\n\n\n", "ignored"),
    ).toBe("line one\nline two");
  });
});
