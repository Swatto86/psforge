/** PowerShell script extensions shown in welcome/recent lists. */
export const PS_SCRIPT_EXTENSIONS = [".ps1", ".psm1", ".psd1"] as const;

export function isPowerShellScriptPath(path: string): boolean {
  const lower = path.toLowerCase();
  return PS_SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
