/**
 * "The term 'X' is not recognized" detection in console output, and the
 * console text offering the modules that would provide X.
 *
 * The console feeds output in PTY-sized chunks, so a message can straddle two
 * chunks; matching runs against a rolling tail rather than the chunk alone.
 */

import { suggestModulesForCommand } from "../commands";
import type { ModuleInstallSuggestion } from "../types";
import { stripAnsi } from "../terminal-utils";

// Wording differs by host: Windows PowerShell says "as the name of ... or
// operable program", PowerShell 7 says "as a name of ... or executable
// program". Missing the "a" variant silently disabled suggestions on pwsh.
const MISSING_COMMAND_RE =
  /The term ['"`]([^'"`\r\n]+)['"`] is not recognized as (?:an? |the )?name of a cmdlet, function, script file, or (?:executable|operable) program\./gi;

/** Characters of plain output kept for cross-chunk matching. */
export const OUTPUT_TAIL_LIMIT = 12000;

/** Rolling plain-text tail of console output, capped at OUTPUT_TAIL_LIMIT. */
export function appendOutputTail(tail: string, chunk: string): string {
  return (tail + stripAnsi(chunk)).slice(-OUTPUT_TAIL_LIMIT);
}

/**
 * Command names PowerShell reported as unrecognized, in order and deduplicated.
 * Names containing whitespace are dropped: those come from a mangled message,
 * and looking them up would query the gallery for a sentence.
 */
export function missingCommandNames(tail: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  MISSING_COMMAND_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MISSING_COMMAND_RE.exec(tail)) !== null) {
    const name = match[1]?.trim();
    if (!name || /\s/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Modules listed per suggestion block. */
export const MAX_SUGGESTIONS_SHOWN = 5;

/** Cyan console block naming the modules that provide `commandName`. */
export function formatModuleSuggestions(
  commandName: string,
  suggestions: ModuleInstallSuggestion[],
): string {
  if (!suggestions.length) return "";
  const lines = [
    `\r\n\x1b[36m[PSForge] '${commandName}' may be available in:\x1b[0m\r\n`,
  ];
  for (const item of suggestions.slice(0, MAX_SUGGESTIONS_SHOWN)) {
    const parts = [item.name];
    if (item.version) parts.push(item.version);
    if (item.repository) parts.push(`(${item.repository})`);
    lines.push(`\x1b[36m  - ${parts.join(" ")}\x1b[0m\r\n`);
    lines.push(`\x1b[36m    ${item.installCommand}\x1b[0m\r\n`);
  }
  return lines.join("");
}

export type MissingCommandNotifier = {
  /** Scan a chunk of console output and offer modules for anything new. */
  feed: (chunk: string) => void;
  /** Forget the tail and everything already offered (session restart). */
  reset: () => void;
};

/**
 * Watches console output for unrecognized commands and writes the install
 * candidates back to the console.
 *
 * `resolveHost` returns the PowerShell host to query, or "" to stay quiet —
 * background consoles do not interrupt with suggestions. Lookups are async, so
 * a generation counter drops any reply that arrives after a restart or
 * teardown rather than writing into a console that has moved on.
 */
export function createMissingCommandNotifier(
  write: (text: string) => void,
  resolveHost: () => string,
): MissingCommandNotifier {
  let tail = "";
  let generation = 0;
  const offered = new Set<string>();
  const inFlight = new Set<string>();

  return {
    feed: (chunk: string) => {
      const psPath = resolveHost();
      if (!psPath) return;

      tail = appendOutputTail(tail, chunk);
      for (const commandName of missingCommandNames(tail)) {
        const key = commandName.toLowerCase();
        if (offered.has(key) || inFlight.has(key)) continue;

        inFlight.add(key);
        const requestedAt = generation;
        void suggestModulesForCommand(psPath, commandName)
          .then((suggestions) => {
            if (generation !== requestedAt) return;
            const text = formatModuleSuggestions(commandName, suggestions);
            if (text) write(text);
          })
          .catch(() => {})
          .finally(() => {
            inFlight.delete(key);
            offered.add(key);
          });
      }
    },
    reset: () => {
      generation += 1;
      tail = "";
      offered.clear();
      inFlight.clear();
    },
  };
}
