import { stripAnsi } from "./terminal-utils";

export interface RunOutputCaptureState {
  active: boolean;
  done: boolean;
  /** Drop prompt text between OSC 633;A and 633;B. */
  inPrompt: boolean;
  /** After 633;E or immediately when PSReadLine is absent. */
  captureBody: boolean;
  buffer: string;
  commandLine: string;
  /** Bytes of an incomplete escape sequence spanning chunk boundaries. */
  pendingOsc: string;
}

export function createRunOutputCaptureState(): RunOutputCaptureState {
  return {
    active: false,
    done: false,
    inPrompt: false,
    captureBody: false,
    buffer: "",
    commandLine: "",
    pendingOsc: "",
  };
}

export function startRunOutputCapture(
  state: RunOutputCaptureState,
  commandLine: string,
): void {
  state.active = true;
  state.done = false;
  state.inPrompt = false;
  // Without PSReadLine there is no 633;E — start capturing stdout/stderr
  // immediately and strip the echoed command line when finalizing.
  state.captureBody = true;
  state.buffer = "";
  state.commandLine = commandLine.trim();
  state.pendingOsc = "";
}

const OSC_END_RE = /(\x07|\x1b\\)/;

function handleOsc633(
  state: RunOutputCaptureState,
  body: string,
): void {
  const semi = body.indexOf(";");
  const code = semi >= 0 ? body.slice(0, semi) : body;
  switch (code) {
    case "A":
      state.inPrompt = true;
      break;
    case "B":
      state.inPrompt = false;
      break;
    case "E":
      state.captureBody = true;
      break;
    case "D":
      state.done = true;
      state.active = false;
      break;
    case "P":
      break;
    default:
      break;
  }
}

function skipCsiSequence(input: string, start: number): number {
  let i = start + 2;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch >= "@" && ch <= "~") return i + 1;
    i++;
  }
  return -1;
}

function appendVisibleText(state: RunOutputCaptureState, text: string): void {
  if (!state.captureBody || state.inPrompt || !text) return;
  state.buffer += stripAnsi(text);
}

/** Feed raw PTY bytes while a script run is in progress. */
export function feedRunOutputCapture(
  state: RunOutputCaptureState,
  chunk: string,
): void {
  if (!state.active || state.done) return;

  let input = state.pendingOsc + chunk;
  state.pendingOsc = "";

  let i = 0;
  let textRun = "";

  const flushTextRun = () => {
    if (!textRun) return;
    appendVisibleText(state, textRun);
    textRun = "";
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === "\x1b" && i + 1 === input.length) {
      flushTextRun();
      state.pendingOsc = ch;
      return;
    }

    if (ch === "\x1b" && input[i + 1] === "]") {
      flushTextRun();
      const rest = input.slice(i);
      const endMatch = OSC_END_RE.exec(rest);
      if (!endMatch || endMatch.index === undefined) {
        state.pendingOsc = rest;
        return;
      }
      const end = i + endMatch.index + endMatch[0].length;
      const oscPayload = input.slice(i + 2, i + endMatch.index);
      if (oscPayload.startsWith("633;")) {
        handleOsc633(state, oscPayload.slice(4));
        if (state.done) return;
      }
      i = end;
      continue;
    }

    if (ch === "\x1b" && input[i + 1] === "[") {
      flushTextRun();
      const next = skipCsiSequence(input, i);
      if (next < 0) {
        state.pendingOsc = input.slice(i);
        return;
      }
      i = next;
      continue;
    }

    textRun += ch;
    i++;
  }

  flushTextRun();
}

/** Normalize captured script stdout/stderr for clipboard export. */
export function finalizeRunScriptOutput(
  raw: string,
  commandLine: string,
): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text) return "";

  const trimmedCommand = commandLine.trim();
  if (trimmedCommand) {
    const lines = text.split("\n");
    while (lines.length > 0) {
      const line = lines[0]!.trimEnd();
      if (line.trim() === trimmedCommand) {
        lines.shift();
        continue;
      }
      // Wrapped or prompt-prefixed echo: drop a leading line that ends with
      // the submitted command (oh-my-posh / PSReadLine sometimes prefix glyphs).
      if (line.trimEnd().endsWith(trimmedCommand)) {
        lines.shift();
        continue;
      }
      break;
    }
    text = lines.join("\n");
  }

  // Trim trailing blank lines left before the next prompt rendered.
  return text.replace(/\n+$/, "");
}

export function getRunScriptOutputFromState(
  state: RunOutputCaptureState,
): string | null {
  if (!state.commandLine && !state.done && !state.buffer) return null;
  return finalizeRunScriptOutput(state.buffer, state.commandLine);
}
