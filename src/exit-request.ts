/** Exit (File menu or tray) must not silently stop running work. */

export interface ExitRequestDeps {
  /** Tells the backend the webview is handling the request, so its
   *  unresponsive-webview fallback does not force the exit mid-prompt. */
  acknowledge: () => Promise<void>;
  /** A script, debug session or console command is executing. */
  isBusy: () => boolean;
  confirm: (message: string) => Promise<boolean>;
  flushPendingSettings: () => Promise<void>;
  exit: () => Promise<void>;
}

export const EXIT_WHILE_BUSY_MESSAGE =
  "A script or console command is still running.\n\nExit PSForge and stop it?";

/** File > Exit and tray Exit can arrive together; one prompt answers both. */
let exitInFlight = false;

/** Returns true when the app is exiting, false when the user kept it open. */
export async function handleExitRequest(deps: ExitRequestDeps): Promise<boolean> {
  try {
    await deps.acknowledge();
  } catch (err) {
    // Without the acknowledgement the tray fallback may still force the
    // exit; the prompt below is then best effort.
    console.error("Failed to acknowledge exit request:", err);
  }
  if (exitInFlight) return false;
  exitInFlight = true;
  try {
    return await confirmThenExit(deps);
  } finally {
    exitInFlight = false;
  }
}

async function confirmThenExit(deps: ExitRequestDeps): Promise<boolean> {
  if (deps.isBusy()) {
    let confirmed: boolean;
    try {
      confirmed = await deps.confirm(EXIT_WHILE_BUSY_MESSAGE);
    } catch (err) {
      // The user asked to exit; a missing dialog must not trap them.
      console.error("Exit confirmation unavailable; exiting:", err);
      confirmed = true;
    }
    if (!confirmed) return false;
  }
  await deps.flushPendingSettings();
  await deps.exit();
  return true;
}
