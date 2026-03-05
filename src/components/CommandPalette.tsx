/** PSForge Command Palette.
 *  Minimal command palette (Ctrl+Shift+P) for snippet insertion and settings commands.
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { Snippet } from "../types";

interface PaletteItem {
  id: string;
  label: string;
  category: string;
  description: string;
  action: () => void;
}

export function CommandPalette() {
  const { state, dispatch } = useAppState();
  const [query, setQuery] = useState("");
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Refs for scrolling the selected item into view on keyboard navigation. */
  const listRef = useRef<HTMLDivElement>(null);

  // Load snippets on mount; guard against unmount during async load.
  useEffect(() => {
    let cancelled = false;
    cmd
      .getSnippets()
      .then((s) => {
        if (!cancelled) setSnippets(s);
      })
      .catch(() => {});
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => dispatch({ type: "TOGGLE_COMMAND_PALETTE" });

  // Build list of palette items
  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];

    // Snippets
    snippets.forEach((s) => {
      result.push({
        id: `snippet-${s.name}`,
        label: `Snippet: ${s.name}`,
        category: s.category,
        description: s.description,
        action: () => {
          window.dispatchEvent(
            new CustomEvent("psforge-insert", { detail: s.code }),
          );
          close();
        },
      });
    });

    // Built-in commands
    result.push({
      id: "cmd-settings",
      label: "Open Settings",
      category: "Command",
      description: "Open the settings panel",
      action: () => {
        close();
        dispatch({ type: "TOGGLE_SETTINGS" });
      },
    });

    result.push({
      id: "cmd-toggle-sidebar",
      label: "Toggle Sidebar",
      category: "Command",
      description: "Show or hide the module browser sidebar",
      action: () => {
        close();
        dispatch({ type: "TOGGLE_SIDEBAR" });
      },
    });

    result.push({
      id: "cmd-theme-dark",
      label: "Set Theme: Dark",
      category: "Theme",
      description: "Switch to the dark theme",
      action: () => {
        document.documentElement.setAttribute("data-theme", "dark");
        dispatch({
          type: "SET_SETTINGS",
          settings: { ...state.settings, theme: "dark" },
        });
        close();
      },
    });

    result.push({
      id: "cmd-theme-light",
      label: "Set Theme: Light",
      category: "Theme",
      description: "Switch to the light theme",
      action: () => {
        document.documentElement.setAttribute("data-theme", "light");
        dispatch({
          type: "SET_SETTINGS",
          settings: { ...state.settings, theme: "light" },
        });
        close();
      },
    });

    result.push({
      id: "cmd-theme-ise",
      label: "Set Theme: ISE Classic",
      category: "Theme",
      description: "Switch to the PowerShell ISE classic theme",
      action: () => {
        document.documentElement.setAttribute("data-theme", "ise-classic");
        dispatch({
          type: "SET_SETTINGS",
          settings: { ...state.settings, theme: "ise-classic" },
        });
        close();
      },
    });

    result.push({
      id: "cmd-clear-output",
      label: "Clear Output",
      category: "Command",
      description: "Clear the output pane",
      action: () => {
        dispatch({ type: "CLEAR_OUTPUT" });
        close();
      },
    });

    return result;
  }, [snippets, state.settings, dispatch]);

  // Filter items
  const filtered = items.filter((item) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
    );
  });

  // Keep selected index in bounds
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Scroll the selected item into view when navigating with arrow keys.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center pt-[15%]"
      style={{ backgroundColor: "rgba(0,0,0,0.3)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-primary)",
          width: "520px",
          maxHeight: "400px",
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center px-3"
          style={{ borderBottom: "1px solid var(--border-primary)" }}
        >
          <span
            className="mr-2 text-sm"
            style={{ color: "var(--text-accent)" }}
          >
            &gt;
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or snippet name..."
            className="flex-1 py-2 text-sm"
            style={{
              backgroundColor: "transparent",
              border: "none",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-auto">
          {filtered.length === 0 && (
            <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>
              No matching commands.
            </div>
          )}
          {filtered.map((item, i) => (
            <div
              key={item.id}
              onClick={item.action}
              className="flex items-center justify-between px-3 py-1.5 cursor-pointer text-xs"
              style={{
                backgroundColor:
                  i === selectedIndex ? "var(--bg-hover)" : "transparent",
                color:
                  i === selectedIndex
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <div className="flex flex-col">
                <span style={{ color: "var(--text-primary)" }}>
                  {item.label}
                </span>
                <span
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {item.description}
                </span>
              </div>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-muted)",
                }}
              >
                {item.category}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
