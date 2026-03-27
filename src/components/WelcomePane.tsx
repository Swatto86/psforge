/** PSForge Welcome Pane.
 *  Displayed on first launch in place of the Monaco editor.
 *  Shows keyboard shortcuts, quick-start actions, and recent files.
 *
 *  File-open actions are dispatched through the window globals set by App.tsx:
 *  - window.__psforge_openFile()         -- opens the file-picker dialog
 *  - window.__psforge_openFileByPath(p)  -- opens a specific path directly
 */

import React from "react";
import { useAppState, newTabId, untitledCounter } from "../store";
import type { EditorTab } from "../types";

export function WelcomePane() {
  const { state, dispatch } = useAppState();

  /** Opens a new untitled PowerShell script tab, replacing the welcome tab. */
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
    // Close the welcome tab so the user starts with a clean workspace.
    const welcomeTab = state.tabs.find((t) => t.tabType === "welcome");
    if (welcomeTab) {
      dispatch({ type: "CLOSE_TAB", id: welcomeTab.id });
    }
  };

  /** Delegates to the global file-picker function registered by App.tsx.
   *  Indirection is needed because App.tsx owns the Tauri dialog call site.
   */
  const handleOpenFile = () => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_openFile as (() => void) | undefined;
    fn?.();
  };

  /** Remove a path from the recent-files list. */
  const removeRecentFile = (path: string) => {
    dispatch({ type: "REMOVE_RECENT_FILE", path });
  };

  /** Clear all recent-file entries from settings. */
  const clearRecentFiles = () => {
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, recentFiles: [] },
    });
  };

  const shortcuts: [string, string][] = [
    ["Ctrl+N", "New file"],
    ["Ctrl+O", "Open file"],
    ["Ctrl+S", "Save file"],
    ["Ctrl+Shift+S", "Save all files"],
    ["F5", "Run script"],
    ["F8", "Run selection / current line"],
    ["Ctrl+Break", "Stop script"],
    ["Ctrl+H", "Find & Replace"],
    ["Ctrl+J", "Insert snippet (ISE style)"],
    ["Ctrl+Shift+P", "Command palette"],
    ["Ctrl+,", "Settings"],
    ["Ctrl+B", "Toggle sidebar"],
    ["Ctrl+=", "Increase font size"],
    ["Ctrl+-", "Decrease font size"],
  ];

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
      <div
        className="mx-auto"
        style={{ width: "100%", maxWidth: "980px" }}
      >
        {/* Header */}
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
              fontSize: "32px",
              lineHeight: 1.2,
            }}
          >
            Welcome to PSForge
          </h1>
          <p
            className="mb-4"
            style={{ color: "var(--text-secondary)", fontSize: "var(--ui-font-size-lg)" }}
          >
            A modern PowerShell editor built on Tauri + Monaco
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionButton
              onClick={createNewFile}
              label="New File"
              hint="Ctrl+N"
            />
            <ActionButton
              onClick={handleOpenFile}
              label="Open File"
              hint="Ctrl+O"
            />
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Recent files */}
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
                Recent Files
              </h2>
              {state.settings.recentFiles.length > 0 && (
                <button
                  onClick={clearRecentFiles}
                  className="text-xs rounded px-2 py-1"
                  style={{
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-primary)",
                  }}
                  title="Remove all recent files"
                >
                  Remove all
                </button>
              )}
            </div>

            {state.settings.recentFiles.length === 0 ? (
              <p
                className="text-sm"
                style={{ color: "var(--text-muted)" }}
              >
                No recent files yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {state.settings.recentFiles.slice(0, 10).map((path, idx) => {
                  const name = path.split("\\").pop() ?? path;
                  return (
                    <li key={path}>
                      <div
                        className="flex items-start gap-2 rounded p-2"
                        style={{
                          backgroundColor: "var(--bg-primary)",
                          border: "1px solid var(--border-primary)",
                        }}
                      >
                        <button
                          onClick={() => {
                            const fn = (
                              window as unknown as Record<string, unknown>
                            ).__psforge_openFileByPath as
                              | ((p: string) => void)
                              | undefined;
                            fn?.(path);
                          }}
                          className="text-left flex-1 rounded px-1 py-0.5 transition-colors"
                          style={{
                            backgroundColor: "transparent",
                            color: "var(--text-primary)",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.backgroundColor =
                              "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.backgroundColor =
                              "transparent";
                          }}
                          title={path}
                        >
                          <div
                            className="font-semibold"
                            style={{ color: "var(--text-accent)", fontSize: "var(--ui-font-size-lg)" }}
                          >
                            {name}
                          </div>
                          <div
                            className="mt-1 break-all"
                            style={{ color: "var(--text-secondary)", fontSize: "var(--ui-font-size-sm)" }}
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
                          title={`Remove ${name} from recent files`}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Keyboard shortcuts */}
          <div
            className="rounded-lg p-4"
            style={{
              backgroundColor: "var(--bg-secondary)",
              border: "1px solid var(--border-primary)",
            }}
          >
            <h2
              className="text-xs font-semibold uppercase mb-3"
              style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
            >
              Keyboard Shortcuts
            </h2>
            <table className="w-full">
              <tbody>
                {shortcuts.map(([key, desc]) => (
                  <tr
                    key={key}
                    style={{ borderBottom: "1px solid var(--border-primary)" }}
                  >
                    <td className="py-2 pr-3" style={{ width: "162px" }}>
                      <kbd
                        className="px-2 py-0.5 rounded font-mono"
                        style={{
                          backgroundColor: "var(--bg-tertiary)",
                          border: "1px solid var(--border-primary)",
                          color: "var(--text-primary)",
                          fontSize: "var(--ui-font-size-sm)",
                        }}
                      >
                        {key}
                      </kbd>
                    </td>
                    <td
                      className="py-2"
                      style={{ color: "var(--text-secondary)", fontSize: "var(--ui-font-size-base)" }}
                    >
                      {desc}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  label,
  hint,
}: {
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded"
      style={{
        backgroundColor: "var(--btn-primary-bg)",
        color: "var(--btn-primary-fg)",
        border: "none",
        cursor: "pointer",
        fontSize: "var(--ui-font-size-base)",
        fontWeight: 600,
      }}
    >
      {label}
      <span className="ml-2 opacity-70" style={{ fontSize: "var(--ui-font-size-sm)" }}>
        {hint}
      </span>
    </button>
  );
}

