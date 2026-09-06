/**
 * Splits PowerShell source into alternating code / string-literal segments so
 * sanitizer passes can skip string contents. Handles '...', "..." (with `"
 * and doubled-quote escapes), and @"..."@ / @'...'@ here-strings.
 * ponytail: does not track comments — a quote inside a # comment starts a
 * phantom string segment; acceptable for sanitizer heuristics, add comment
 * tracking if a real paste ever trips it.
 */
export function splitPsStringSegments(
  input: string,
): { text: string; isString: boolean }[] {
  const segments: { text: string; isString: boolean }[] = [];
  const n = input.length;
  let segStart = 0;
  let i = 0;
  const push = (end: number, isString: boolean) => {
    if (end > segStart) {
      segments.push({ text: input.slice(segStart, end), isString });
    }
    segStart = end;
  };
  while (i < n) {
    const ch = input[i];
    if (ch === "@" && (input[i + 1] === '"' || input[i + 1] === "'")) {
      // Here-string: opener must be followed by a newline; terminator is a
      // closing quote + @ at the start of a line.
      const quote = input[i + 1];
      let j = i + 2;
      if (input[j] === "\r") j++;
      if (input[j] === "\n") {
        push(i, false);
        const term = `\n${quote}@`;
        const k = input.indexOf(term, j);
        const end = k === -1 ? n : k + term.length;
        push(end, true);
        i = end;
        continue;
      }
    }
    if (ch === "'") {
      push(i, false);
      let j = i + 1;
      while (j < n) {
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push(Math.min(j, n), true);
      i = Math.min(j, n);
      continue;
    }
    if (ch === '"') {
      push(i, false);
      let j = i + 1;
      while (j < n) {
        const c = input[j];
        if (c === "`") {
          j += 2;
          continue;
        }
        if (c === '"') {
          if (input[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push(Math.min(j, n), true);
      i = Math.min(j, n);
      continue;
    }
    i++;
  }
  push(n, false);
  return segments;
}

