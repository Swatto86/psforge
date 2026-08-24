/** PSForge Status Bar — live run context only. */

import React, { useState, useRef, useEffect } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { UpdateStatus } from "../types";
import { resolveExecutionWorkDir } from "../run-utils";
import { applyRunDirPreset } from "../run-dir-presets";

interface StatusBarProps {
  updateStatus: UpdateStatus;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
}

/** Fixed-width check slot so menu labels align whether checked or not. */
function MenuCheck({ on }: { on: boolean }) {
  return on ? (
    <span style={{ color: "var(--text-accent)" }}>&#10003;</span>
  ) : (
    <span style={{ width: "12px", display: "inline-block" }} />
  );
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
  const [showRunDirMenu, setShowRunDirMenu] = useState(false);
  const runDirRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showRunDirMenu) return;
    const handler = (e: MouseEvent) => {
      if (runDirRef.current && !runDirRef.current.contains(e.target as Node)) {
        setShowRunDirMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showRunDirMenu]);

  const formatRunDuration = (ms: number): string => {
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  };

  const lastRun = state.lastRunResult;
  const lastRunLabel =
    lastRun && !state.isRunning
      ? lastRun.exitCode === null
        ? `Failed · ${formatRunDuration(lastRun.durationMs)}`
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
          () =>
            typeof navigator !== "undefined" && /win/i.test(navigator.platform)
              ? "C:\\"
              : "/",
        )
      : null;

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
      case "upToDate":
      case "idle":
      default:
        // Idle / up-to-date stays out of the bar — Help → Check for Updates.
        return null;
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
      <div className="flex items-center gap-4 min-w-0 flex-1">
        {runCwd && (
          <div ref={runDirRef} className="relative min-w-0">
            <button
              data-testid="status-run-cwd"
              onClick={() => setShowRunDirMenu((v) => !v)}
              title={`Run directory: ${runCwd}. Click to change it.`}
              className="status-link"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "block",
                maxWidth: "100%",
              }}
            >
              {state.settings.workingDirMode === "pinned" ? "Pinned: " : "Run: "}
              {runCwd}
            </button>

            {showRunDirMenu && (
              <div
                data-testid="run-dir-menu"
                className="menu-pop"
                style={{
                  bottom: "100%",
                  left: 0,
                  marginBottom: "4px",
                  minWidth: "260px",
                  maxWidth: "420px",
                }}
              >
                <div className="menu-header">Run directory</div>
                <button
                  data-testid="run-dir-use-file"
                  onClick={() => {
                    dispatch({
                      type: "SET_SETTINGS",
                      settings: {
                        ...state.settings,
                        workingDirMode: "file",
                      },
                    });
                    setShowRunDirMenu(false);
                  }}
                  className="menu-item flex items-center gap-2"
                  style={{ fontSize: "var(--ui-font-size-xs)" }}
                >
                  <MenuCheck on={state.settings.workingDirMode === "file"} />
                  Use each file&apos;s own folder
                </button>
                <button
                  data-testid="run-dir-pin-current"
                  onClick={() => {
                    dispatch({
                      type: "SET_SETTINGS",
                      settings: {
                        ...state.settings,
                        workingDirMode: "pinned",
                        pinnedRunDir: runCwd,
                      },
                    });
                    setShowRunDirMenu(false);
                  }}
                  className="menu-item flex items-center gap-2"
                  style={{ fontSize: "var(--ui-font-size-xs)" }}
                  title={runCwd}
                >
                  <MenuCheck
                    on={
                      state.settings.workingDirMode === "pinned" &&
                      state.settings.pinnedRunDir.trim() === runCwd
                    }
                  />
                  Pin current: {runCwd}
                </button>
                <button
                  data-testid="run-dir-browse"
                  onClick={() => {
                    void (async () => {
                      try {
                        const { open } = await import(
                          "@tauri-apps/plugin-dialog"
                        );
                        const selected = await open({
                          directory: true,
                          multiple: false,
                        });
                        if (typeof selected === "string" && selected.trim()) {
                          dispatch({
                            type: "SET_SETTINGS",
                            settings: {
                              ...state.settings,
                              workingDirMode: "pinned",
                              pinnedRunDir: selected,
                            },
                          });
                        }
                      } catch {
                        // dialog unavailable/cancelled
                      }
                      setShowRunDirMenu(false);
                    })();
                  }}
                  className="menu-item flex items-center gap-2"
                  style={{ fontSize: "var(--ui-font-size-xs)" }}
                >
                  <MenuCheck on={false} />
                  Choose folder…
                </button>
                {(state.settings.runDirPresets ?? []).filter(
                  (p) => p.path.trim() !== "",
                ).length > 0 && (
                  <>
                    <div className="menu-header">Presets</div>
                    {(state.settings.runDirPresets ?? [])
                      .filter((p) => p.path.trim() !== "")
                      .map((preset) => (
                        <button
                          key={preset.name}
                          data-testid={`run-dir-preset-${preset.name}`}
                          onClick={() => {
                            dispatch({
                              type: "SET_SETTINGS",
                              settings: applyRunDirPreset(
                                state.settings,
                                preset.name,
                              ),
                            });
                            setShowRunDirMenu(false);
                          }}
                          className="menu-item flex items-center gap-2"
                          style={{ fontSize: "var(--ui-font-size-xs)" }}
                          title={preset.path}
                        >
                          <MenuCheck
                            on={
                              state.settings.workingDirMode === "pinned" &&
                              state.settings.pinnedRunDir.trim() ===
                                preset.path.trim()
                            }
                          />
                          {preset.name}
                        </button>
                      ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {activeTab?.filePath && (
          <button
            onClick={() =>
              cmd.revealInExplorer(activeTab.filePath).catch(() => {})
            }
            className="status-link"
            style={{
              maxWidth: "420px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
              textAlign: "left",
              flexShrink: 1,
            }}
            title={`Reveal in Explorer: ${activeTab.filePath}`}
          >
            {activeTab.filePath}
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 shrink-0">
        {state.isDebugging ? (
          <span className="flex items-center gap-1">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                state.debugPaused
                  ? "bg-yellow-300"
                  : "bg-green-400 animate-pulse"
              }`}
            />
            {state.debugPaused ? "Paused" : "Debugging"}
            {state.debugLine ? ` (Ln ${state.debugLine})` : ""}
          </span>
        ) : state.isRunning ? (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Running
          </span>
        ) : (
          lastRunLabel && (
            <span
              data-testid="status-last-run"
              style={{
                fontVariantNumeric: "tabular-nums",
                color:
                  lastRun?.exitCode === 0
                    ? "var(--text-inverse)"
                    : "var(--stream-stderr)",
              }}
              title="Last run result"
            >
              {lastRunLabel}
            </span>
          )
        )}
        {renderUpdateControl()}
        {activeTab && activeTab.tabType !== "welcome" && (
          <span
            style={{ fontVariantNumeric: "tabular-nums" }}
            title="Cursor position"
          >
            Ln {state.cursorLine}, Col {state.cursorColumn}
          </span>
        )}
      </div>
    </div>
  );
}
