/** Explain Selection (AI) helpers.
 *
 *  Builds the "explain this selected code" question sent through the existing
 *  `ask_ai` bridge (mode "ask" — no backend changes), and carries a completed
 *  explanation from the editor popover into the Assistant pane. The handoff is
 *  a module variable because the Assistant pane mounts lazily: a window event
 *  alone would be lost when the pane isn't mounted yet, so the pane also takes
 *  any pending handoff on mount.
 */

/** Selection cap keeps the question under the backend MAX_QUESTION_CHARS (8000). */
export const MAX_EXPLAIN_SELECTION_CHARS = 6_000;

/** Fired after SET_BOTTOM_TAB so an already-mounted Assistant pane picks up the handoff. */
export const EXPLAIN_HANDOFF_EVENT = "psforge-explain-handoff";

/** Mirrors the backend fence_for: one backtick longer than the longest run in the text. */
export function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

export interface ExplainQuestion {
  question: string;
  truncated: boolean;
}

/** Builds the mode-"ask" question for a selected snippet; the full script travels
 *  separately in the request's `script` field for surrounding context. */
export function buildExplainQuestion(
  selection: string,
  startLine: number,
  endLine: number,
): ExplainQuestion {
  const truncated = selection.length > MAX_EXPLAIN_SELECTION_CHARS;
  const snippet = truncated
    ? selection.slice(0, MAX_EXPLAIN_SELECTION_CHARS)
    : selection;
  const fence = fenceFor(snippet);
  const range =
    startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  const question =
    "Explain in plain English what the SELECTED CODE below does. " +
    "Be concise: a short paragraph or a few bullet points. " +
    "Do not repeat the code back. The full script is provided separately for context.\n\n" +
    `SELECTED CODE (${range}${truncated ? ", truncated" : ""}):\n` +
    `${fence}powershell\n${snippet}\n${fence}`;
  return { question, truncated };
}

export interface ExplainHandoff {
  question: string;
  answer: string;
  meta: string;
}

let pendingHandoff: ExplainHandoff | null = null;

export function setExplainHandoff(handoff: ExplainHandoff): void {
  pendingHandoff = handoff;
}

/** Returns and clears the pending handoff (one consumer wins). */
export function takeExplainHandoff(): ExplainHandoff | null {
  const handoff = pendingHandoff;
  pendingHandoff = null;
  return handoff;
}
