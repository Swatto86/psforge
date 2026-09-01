/**
 * ANSI syntax colouring for PowerShell text written straight to the console.
 *
 * Used for locally echoed text (suggestions, notices) that never passes
 * through PowerShell itself, so PSReadLine's own colouring does not apply.
 */

export function highlightPs(text: string): string {
  const K = "\x1b[38;2;86;156;214m";
  const F = "\x1b[38;2;220;220;170m";
  const V = "\x1b[38;2;156;220;254m";
  const S = "\x1b[38;2;206;145;120m";
  const C = "\x1b[38;2;106;153;85m";
  const N = "\x1b[38;2;181;206;168m";
  const R = "\x1b[0m";

  const KEYWORDS = new Set([
    "if",
    "else",
    "elseif",
    "for",
    "foreach",
    "while",
    "do",
    "until",
    "switch",
    "break",
    "continue",
    "return",
    "function",
    "filter",
    "param",
    "begin",
    "process",
    "end",
    "try",
    "catch",
    "finally",
    "throw",
    "class",
    "enum",
    "using",
    "in",
    "trap",
    "exit",
    "hidden",
    "static",
    "data",
  ]);

  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "#") {
      result += C + text.slice(i) + R;
      break;
    }
    if (text[i] === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j++;
      if (j < text.length) j++;
      result += S + text.slice(i, j) + R;
      i = j;
      continue;
    }
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "`" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      result += S + text.slice(i, j) + R;
      i = j;
      continue;
    }
    if (text[i] === "$" && i + 1 < text.length && /[\w{?]/.test(text[i + 1])) {
      let j = i + 1;
      if (text[j] === "{") {
        j++;
        while (j < text.length && text[j] !== "}") j++;
        if (j < text.length) j++;
      } else {
        while (j < text.length && /[\w?]/.test(text[j])) j++;
      }
      result += V + text.slice(i, j) + R;
      i = j;
      continue;
    }
    if (
      text[i] === "-" &&
      i + 1 < text.length &&
      /[a-zA-Z]/.test(text[i + 1])
    ) {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
      result += K + text.slice(i, j) + R;
      i = j;
      continue;
    }
    if (/\d/.test(text[i]) && (i === 0 || /\W/.test(text[i - 1]))) {
      let j = i;
      while (j < text.length && /[\d._xXa-fA-FoObBeE+-]/.test(text[j])) j++;
      result += N + text.slice(i, j) + R;
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) j++;
      while (j > i + 1 && text[j - 1] === "-") j--;
      const word = text.slice(i, j);
      if (KEYWORDS.has(word.toLowerCase())) {
        result += K + word + R;
      } else if (
        /^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z][a-zA-Z0-9]*)+$/.test(word)
      ) {
        result += F + word + R;
      } else {
        result += word;
      }
      i = j;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}
