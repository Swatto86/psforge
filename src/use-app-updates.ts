/**
 * Automatic updates, the same way on every WattDrive/WattMail/PSForge build:
 * the signed manifest is checked at launch and every few hours, and a newer
 * release is downloaded, installed and relaunched on its own. The status bar
 * only informs; the manual "Check for updates" item behaves identically.
 *
 * The one thing an install must not do is cut a running script short, so the
 * downloaded update waits until the runner is idle before it is applied.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { check as checkForAppUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { extractInvokeErrorMessage } from "./run-utils";
import type { UpdateStatus } from "./types";

const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_STATUS_RESET_MS = 8_000;
/** Re-check the manifest this often while the app stays open. */
export const UPDATE_RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** How often a downloaded update re-asks whether the runner is idle. */
export const INSTALL_IDLE_POLL_MS = 5_000;

type AvailableAppUpdate = NonNullable<
  Awaited<ReturnType<typeof checkForAppUpdate>>
>;

/** Resolves once `isIdle()` reports true, polling every `pollMs`. */
export async function waitUntilIdle(
  isIdle: () => boolean,
  pollMs: number,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  while (!isIdle()) {
    await sleep(pollMs);
  }
}

export interface AppUpdatesOptions {
  /** Automatic checks run only once settings are loaded and the user has not
   *  turned the startup check off. Manual checks always work. */
  autoCheckEnabled: boolean;
  /** True while a script or debug session is executing; the install waits. */
  isRunning: boolean;
}

export interface AppUpdates {
  updateStatus: UpdateStatus;
  /** Check now. A found update is installed either way; `initiatedByUser`
   *  only decides whether "up to date" and errors are shown in the status bar. */
  checkForUpdates: (initiatedByUser: boolean) => Promise<void>;
}

export function useAppUpdates({
  autoCheckEnabled,
  isRunning,
}: AppUpdatesOptions): AppUpdates {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    phase: "idle",
  });
  const inFlightRef = useRef(false);
  const resetTimerRef = useRef<number | null>(null);
  const autoCheckStartedRef = useRef(false);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const scheduleStatusReset = useCallback(() => {
    clearResetTimer();
    resetTimerRef.current = window.setTimeout(() => {
      setUpdateStatus((prev) =>
        prev.phase === "upToDate" || prev.phase === "error"
          ? { phase: "idle" }
          : prev,
      );
      resetTimerRef.current = null;
    }, UPDATE_STATUS_RESET_MS);
  }, [clearResetTimer]);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const downloadAndInstall = useCallback(
    async (update: AvailableAppUpdate) => {
      let downloadedBytes = 0;
      let totalBytes = 0;
      const progress = () =>
        setUpdateStatus({
          phase: "downloading",
          version: update.version,
          downloadedBytes,
          totalBytes,
        });
      progress();
      try {
        await update.download((event) => {
          switch (event.event) {
            case "Started":
              downloadedBytes = 0;
              totalBytes = event.data.contentLength ?? 0;
              progress();
              break;
            case "Progress":
              downloadedBytes += event.data.chunkLength;
              progress();
              break;
            case "Finished":
              break;
          }
        });
        // Downloaded. Do not replace the binary under a running script.
        await waitUntilIdle(() => !isRunningRef.current, INSTALL_IDLE_POLL_MS);
        setUpdateStatus({ phase: "installing", version: update.version });
        await update.install();
        await relaunch();
      } catch (err) {
        setUpdateStatus({
          phase: "error",
          message: extractInvokeErrorMessage(err),
        });
        scheduleStatusReset();
      } finally {
        void update.close().catch(() => {});
      }
    },
    [scheduleStatusReset],
  );

  const checkForUpdates = useCallback(
    async (initiatedByUser: boolean) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      clearResetTimer();
      setUpdateStatus({ phase: "checking" });
      try {
        const update = await checkForAppUpdate({
          timeout: UPDATE_CHECK_TIMEOUT_MS,
        });
        if (!update) {
          if (initiatedByUser) {
            setUpdateStatus({ phase: "upToDate" });
            scheduleStatusReset();
          } else {
            setUpdateStatus({ phase: "idle" });
          }
          return;
        }
        await downloadAndInstall(update);
      } catch (err) {
        const message = extractInvokeErrorMessage(err);
        if (initiatedByUser) {
          setUpdateStatus({ phase: "error", message });
          scheduleStatusReset();
        } else {
          console.warn("Automatic update check failed:", err);
          setUpdateStatus({ phase: "idle" });
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [clearResetTimer, downloadAndInstall, scheduleStatusReset],
  );

  // Launch check, then a periodic re-check for as long as the app is open.
  useEffect(() => {
    if (!autoCheckEnabled || autoCheckStartedRef.current) return;
    autoCheckStartedRef.current = true;
    void checkForUpdates(false);
    const timer = window.setInterval(
      () => void checkForUpdates(false),
      UPDATE_RECHECK_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [autoCheckEnabled, checkForUpdates]);

  return { updateStatus, checkForUpdates };
}
