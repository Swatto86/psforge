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

  const shortcuts: [string, string][] = [
    ["Ctrl+N", "New file"],
    ["Ctrl+O", "Open file"],
    ["Ctrl+S", "Save file"],
    ["F5", "Run script"],
    ["F8", "Run selection"],
    ["Ctrl+Break", "Stop script"],
    ["Ctrl+H", "Find & Replace"],
    ["Ctrl+Shift+P", "Command palette"],
    ["Ctrl+,", "Settings"],
    ["Ctrl+B", "Toggle sidebar"],
    ["Ctrl+=", "Increase font size"],
    ["Ctrl+-", "Decrease font size"],
  ];

  return (
    <div
      className="flex flex-col items-center overflow-auto h-full"
      style={{
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: "600px", width: "100%" }}>
        {/* Header */}
        <div className="mb-6">
          <h1
            className="text-2xl font-bold mb-1"
            style={{ color: "var(--text-accent)" }}
          >
            Welcome to PS Forge
          </h1>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            A modern PowerShell editor built on Tauri + Monaco
          </p>
        </div>

        {/* Quick start */}
        <div className="mb-6">
          <h2
            className="text-xs font-semibold uppercase mb-2"
            style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
          >
            Get Started
          </h2>
          <div className="flex gap-2">
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

        {/* Recent files */}
        {state.settings.recentFiles.length > 0 && (
          <div className="mb-6">
            <h2
              className="text-xs font-semibold uppercase mb-2"
              style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
            >
              Recent Files
            </h2>
            <ul className="flex flex-col gap-0.5">
              {state.settings.recentFiles.slice(0, 8).map((path) => {
                const name = path.split("\\").pop() ?? path;
                return (
                  <li key={path}>
                    <button
                      onClick={() => {
                        const fn = (
                          window as unknown as Record<string, unknown>
                        ).__psforge_openFileByPath as
                          | ((p: string) => void)
                          | undefined;
                        fn?.(path);
                      }}
                      className="text-xs text-left w-full px-2 py-1 rounded transition-colors"
                      style={{
                        backgroundColor: "transparent",
                        color: "var(--text-accent)",
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
                      <span className="font-medium">{name}</span>
                      <span
                        className="ml-2 opacity-50"
                        style={{ fontSize: "10px" }}
                      >
                        {path}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Keyboard shortcuts */}
        <div>
          <h2
            className="text-xs font-semibold uppercase mb-2"
            style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
          >
            Keyboard Shortcuts
          </h2>
          <table className="w-full text-xs">
            <tbody>
              {shortcuts.map(([key, desc]) => (
                <tr
                  key={key}
                  style={{ borderBottom: "1px solid var(--border-primary)" }}
                >
                  <td className="py-1.5 pr-4" style={{ width: "140px" }}>
                    <kbd
                      className="px-1.5 py-0.5 rounded text-xs font-mono"
                      style={{
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border-primary)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {key}
                    </kbd>
                  </td>
                  <td
                    className="py-1.5"
                    style={{ color: "var(--text-secondary)" }}
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
      className="px-3 py-2 rounded text-xs"
      style={{
        backgroundColor: "var(--btn-primary-bg)",
        color: "var(--btn-primary-fg)",
        border: "none",
        cursor: "pointer",
      }}
    >
      {label}
      <span className="ml-2 opacity-60" style={{ fontSize: "10px" }}>
        {hint}
      </span>
    </button>
  );
}
