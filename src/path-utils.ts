/**
 * Cross-platform path helpers.
 *
 * The frontend handles paths from both Windows (`C:\Users\me\file.ps1`) and
 * Unix (`/home/me/file.ps1`). Hard-coding `\\` as the separator (as several
 * call sites used to do) makes file titles wrong and "open in containing
 * folder" features broken on Linux/macOS.
 *
 * Both helpers split on whichever separator appears later in the string so
 * mixed-style inputs are handled gracefully.
 */

/** Returns the index of the last `/` or `\` in `path`, or `-1` if neither. */
function lastSeparatorIndex(path: string): number {
  const back = path.lastIndexOf("\\");
  const fwd = path.lastIndexOf("/");
  return Math.max(back, fwd);
}

/** Returns the trailing component of `path` (file name with extension). */
export function basename(path: string): string {
  const idx = lastSeparatorIndex(path);
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Returns the parent directory of `path`, or `""` if there isn't one.
 *  A file directly under a root keeps the root's trailing separator:
 *  Unix "/script.ps1" -> "/", Windows drive "C:\\script.ps1" -> "C:\\". */
export function dirname(path: string): string {
  const idx = lastSeparatorIndex(path);
  if (idx === -1) return "";
  // Unix root.
  if (idx === 0) return path[0];
  // Windows drive root: "C:\\script.ps1" -> "C:\\", not "C:" (which is a
  // drive-relative reference resolving to the remembered cwd on that drive).
  if (idx === 2 && path[1] === ":") return path.slice(0, idx + 1);
  return path.slice(0, idx);
}

/** Join directory and file segment using the dominant separator in `dir`. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${name}`;
}
