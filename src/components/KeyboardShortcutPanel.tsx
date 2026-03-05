/** PSForge Keyboard Shortcut Reference Panel.
 *
 *  Displays a searchable, categorised list of all keyboard shortcuts available
 *  in PSForge.  Opened with F1 or the "?" toolbar button; closed with Escape
 *  or the close button.
 *
 *  The panel is a modal overlay so it is always readable regardless of the
 *  current editor content.  Shortcuts are grouped by category to mirror the
 *  PowerShell ISE "Help > Keyboard Shortcuts" dialog style.
 */

import React, { useState, useEffect, useRef } from "react";
import { useAppState } from "../store";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface ShortcutEntry {
  /** Keyboard combination as a user-readable string. */
  keys: string;
  /** What the shortcut does. */
  description: string;
}

interface ShortcutGroup {
  /** Section heading. */
  category: string;
  shortcuts: ShortcutEntry[];
}

/** All PSForge keyboard shortcuts, grouped by category. */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    category: "File",
    shortcuts: [
      { keys: "Ctrl+N", description: "New file tab" },
      { keys: "Ctrl+O", description: "Open file" },
      { keys: "Ctrl+S", description: "Save current file" },
    ],
  },
  {
    category: "Script Execution",
    shortcuts: [
      { keys: "F5", description: "Run script" },
      { keys: "F8", description: "Run selected text" },
      { keys: "Ctrl+Break", description: "Stop running script" },
    ],
  },
  {
    category: "Editor",
    shortcuts: [
      { keys: "Ctrl+H", description: "Find and Replace" },
      { keys: "Ctrl+F", description: "Find (Monaco built-in)" },
      { keys: "Ctrl+G", description: "Go to line" },
      { keys: "Ctrl+Z", description: "Undo (Monaco built-in)" },
      { keys: "Ctrl+Y", description: "Redo (Monaco built-in)" },
      { keys: "Ctrl+/", description: "Toggle line comment (Monaco built-in)" },
      { keys: "Ctrl+=", description: "Increase editor font size" },
      { keys: "Ctrl+-", description: "Decrease editor font size" },
      {
        keys: "Shift+Alt+F",
        description: "Format document (requires PSScriptAnalyzer)",
      },
    ],
  },
  {
    category: "Interface",
    shortcuts: [
      { keys: "Ctrl+Shift+P", description: "Open Command Palette" },
      { keys: "Ctrl+,", description: "Open Settings" },
      { keys: "Ctrl+B", description: "Toggle sidebar" },
      { keys: "F1", description: "Open this keyboard shortcut reference" },
      { keys: "Escape", description: "Close palette / settings / this panel" },
    ],
  },
  {
    category: "Tabs",
    shortcuts: [
      { keys: "Ctrl+W", description: "Close current tab (browser shortcut)" },
      {
        keys: "Drag & Drop",
        description: "Reorder tabs by dragging them",
      },
    ],
  },
  {
    category: "Script Tools",
    shortcuts: [
      {
        keys: "Shift+Alt+F",
        description: "Format document with Invoke-Formatter",
      },
      {
        keys: "Toolbar: Profile button",
        description: "Open $PROFILE for editing",
      },
      { keys: "Toolbar: Print button", description: "Print current script" },
      {
        keys: "Toolbar: Sign button",
        description: "Sign script with Authenticode certificate",
      },
      {
        keys: "Drag & Drop (file)",
        description: "Drop a .ps1 / .psm1 file onto the window to open it",
      },
    ],
  },
  {
    category: "Output Pane",
    shortcuts: [
      {
        keys: "Stdin input box + Enter",
        description: "Send input to Read-Host prompt",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Modal panel listing all keyboard shortcuts. Toggled by TOGGLE_SHORTCUT_PANEL. */
export function KeyboardShortcutPanel() {
  const { state, dispatch } = useAppState();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the search input when the panel opens.
  useEffect(() => {
    if (state.shortcutPanelOpen) {
      setQuery("");
      // Small delay to ensure the element is in the DOM.
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [state.shortcutPanelOpen]);

  // Close on Escape.
  useEffect(() => {
    if (!state.shortcutPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dispatch({ type: "TOGGLE_SHORTCUT_PANEL" });
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [state.shortcutPanelOpen, dispatch]);

  if (!state.shortcutPanelOpen) return null;

  // Filter groups by the search query (case-insensitive, matches keys or description).
  const lq = query.toLowerCase();
  const filteredGroups = SHORTCUT_GROUPS.map((g) => ({
    ...g,
    shortcuts: g.shortcuts.filter(
      (s) =>
        !lq ||
        s.keys.toLowerCase().includes(lq) ||
        s.description.toLowerCase().includes(lq),
    ),
  })).filter((g) => g.shortcuts.length > 0);

  return (
    /* Modal backdrop */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcut Reference"
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onClick={(e) => {
        // Close when clicking the backdrop itself (not the panel card).
        if (e.target === e.currentTarget)
          dispatch({ type: "TOGGLE_SHORTCUT_PANEL" });
      }}
    >
      {/* Panel card */}
      <div
        className="flex flex-col rounded shadow-xl"
        style={{
          width: "560px",
          maxWidth: "92vw",
          maxHeight: "80vh",
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-primary)",
          fontFamily: "var(--ui-font-family)",
          fontSize: "var(--ui-font-size)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-primary)" }}
        >
          <span
            className="font-semibold text-base"
            style={{ color: "var(--text-primary)" }}
          >
            Keyboard Shortcuts (F1)
          </span>
          <button
            onClick={() => dispatch({ type: "TOGGLE_SHORTCUT_PANEL" })}
            className="text-sm px-2 py-0.5 rounded"
            style={{
              color: "var(--text-secondary)",
              backgroundColor: "transparent",
            }}
            title="Close (Escape)"
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div
          className="px-4 py-2"
          style={{ borderBottom: "1px solid var(--border-primary)" }}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter shortcuts..."
            className="w-full text-sm px-2 py-1"
            style={{
              backgroundColor: "var(--bg-input)",
              border: "1px solid var(--border-primary)",
              borderRadius: "3px",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
        </div>

        {/* Shortcut groups */}
        <div className="overflow-y-auto flex-1 px-4 py-2">
          {filteredGroups.length === 0 && (
            <p
              className="text-sm py-4 text-center"
              style={{ color: "var(--text-muted)" }}
            >
              No shortcuts match &quot;{query}&quot;.
            </p>
          )}
          {filteredGroups.map((group) => (
            <div key={group.category} className="mb-4">
              {/* Category heading */}
              <div
                className="text-sm font-semibold uppercase tracking-wide mb-1"
                style={{ color: "var(--text-accent)" }}
              >
                {group.category}
              </div>
              {/* Shortcut rows */}
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {group.shortcuts.map((s) => (
                    <tr
                      key={s.keys}
                      style={{
                        borderBottom: "1px solid var(--border-primary)",
                      }}
                    >
                      <td
                        className="py-1 pr-4 font-mono whitespace-nowrap"
                        style={{ color: "var(--text-primary)", width: "200px" }}
                      >
                        {/* Render kbd elements with correct separators.
                            Split on " / " first (alternative combos), then
                            split each alternative on "+" to get individual keys. */}
                        {s.keys
                          .split(" / ")
                          .map((alternative, altIdx, altArr) => (
                            <React.Fragment key={altIdx}>
                              {alternative
                                .split("+")
                                .map((token, tokIdx, tokArr) => (
                                  <React.Fragment key={tokIdx}>
                                    <kbd
                                      style={{
                                        display: "inline-block",
                                        padding: "1px 6px",
                                        borderRadius: "3px",
                                        border:
                                          "1px solid var(--border-primary)",
                                        backgroundColor: "var(--bg-secondary)",
                                        fontSize: "13px",
                                        lineHeight: "20px",
                                      }}
                                    >
                                      {token.trim()}
                                    </kbd>
                                    {tokIdx < tokArr.length - 1 && (
                                      <span
                                        className="mx-0.5"
                                        style={{
                                          color: "var(--text-muted)",
                                        }}
                                      >
                                        {" + "}
                                      </span>
                                    )}
                                  </React.Fragment>
                                ))}
                              {altIdx < altArr.length - 1 && (
                                <span
                                  className="mx-1"
                                  style={{ color: "var(--text-muted)" }}
                                >
                                  {" / "}
                                </span>
                              )}
                            </React.Fragment>
                          ))}
                      </td>
                      <td
                        className="py-1"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {s.description}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div
          className="px-4 py-2 text-sm"
          style={{
            borderTop: "1px solid var(--border-primary)",
            color: "var(--text-muted)",
          }}
        >
          Press{" "}
          <kbd
            style={{
              padding: "0 4px",
              border: "1px solid var(--border-primary)",
              borderRadius: "3px",
              backgroundColor: "var(--bg-secondary)",
            }}
          >
            Escape
          </kbd>{" "}
          to close
        </div>
      </div>
    </div>
  );
}
