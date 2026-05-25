/** Strip ANSI escape sequences from integrated terminal buffer text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** Read plain-text terminal scrollback from the integrated terminal bridge. */
export function getTerminalPlainContent(lineCount?: number): string {
  const w = window as unknown as Record<string, unknown>;
  const getContent = w.__psforge_terminal_get_content as
    | ((count?: number) => string)
    | undefined;
  return stripAnsi(getContent?.(lineCount) ?? "");
}

export async function copyTerminalOutputToClipboard(
  lineCount?: number,
): Promise<boolean> {
  const text = getTerminalPlainContent(lineCount);
  if (!text.trim()) return false;
  await navigator.clipboard.writeText(text);
  return true;
}
