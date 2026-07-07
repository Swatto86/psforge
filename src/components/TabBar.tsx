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
    const bridge = (window as unknown as Record<string, unknown>)
      .__psforge_requestCloseTab as ((id: string) => Promise<boolean>) | undefined;
    if (bridge) {
      await bridge(tabId);
      return;
    }
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
    const others = state.tabs.filter((t) => t.id !== tabId);
    const dirtyTabs = others.filter((t) => t.isDirty);
    // Confirm before closing any tab so cancelling does not leave a subset
    // already closed (same batch semantics as Close All).
    if (dirtyTabs.length === 1) {
      const confirmed = await confirmDiscard(dirtyTabs[0].title);
      if (!confirmed) {
        setContextMenu(null);
        return;
      }
    } else if (dirtyTabs.length > 1) {
      const names = dirtyTabs.map((t) => `"${t.title}"`).join(", ");
      const message = `${dirtyTabs.length} file(s) have unsaved changes: ${names}.\n\nClose without saving?`;
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const confirmed = await confirm(message, {
          title: "PSForge",
          kind: "warning",
          okLabel: "Close",
          cancelLabel: "Cancel",
        });
        if (!confirmed) {
          setContextMenu(null);
          return;
        }
      } catch {
        setContextMenu(null);
        return;
      }
    }
    for (const t of others) {
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
        minHeight: "37px",
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
            className={`tab-item ${isActive ? "tab-item-active" : ""} ${
              isDragTarget ? "tab-item-drop-target" : ""
            }`}
          >
            <span title={tab.filePath || undefined}>{displayLabel}</span>
            {tab.isDirty && <span className="tab-dirty-dot" />}
            <button
              onClick={(e) => handleClose(e, tab.id)}
              data-testid={`tab-close-${tab.id}`}
              disabled={state.tabs.length <= 1}
              className="tab-close"
              style={{
                display: state.tabs.length <= 1 ? "none" : "inline-flex",
              }}
              title="Close"
            >
              ×
            </button>
          </div>
        );
      })}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="menu-pop"
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            minWidth: "160px",
            fontFamily: "var(--ui-font-family)",
          }}
        >
          <CtxMenuItem
            label="Close"
            // The app always keeps at least one tab open; the tab close button
            // is hidden in that case, so grey this out instead of silently
            // doing nothing.
            disabled={state.tabs.length <= 1}
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
          <div className="menu-separator" />
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
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="menu-item"
    >
      {label}
    </button>
  );
}

