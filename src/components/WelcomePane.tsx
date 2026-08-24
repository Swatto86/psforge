/** PSForge Welcome Pane — open-and-run, with paste as a secondary path. */

import React, { useMemo } from "react";
import { useAppState, newTabId, untitledCounter } from "../store";
import type { EditorTab } from "../types";
import { isPowerShellScriptPath } from "../script-utils";
import { basename } from "../path-utils";

export function WelcomePane() {
  const { state, dispatch } = useAppState();

  const recentScripts = useMemo(
    () => state.settings.recentFiles.filter(isPowerShellScriptPath).slice(0, 8),
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

  const pasteRuns = state.settings.runAfterPasteCleanFormat !== false;

  return (
    <div
      data-testid="welcome-pane"
      className="h-full overflow-auto"
      style={{
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        padding: "2.5rem 2rem",
      }}
    >
      <div className="mx-auto" style={{ width: "100%", maxWidth: "640px" }}>
        <div className="mb-8">
          <div
            className="font-bold mb-3"
            style={{
              color: "var(--text-primary)",
              fontSize: "42px",
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
            }}
          >
            PSForge
          </div>
          <h1
            className="font-semibold mb-2"
            style={{
              color: "var(--text-primary)",
              fontSize: "22px",
              lineHeight: 1.3,
            }}
          >
            Open a script. Run it.
          </h1>
          <p
            className="mb-5"
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--ui-font-size-lg)",
              maxWidth: "36rem",
            }}
          >
            Open a saved .ps1, press F5 — it runs in the terminal below, in
            the current PowerShell session (same idea as VS Code). Paste
            remains available when you are iterating with an AI.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              data-testid="welcome-open"
              onClick={handleOpenFile}
              className="btn btn-primary"
              style={{ padding: "10px 18px", fontSize: "var(--ui-font-size-lg)" }}
              title="Ctrl+O"
            >
              Open script…
            </button>
            <button
              data-testid="welcome-paste"
              onClick={() => {
                (
                  window as unknown as Record<string, (() => void) | undefined>
                ).__psforge_pasteFromClipboardAsNewScript?.();
              }}
              className="btn btn-ghost"
              style={{ padding: "8px 12px" }}
              title="Ctrl+Shift+Alt+V — cleans smart quotes and code fences, formats, then runs"
            >
              {pasteRuns ? "Paste + run" : "Paste from clipboard"}
            </button>
            <button
              onClick={createNewFile}
              className="btn btn-ghost"
              style={{ padding: "8px 12px" }}
              title="Ctrl+N"
            >
              New
            </button>
          </div>
        </div>

        <div>
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
                className="btn btn-ghost btn-sm"
                style={{ border: "1px solid var(--border-primary)" }}
              >
                Clear list
              </button>
            )}
          </div>

          {recentScripts.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Scripts you open or save appear here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {recentScripts.map((path, idx) => (
                <li key={path}>
                  <div className="welcome-list-row">
                    <button
                      onClick={() => openPath(path)}
                      className="text-left flex-1 rounded px-1 py-0.5"
                      style={{
                        backgroundColor: "transparent",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        minWidth: 0,
                      }}
                      title={path}
                    >
                      <div
                        className="font-semibold"
                        style={{ color: "var(--text-accent)" }}
                      >
                        {basename(path)}
                      </div>
                      <div
                        className="mt-0.5 break-all"
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
                      className="btn btn-ghost btn-sm"
                      style={{ border: "1px solid var(--border-primary)" }}
                      aria-label={`Remove ${basename(path)} from recent`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
