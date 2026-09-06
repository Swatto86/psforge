import type { Terminal, ITheme } from "@xterm/xterm";
import type { SessionReaders } from "./session-readers";

/** What the session needs to read from the owning component, when it asks. */
export type ConsoleSessionContext = {
  shellPath: () => string;
  loadProfile: () => boolean;
  /** Command sent once per PTY, e.g. Enter-PSSession for a remote tab. */
  startupCommand: () => string;
  /** Whether this console is the visible one; gates module suggestions. */
  isActive: () => boolean;
};

export type ConsoleSession = {
  readonly term: Terminal;
  readonly readers: SessionReaders;
  /** Wipe the display and (re)spawn PowerShell. Also the Clear action. */
  restart: () => void;
  isReady: () => boolean;
  isStarting: () => boolean;
  queueInput: (data: string, allowWhenNotReady?: boolean) => void;
  exec: (command: string) => Promise<number | null>;
  focus: () => void;
  /** Clear the xterm buffer without touching the PowerShell session. */
  clearBuffer: () => void;
  writeLocal: (text: string) => void;
  pasteText: (text: string) => void;
  applyFont: (fontFamily: string, fontSize: number) => void;
  applyTheme: (theme: ITheme) => void;
  /** Re-fit, repaint and focus after this console becomes visible. */
  syncActive: () => void;
  dispose: () => void;
};

