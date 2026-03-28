/** PSForge Tab Bar component.
 *  Displays open file tabs with dirty indicators, close buttons, context menus,
 *  and drag-and-drop reordering (HTML5 Drag API).
 */

import React, { useState, useRef, useEffect } from "react";
import { useAppState } from "../store";
import { EditorTab } from "../types";
import * as cmd from "../commands";

/**
 * Computes a minimal-but-unique display label for each tab.
 * Tabs with a unique filename show just the filename.
 * When two or more saved files share the same filename, parent directory
 * segments are added one-at-a-time (right-to-left) until every label in
 * the conflict group is unique — matching VS Code's disambiguation behaviour.
 */
function disambiguateTabs(tabs: EditorTab[]): Map<string, string> {
  const labels = new Map<string, string>();

  // Helper: extract the base filename from a tab.
  const baseName = (tab: EditorTab) => {
    if (!tab.filePath) return tab.title;
    const parts = tab.filePath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || tab.title;
  };

  // Group tabs by base filename.
  const groups = new Map<string, EditorTab[]>();
  for (const tab of tabs) {
    const key = baseName(tab);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tab);
  }

  for (const [, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0].id, baseName(group[0]));
      continue;
    }
    // Find the minimum number of trailing path segments that makes every
    // label in this conflict group unique.
    let depth = 2;
    let resolved = false;
    while (!resolved) {
      const attempt = new Map<string, string>();
      for (const tab of group) {
        if (!tab.filePath) {
          attempt.set(tab.id, tab.title);
          continue;
        }
        const parts = tab.filePath.replace(/\\/g, "/").split("/");
        attempt.set(tab.id, parts.slice(-Math.min(depth, parts.length)).join("/"));
      }
      const values = Array.from(attempt.values());
      if (new Set(values).size === values.length || depth > 12) {
        for (const [id, label] of attempt) labels.set(id, label);
        resolved = true;
      } else {
        depth++;
      }
    }
  }

  return labels;
}

