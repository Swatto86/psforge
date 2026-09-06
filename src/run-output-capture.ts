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
  pendingEscape: string;
}

export function createRunOutputCaptureState(): RunOutputCaptureState {
  return {
    active: false,
    done: false,
    inPrompt: false,
    captureBody: false,
    buffer: "",
    commandLine: "",
    pendingEscape: "",
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
  state.pendingEscape = "";
}

/**
 * Stop feeding without a completion marker: the session ended or restarted
 * mid-run. What was captured before that stays readable as the last run's
 * output; the next session's prompt and commands must not be appended to it.
 */
export function stopRunOutputCapture(state: RunOutputCaptureState): void {
  state.active = false;
  state.pendingEscape = "";
}

const OSC_END_RE = /\x07|\x1b\\/;
const ST_RE = /\x1b\\/;

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

/**
 * End (exclusive) of the escape sequence starting at `start`, or -1 when the
 * chunk ends before the sequence does.
 *
 * Copied output must contain none of what PowerShell and .NET emit around a
 * run, so every ECMA-48 form is recognised, not only CSI and OSC: the other
 * string sequences (DCS, SOS, PM, APC, ended by ST), nF sequences such as
 * charset selection (`ESC ( B`), and the two-byte Fp/Fs/Fe forms such as
 * keypad mode (`ESC =`) or cursor save (`ESC 7`).
 */
function escapeSequenceEnd(input: string, start: number): number {
  const kind = input[start + 1];
  if (kind === undefined) return -1;
  // A doubled ESC introduces the sequence that follows; drop only the first.
  if (kind === "\x1b") return start + 1;

  if (kind === "[") {
    let i = start + 2;
    while (i < input.length) {
      const ch = input[i]!;
      if (ch >= "@" && ch <= "~") return i + 1;
      i++;
    }
    return -1;
  }

  if (
    kind === "]" ||
    kind === "P" ||
    kind === "X" ||
    kind === "^" ||
    kind === "_"
  ) {
    const terminator = (kind === "]" ? OSC_END_RE : ST_RE).exec(
      input.slice(start + 2),
    );
    if (!terminator) return -1;
    return start + 2 + terminator.index + terminator[0].length;
  }

  if (kind >= " " && kind <= "/") {
    let i = start + 2;
    while (i < input.length && input[i]! >= " " && input[i]! <= "/") i++;
    return i < input.length ? i + 1 : -1;
  }

  return start + 2;
}

function appendVisibleText(state: RunOutputCaptureState, text: string): void {
  if (!state.captureBody || state.inPrompt || !text) return;
  state.buffer += text;
}

/** Feed raw PTY bytes while a script run is in progress. */
export function feedRunOutputCapture(
  state: RunOutputCaptureState,
  chunk: string,
): void {
  if (!state.active || state.done) return;

  const input = state.pendingEscape + chunk;
  state.pendingEscape = "";

  let i = 0;
  let textRun = "";

  const flushTextRun = () => {
    if (!textRun) return;
    appendVisibleText(state, textRun);
    textRun = "";
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (ch !== "\x1b") {
      textRun += ch;
      i++;
      continue;
    }

    flushTextRun();
    const end = escapeSequenceEnd(input, i);
    if (end < 0) {
      state.pendingEscape = input.slice(i);
      return;
    }
    if (input[i + 1] === "]") {
      const terminatorLength = input[end - 1] === "\x07" ? 1 : 2;
      const oscPayload = input.slice(i + 2, end - terminatorLength);
      if (oscPayload.startsWith("633;")) {
        handleOsc633(state, oscPayload.slice(4));
        if (state.done) return;
      }
    }
    i = end;
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
