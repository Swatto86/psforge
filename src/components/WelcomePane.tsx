/** PSForge Welcome Pane — script-runner focused quick start. */

import React, { useMemo } from "react";
import { useAppState, newTabId, untitledCounter } from "../store";
import type { EditorTab } from "../types";
import { isPowerShellScriptPath } from "../script-utils";
import { basename } from "../path-utils";

export function WelcomePane() {
  const { state, dispatch } = useAppState();

  const recentScripts = useMemo(
    () => state.settings.recentFiles.filter(isPowerShellScriptPath).slice(0, 12),
    [state.settings.recentFiles],
  );

  const createNewFile = () => {
    const id = newTabId();
    const tab: EditorTab = {
      id,
      title: `Untitled-${untitledCounter()}`,
      filePath: "",
      content: "",
      savedContent: "",
      encoding: "utf8",
      language: "powershell",
      isDirty: false,
      tabType: "code",
    };
    dispatch({ type: "ADD_TAB", tab });
    const welcomeTab = state.tabs.find((t) => t.tabType === "welcome");
    if (welcomeTab) {
      dispatch({ type: "CLOSE_TAB", id: welcomeTab.id });
    }
  };

  const handleOpenFile = () => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_openFile as (() => void) | undefined;
    fn?.();
  };

  const handleOpenFolder = () => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_openFolder as (() => void) | undefined;
    fn?.();
  };

  const openPath = (path: string) => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_openFileByPath as ((p: string) => void) | undefined;
    fn?.(path);
  };

  const removeRecentFile = (path: string) => {
    dispatch({ type: "REMOVE_RECENT_FILE", path });
  };

  const clearRecentFiles = () => {
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, recentFiles: [] },
    });
  };

  return (
    <div
      data-testid="welcome-pane"
      className="h-full overflow-auto"
      style={{
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        padding: "2.25rem",
      }}
    >
      <div className="mx-auto" style={{ width: "100%", maxWidth: "920px" }}>
        <div
          className="mb-6 rounded-lg p-5"
          style={{
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
          }}
        >
          <h1
            className="font-bold mb-2"
            style={{
              color: "var(--text-accent)",
              fontSize: "30px",
              lineHeight: 1.2,
            }}
          >
            Run your PowerShell scripts
          </h1>
          <p
            className="mb-4"
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--ui-font-size-lg)",
            }}
          >
            Open a script, press F5, and read the output in the terminal below.
            Diagnostics and help live in the Reference tab when you need them.
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionButton onClick={createNewFile} label="New script" hint="Ctrl+N" />
            <ActionButton onClick={handleOpenFile} label="Open script" hint="Ctrl+O" />
            <ActionButton
              onClick={handleOpenFolder}
              label="Open folder"
              hint="Loads .ps1 / .psm1 / .psd1"
              secondary
            />
          </div>
        </div>

        <div
          className="rounded-lg p-4"
          style={{
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
          }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2
              className="text-xs font-semibold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
            >
              Recent scripts
            </h2>
            {recentScripts.length > 0 && (
              <button
                onClick={clearRecentFiles}
                className="text-xs rounded px-2 py-1"
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-primary)",
                }}
              >
                Clear list
              </button>
            )}
          </div>

          {recentScripts.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Scripts you open or save appear here for quick access.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recentScripts.map((path, idx) => (
                <li key={path}>
                  <div
                    className="flex items-start gap-2 rounded p-2"
                    style={{
                      backgroundColor: "var(--bg-primary)",
                      border: "1px solid var(--border-primary)",
                    }}
                  >
                    <button
                      onClick={() => openPath(path)}
                      className="text-left flex-1 rounded px-1 py-0.5 transition-colors"
                      style={{
                        backgroundColor: "transparent",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                      }}
                      title={path}
                    >
                      <div
                        className="font-semibold"
                        style={{
                          color: "var(--text-accent)",
                          fontSize: "var(--ui-font-size-lg)",
                        }}
                      >
                        {basename(path)}
                      </div>
                      <div
                        className="mt-1 break-all"
                        style={{
                          color: "var(--text-secondary)",
                          fontSize: "var(--ui-font-size-sm)",
                        }}
                      >
                        {path}
                      </div>
                    </button>
                    <button
                      data-testid={`welcome-recent-remove-${idx}`}
                      onClick={() => removeRecentFile(path)}
                      className="rounded px-2 py-1 text-xs"
                      style={{
                        backgroundColor: "transparent",
                        border: "1px solid var(--border-primary)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p
          className="mt-4 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          Tip: enable auto-save and a larger terminal in Settings → Execution / Output.
          Press Ctrl+Shift+P for the command palette.
        </p>
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  label,
  hint,
  secondary = false,
}: {
  onClick: () => void;
  label: string;
  hint: string;
  secondary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded"
      style={{
        backgroundColor: secondary
          ? "var(--bg-tertiary)"
          : "var(--btn-primary-bg)",
        color: secondary ? "var(--text-primary)" : "var(--btn-primary-fg)",
        border: secondary ? "1px solid var(--border-primary)" : "none",
        cursor: "pointer",
        fontSize: "var(--ui-font-size-base)",
        fontWeight: 600,
      }}
      title={hint}
    >
      {label}
    </button>
  );
}