export function TabBar() {
  const { state, dispatch } = useAppState();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Tab id currently being dragged, or null. */
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  // BUG-NEW-5 fix: extracted shared close logic so the context menu items
  // run the same isDirty confirmation as the tab × button.
  const confirmDiscard = async (title: string): Promise<boolean> => {
    const message = `"${title}" has unsaved changes.\n\nClose without saving?`;
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      return await confirm(message, {
        title: "PSForge",
        kind: "warning",
        okLabel: "Close",
        cancelLabel: "Cancel",
      });
    } catch {
      return false;
    }
  };

  const closeTab = async (tabId: string) => {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (tab?.isDirty) {
      const confirmed = await confirmDiscard(tab.title);
      if (!confirmed) return;
    }
    if (state.tabs.length > 1) {
      dispatch({ type: "CLOSE_TAB", id: tabId });
    }
  };

  const handleClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    void closeTab(tabId);
  };

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  };

  const closeOthers = async (tabId: string) => {
    // BUG-NEW-5 fix: check isDirty before closing each tab.
    for (const t of state.tabs) {
      if (t.id === tabId) continue;
      if (t.isDirty) {
        const confirmed = await confirmDiscard(t.title);
        if (!confirmed) {
          setContextMenu(null);
          return;
        }
      }
      dispatch({ type: "CLOSE_TAB", id: t.id });
    }
    setContextMenu(null);
  };

  const closeAll = async () => {
    // BUG-NEW-5 fix: confirm once for all dirty tabs before closing any.
    const dirtyTabs = state.tabs.filter((t) => t.isDirty);
    if (dirtyTabs.length > 0) {
      const names = dirtyTabs.map((t) => `"${t.title}"`).join(", ");
      let confirmed = false;
      const message = `${dirtyTabs.length} file(s) have unsaved changes: ${names}.\n\nClose all without saving?`;
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        confirmed = await confirm(message, {
          title: "PSForge",
          kind: "warning",
          okLabel: "Close All",
          cancelLabel: "Cancel",
        });
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        setContextMenu(null);
        return;
      }
    }
    // Keep at least one tab, resetting it to a fresh code tab.
    state.tabs.slice(1).forEach((t) => {
      dispatch({ type: "CLOSE_TAB", id: t.id });
    });
    dispatch({
      type: "UPDATE_TAB",
      id: state.tabs[0].id,
      changes: {
        content: "",
        savedContent: "",
        filePath: "",
        title: "Untitled-1",
        isDirty: false,
        tabType: "code",
      },
    });
    setContextMenu(null);
  };

  const tabLabels = disambiguateTabs(state.tabs);

  return (
    <div
      data-testid="tabbar-root"
      className="flex items-center overflow-x-auto no-select"
      style={{
        backgroundColor: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        minHeight: "44px",
      }}
    >
      {state.tabs.map((tab) => {
        const isActive = tab.id === state.activeTabId;
        const isDragTarget = dragOverId === tab.id;
        const displayLabel = tabLabels.get(tab.id) ?? tab.title;
        return (
          <div
            key={tab.id}
            data-testid={`tab-item-${tab.id}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", tab.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverId(tab.id);
            }}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => {
              e.preventDefault();
              const fromId = e.dataTransfer.getData("text/plain");
              if (fromId && fromId !== tab.id) {
                dispatch({ type: "REORDER_TABS", fromId, toId: tab.id });
              }
              setDragOverId(null);
            }}
            onDragEnd={() => setDragOverId(null)}
            onClick={() => dispatch({ type: "SET_ACTIVE_TAB", id: tab.id })}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            className="flex items-center gap-2 px-4 py-3 text-sm cursor-pointer shrink-0 transition-colors"
            style={{
              backgroundColor: isActive
                ? "var(--bg-tab-active)"
                : "var(--bg-tab)",
              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
              borderRight: "1px solid var(--border-primary)",
              borderBottom: isActive
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              // Highlight drop target with a left border accent
              borderLeft: isDragTarget
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              opacity: isDragTarget ? 0.8 : 1,
            }}
          >
            <span title={tab.filePath || undefined}>{displayLabel}</span>
            {tab.isDirty && (
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: "var(--text-accent)",
                  display: "inline-block",
                }}
              />
            )}
            <button
              onClick={(e) => handleClose(e, tab.id)}
              data-testid={`tab-close-${tab.id}`}
              disabled={state.tabs.length <= 1}
              className="ml-1 rounded hover:opacity-100 opacity-50"
              style={{
                color: "var(--text-secondary)",
                backgroundColor: "transparent",
                width: "18px",
                height: "18px",
                fontSize: "var(--ui-font-size-base)",
                lineHeight: "1",
                display: state.tabs.length <= 1 ? "none" : "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Close"
            >
              x
            </button>
          </div>
        );
      })}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 py-1 rounded shadow-lg"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: "var(--bg-tertiary)",
            border: "1px solid var(--border-primary)",
            minWidth: "150px",
            fontFamily: "var(--ui-font-family)",
            fontSize: "var(--ui-font-size)",
          }}
        >
          <CtxMenuItem
            label="Close"
            onClick={() => {
              // BUG-NEW-5 fix: route through closeTab so isDirty is checked.
              void closeTab(contextMenu.tabId);
              setContextMenu(null);
            }}
          />
          <CtxMenuItem
            label="Close Others"
            onClick={() => void closeOthers(contextMenu.tabId)}
          />
          <CtxMenuItem label="Close All" onClick={() => void closeAll()} />
          <div
            className="my-1"
            style={{
              height: "1px",
              backgroundColor: "var(--border-primary)",
            }}
          />
          <CtxMenuItem
            label="Reveal in Explorer"
            disabled={
              !state.tabs.find((t) => t.id === contextMenu.tabId)?.filePath
            }
            onClick={() => {
              const tab = state.tabs.find((t) => t.id === contextMenu.tabId);
              if (tab?.filePath) {
                cmd.revealInExplorer(tab.filePath).catch(() => {});
              }
              setContextMenu(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function CtxMenuItem({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <div
      onClick={disabled ? undefined : () => void onClick()}
      className="px-3 py-1 transition-colors"
      style={{
        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          (e.currentTarget as HTMLElement).style.backgroundColor =
            "var(--bg-hover)";
      }}
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLElement).style.backgroundColor = "transparent")
      }
    >
      {label}
    </div>
  );
}

