import type { CommandParameterInfo } from "./types";

function quotePsArgument(value: string): string {
  // Always single-quote. A whitelist fast path left values with a leading
  // PowerShell-significant char (# - $ @) bare, which the parser then treated
  // as a comment, switch, or variable — corrupting the generated command
  // (S3-26). Quoting is always safe for a literal parameter value.
  return `'${value.replace(/'/g, "''")}'`;
}

export function sortParams(params: CommandParameterInfo[]): CommandParameterInfo[] {
  return [...params].sort((a, b) => {
    const aPos = typeof a.position === "number" ? a.position : Number.MAX_SAFE_INTEGER;
    const bPos = typeof b.position === "number" ? b.position : Number.MAX_SAFE_INTEGER;
    if (aPos !== bPos) return aPos - bPos;
    return a.name.localeCompare(b.name);
  });
}

export function buildCommandPreview(selectedCommand: string, commandParams: CommandParameterInfo[], paramValues: Record<string, string>): string {
    if (!selectedCommand) return "";
    const parts: string[] = [selectedCommand];
    for (const param of commandParams) {
      const raw = paramValues[param.name] ?? "";
      if (param.isSwitch) {
        if (raw === "true") parts.push(`-${param.name}`);
        continue;
      }
      const trimmed = raw.trim();
      if (!trimmed) continue;
      parts.push(`-${param.name}`);
      parts.push(quotePsArgument(trimmed));
    }
    return parts.join(" ");
}
