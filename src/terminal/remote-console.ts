/** Remote console tabs: target validation and the Enter-PSSession command. */

export const REMOTE_TARGET_MAX_LENGTH = 255;

/** Single-quote a value for PowerShell, doubling embedded quotes. */
export function quotePs(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function validateRemoteTarget(raw: string): string | null {
  const target = raw.trim();
  if (!target) {
    return "Enter a remote computer name.";
  }
  if (target.length > REMOTE_TARGET_MAX_LENGTH) {
    return `Remote computer name must be ${REMOTE_TARGET_MAX_LENGTH} characters or fewer.`;
  }
  if (target.startsWith("-")) {
    return "Remote computer name cannot start with '-'.";
  }
  const invalidNonWhitespaceChars = target
    .replace(/[A-Za-z0-9._:-]/g, "")
    .replace(/\s/g, "");
  if (invalidNonWhitespaceChars.length > 0) {
    return "Remote computer name may only contain letters, numbers, dots, hyphens, underscores, and colons.";
  }
  if (/\s/.test(target)) {
    return "Remote computer name must not contain spaces.";
  }
  return null;
}

/** Startup command for a remote console tab. */
export function enterPsSessionCommand(target: string): string {
  return `Enter-PSSession -ComputerName ${quotePs(target)}`;
}
