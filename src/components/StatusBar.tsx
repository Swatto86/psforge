/** PSForge Status Bar component.
 *  Shows encoding, file path, PS version, and theme info.
 *  Clicking the encoding label opens an inline encoding picker.
 *  Clicking the file path reveals it in Windows Explorer.
 */

import React, { useState, useRef, useEffect } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { UpdateStatus } from "../types";
import { FontQuickControls } from "./FontQuickControls";
import { resolveExecutionWorkDir } from "../run-utils";

interface StatusBarProps {
  updateStatus: UpdateStatus;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
}

function formatUpdateProgress(
  downloadedBytes: number,
  totalBytes: number,
): string {
  if (totalBytes > 0) {
    const percent = Math.max(
      0,
      Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)),
    );
    return `${percent}%`;
  }
  if (downloadedBytes <= 0) return "starting";
  return `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StatusBar({
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
}: StatusBarProps) {
  const { state, activeTab, dispatch } = useAppState();
  const [showEncodingPicker, setShowEncodingPicker] = useState(false);
  const encodingRef = useRef<HTMLDivElement>(null);

  // Close encoding picker on outside click.
  useEffect(() => {
    if (!showEncodingPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        encodingRef.current &&
        !encodingRef.current.contains(e.target as Node)
      ) {
        setShowEncodingPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showEncodingPicker]);

  const encodingLabel = (enc: string): string => {
    switch (enc) {
      case "utf8bom":
        return "UTF-8 with BOM";
      case "utf16le":
        return "UTF-16 LE";
      case "utf16be":
        return "UTF-16 BE";
      default:
        return "UTF-8";
    }
  };

  const encodingOptions: { value: string; label: string }[] = [
    { value: "utf8", label: "UTF-8" },
    { value: "utf8bom", label: "UTF-8 with BOM" },
    { value: "utf16le", label: "UTF-16 LE" },
    { value: "utf16be", label: "UTF-16 BE" },
  ];

  const psVersion = state.psVersions.find(
    (v) => v.path === state.selectedPsPath,
  );

  const formatRunDuration = (ms: number): string => {
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  };

  const lastRun = state.lastRunResult;
  const lastRunLabel =
    lastRun && !state.isRunning
      ? lastRun.exitCode === null
        ? `Run failed · ${formatRunDuration(lastRun.durationMs)}`
        : lastRun.exitCode === 0
          ? `Exit 0 · ${formatRunDuration(lastRun.durationMs)}`
          : `Exit ${lastRun.exitCode} · ${formatRunDuration(lastRun.durationMs)}`
      : null;

  const runCwd =
    activeTab && activeTab.tabType !== "welcome"
      ? resolveExecutionWorkDir(
          activeTab,
          state.workingDir,
          state.settings.workingDirMode,
          state.settings.customWorkingDir,
          state.settings.pinnedRunDir ?? "",
          () => (typeof navigator !== "undefined" && /win/i.test(navigator.platform) ? "C:\\" : "/"),
        )
      : null;

  /** Link controls on the status bar — do not use --accent (same hue as --bg-statusbar). */
  const statusBarLinkStyle: React.CSSProperties = {
    backgroundColor: "transparent",
    color: "var(--text-inverse)",
    cursor: "pointer",
    fontSize: "inherit",
  };

  const renderUpdateControl = () => {
    switch (updateStatus.phase) {
      case "checking":
        return (
          <span data-testid="status-update-checking">Checking updates...</span>
        );
      case "available":
        return (
          <button
            data-testid="status-update-install"
            onClick={onInstallUpdate}
            title={
              updateStatus.notes
                ? `Install PSForge ${updateStatus.version}\n\n${updateStatus.notes}`
                : `Install PSForge ${updateStatus.version}`
            }
            style={{
              ...statusBarLinkStyle,
              fontWeight: 600,
              backgroundColor: "rgba(255, 255, 255, 0.18)",
              paddingLeft: "6px",
              paddingRight: "6px",
              borderRadius: "3px",
              textDecoration: "none",
            }}
          >
            Update {updateStatus.version} available
          </button>
        );
      case "downloading":
        return (
          <span data-testid="status-update-progress">
            Updating{" "}
            {formatUpdateProgress(
              updateStatus.downloadedBytes,
              updateStatus.totalBytes,
            )}
          </span>
        );
      case "installing":
        return (
          <span data-testid="status-update-installing">
            Installing {updateStatus.version}...
          </span>
        );
      case "upToDate":
        return <span data-testid="status-update-uptodate">Up to date</span>;
      case "error":
        return (
          <button
            data-testid="status-update-error"
            onClick={onCheckForUpdates}
            title={updateStatus.message}
            className="status-link"
            style={{ color: "var(--stream-stderr)" }}
          >
            Update check failed
          </button>
        );
      case "idle":
      default:
        return (
          <button
            data-testid="status-update-check"
            onClick={onCheckForUpdates}
            className="status-link"
            title="Check GitHub Releases for a newer PSForge version"
          >
            Check for Updates
          </button>
        );
    }
  };

  return (
    <div
      data-testid="status-bar"
      className="flex items-center justify-between py-0.5 text-sm no-select"
      style={{
        backgroundColor: "var(--bg-statusbar)",
        color: "var(--text-inverse)",
        minHeight: "26px",
        paddingLeft: "12px",
        paddingRight: "12px",
      }}
    >
      {/* Left side */}
      <div className="flex items-center gap-4">
        {/* Encoding -- click to change */}
        {activeTab && activeTab.tabType !== "welcome" && (
          <div ref={encodingRef} className="relative">
            <button
              onClick={() => setShowEncodingPicker((v) => !v)}
              title="Click to change encoding"
              className="status-link"
              style={{ textDecoration: "none" }}
            >
              {encodingLabel(activeTab.encoding)}
            </button>

            {showEncodingPicker && (
              <div
                className="menu-pop"
                style={{
                  bottom: "100%",
                  left: 0,
                  marginBottom: "4px",
                  minWidth: "160px",
                }}
              >
                {encodingOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      dispatch({
                        type: "UPDATE_TAB",
                        id: activeTab.id,
                        changes: { encoding: opt.value, isDirty: true },
                      });
                      setShowEncodingPicker(false);
                    }}
                    className="menu-item flex items-center gap-2"
                    style={{
                      backgroundColor:
                        activeTab.encoding === opt.value
                          ? "var(--bg-hover)"
                          : undefined,
                      fontSize: "var(--ui-font-size-xs)",
                    }}
                  >
                    {activeTab.encoding === opt.value ? (
                      <span style={{ color: "var(--text-accent)" }}>
                        &#10003;
                      </span>
                    ) : (
                      <span
                        style={{ width: "12px", display: "inline-block" }}
                      />
                    )}
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* File path -- click to reveal in Explorer.
             direction:rtl makes text-overflow:ellipsis trim from the LEFT,
             so the filename at the end of the path is always visible —
             matching VS Code status bar behaviour. */}
        {activeTab?.filePath && (
          <button
            onClick={() =>
              cmd.revealInExplorer(activeTab.filePath).catch(() => {})
            }
            className="status-link"
            style={{
              maxWidth: "500px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
              textAlign: "left",
            }}
            title={`Reveal in Explorer: ${activeTab.filePath}`}
          >
            {activeTab.filePath}
          </button>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-4">
        {state.isDebugging ? (
          <span className="flex items-center gap-1">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                state.debugPaused
                  ? "bg-yellow-300"
                  : "bg-green-400 animate-pulse"
              }`}
            />
            {state.debugPaused ? "Debug Paused" : "Debugging"}
            {state.debugLine ? ` (Ln ${state.debugLine})` : ""}
          </span>
        ) : state.isRunning ? (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Running
          </span>
        ) : (
          lastRunLabel && (
            <button
              type="button"
              data-testid="status-last-run"
              onClick={() => {
                void (
                  window as unknown as Record<string, (() => Promise<void>) | undefined>
                ).__psforge_copy_debug_bundle?.();
              }}
              className="status-link"
              style={{
                fontVariantNumeric: "tabular-nums",
                color:
                  lastRun?.exitCode === 0
                    ? "var(--text-inverse)"
                    : "var(--stream-stderr)",
              }}
              title="Copy debug bundle for AI (last run output, exit code, PSSA)"
            >
              {lastRunLabel} · Copy bundle
            </button>
          )
        )}
        {renderUpdateControl()}
        {runCwd && (
          <button
            data-testid="status-run-cwd"
            onClick={() => {
              const isPinned = state.settings.workingDirMode === "pinned";
              dispatch({
                type: "SET_SETTINGS",
                settings: {
                  ...state.settings,
                  // Toggle: clicking a pinned directory unpins it (runs use each
                  // file's own folder again); clicking an unpinned one pins it.
                  workingDirMode: isPinned ? "file" : "pinned",
                  ...(isPinned ? {} : { pinnedRunDir: runCwd }),
                },
              });
            }}
            title={
              state.settings.workingDirMode === "pinned"
                ? `Run directory pinned to ${runCwd}. Click to unpin (runs use each file's folder).`
                : `Run directory: ${runCwd}. Click to pin it for all runs.`
            }
            className="status-link"
            style={{
              maxWidth: "220px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {state.settings.workingDirMode === "pinned" ? "📌 Pinned: " : "Run: "}
            {runCwd}
          </button>
        )}
        <FontQuickControls />
        {psVersion && <span>{psVersion.name}</span>}
        {activeTab && activeTab.tabType !== "welcome" && (
          <span
            style={{ fontVariantNumeric: "tabular-nums" }}
            title="Cursor position"
          >
            Ln {state.cursorLine}, Col {state.cursorColumn}
          </span>
        )}
        <span className="capitalize">{state.settings.theme}</span>
      </div>
    </div>
  );
}
