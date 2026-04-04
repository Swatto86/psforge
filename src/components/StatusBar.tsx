/** PSForge Status Bar component.
 *  Shows encoding, file path, PS version, and theme info.
 *  Clicking the encoding label opens an inline encoding picker.
 *  Clicking the file path reveals it in Windows Explorer.
 */

import React, { useState, useRef, useEffect } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { UpdateStatus } from "../types";

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
              backgroundColor: "transparent",
              color: "var(--accent)",
              cursor: "pointer",
              textDecoration: "underline",
              fontSize: "inherit",
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
            style={{
              backgroundColor: "transparent",
              color: "var(--stream-stderr)",
              cursor: "pointer",
              textDecoration: "underline",
              fontSize: "inherit",
            }}
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
            style={{
              backgroundColor: "transparent",
              color: "var(--text-inverse)",
              cursor: "pointer",
              opacity: 0.9,
              fontSize: "inherit",
            }}
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
              className="transition-opacity"
              style={{
                backgroundColor: "transparent",
                color: "var(--text-inverse)",
                cursor: "pointer",
                opacity: 0.9,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = "0.9";
              }}
            >
              {encodingLabel(activeTab.encoding)}
            </button>

            {showEncodingPicker && (
              <div
                className="absolute z-50 py-1 rounded shadow-lg"
                style={{
                  bottom: "100%",
                  left: 0,
                  marginBottom: "4px",
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-primary)",
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
                    className="flex items-center gap-2 w-full px-3 py-1 text-left text-xs"
                    style={{
                      backgroundColor:
                        activeTab.encoding === opt.value
                          ? "var(--bg-hover)"
                          : "transparent",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        activeTab.encoding === opt.value
                          ? "var(--bg-hover)"
                          : "transparent";
                    }}
                  >
                    {activeTab.encoding === opt.value && (
                      <span style={{ color: "var(--text-accent)" }}>
                        &#10003;
                      </span>
                    )}
                    {activeTab.encoding !== opt.value && (
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
            className="transition-opacity"
            style={{
              backgroundColor: "transparent",
              color: "var(--text-inverse)",
              cursor: "pointer",
              maxWidth: "500px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: 0.9,
              fontSize: "inherit",
              direction: "rtl",
              textAlign: "left",
            }}
            title={`Reveal in Explorer: ${activeTab.filePath}`}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "1";
              (e.currentTarget as HTMLElement).style.textDecoration =
                "underline";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "0.9";
              (e.currentTarget as HTMLElement).style.textDecoration = "none";
            }}
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
        ) : (
          state.isRunning && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              Running
            </span>
          )
        )}
        {renderUpdateControl()}
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
