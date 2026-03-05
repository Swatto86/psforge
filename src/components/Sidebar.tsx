/** PSForge Sidebar - Module Browser panel.
 *  Lists installed PowerShell modules with expandable command lists.
 */

import React, { useState, useEffect, useCallback } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { CommandInfo, ModuleInfo } from "../types";

/**
 * Extracts a human-readable message from any thrown value.
 * Tauri invoke() rejects with an AppError object { code, message } when the
 * Rust command returns Err(AppError).  String(obj) gives "[object Object]";
 * this helper surfaces the actual message field when present.
 */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function Sidebar() {
  const { state, dispatch } = useAppState();
  const [filter, setFilter] = useState("");
  const [expandedModule, setExpandedModule] = useState<string | null>(null);
  const [moduleCommands, setModuleCommands] = useState<
    Record<string, CommandInfo[]>
  >({});
  const [loadingCommands, setLoadingCommands] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Tracks the previously selected PS path so we can reset modules on change. */
  const prevPsPathRef = React.useRef(state.selectedPsPath);

  // Reset module data when the selected PS version changes so the sidebar
  // fetches the module list for the new installation automatically.
  useEffect(() => {
    if (prevPsPathRef.current !== state.selectedPsPath) {
      prevPsPathRef.current = state.selectedPsPath;
      dispatch({ type: "SET_MODULES", modules: [] });
      // Also cancel any in-flight load so the !state.modulesLoading guard in
      // the load effect does not block the new fetch for the switched version.
      dispatch({ type: "SET_MODULES_LOADING", loading: false });
      setModuleCommands({});
      setExpandedModule(null);
      setLoadError(null);
    }
  }, [state.selectedPsPath, dispatch]);

  // Load modules lazily: only when the sidebar is first made visible and no
  // module data exists yet. This avoids an unnecessary Get-Module -ListAvailable
  // call (which can take several seconds) when the user never opens the sidebar.
  // NOTE: state.modulesLoading is intentionally NOT in the dependency array.
  // Including it caused an infinite reload loop: when loading finished with an
  // empty result (or an error), the effect re-triggered because modulesLoading
  // changed to false, saw modules.length===0 again, and started another load.
  useEffect(() => {
    if (
      state.sidebarVisible &&
      state.modules.length === 0 &&
      !state.modulesLoading &&
      state.selectedPsPath &&
      !loadError
    ) {
      setLoadError(null);
      dispatch({ type: "SET_MODULES_LOADING", loading: true });
      cmd
        .getInstalledModules(state.selectedPsPath)
        .then((modules) => {
          dispatch({ type: "SET_MODULES", modules });
        })
        .catch((err: unknown) => {
          setLoadError(extractErrorMessage(err));
        })
        .finally(() => {
          dispatch({ type: "SET_MODULES_LOADING", loading: false });
        });
    }
  }, [
    state.sidebarVisible,
    state.selectedPsPath,
    state.modules.length,
    // state.modulesLoading is deliberately excluded -- see note above.
    loadError,
    dispatch,
  ]);

  const refreshModules = useCallback(() => {
    if (!state.selectedPsPath) return;
    setLoadError(null);
    dispatch({ type: "SET_MODULES_LOADING", loading: true });
    dispatch({ type: "SET_MODULES", modules: [] });
    setModuleCommands({});
    cmd
      .getInstalledModules(state.selectedPsPath)
      .then((modules) => {
        dispatch({ type: "SET_MODULES", modules });
      })
      .catch((err: unknown) => {
        setLoadError(extractErrorMessage(err));
      })
      .finally(() => {
        dispatch({ type: "SET_MODULES_LOADING", loading: false });
      });
  }, [state.selectedPsPath, dispatch]);

  const toggleModule = useCallback(
    async (mod: ModuleInfo) => {
      if (expandedModule === mod.name) {
        setExpandedModule(null);
        return;
      }

      setExpandedModule(mod.name);

      if (!moduleCommands[mod.name]) {
        setLoadingCommands(mod.name);
        try {
          const commands = await cmd.getModuleCommands(
            state.selectedPsPath,
            mod.name,
          );
          setModuleCommands((prev) => ({ ...prev, [mod.name]: commands }));
        } catch {
          setModuleCommands((prev) => ({ ...prev, [mod.name]: [] }));
        }
        // Only clear loading indicator if this module is still the one loading.
        // Prevents a race where clicking module B while A is loading causes A's
        // completion to clear B's loading spinner.
        setLoadingCommands((current) =>
          current === mod.name ? null : current,
        );
      }
    },
    [expandedModule, moduleCommands, state.selectedPsPath],
  );

  const insertCommand = (commandName: string) => {
    // Insert at cursor in the active editor via global reference
    const text = commandName;
    // We'll post a message to the editor component
    window.dispatchEvent(new CustomEvent("psforge-insert", { detail: text }));
  };

  const filteredModules = state.modules.filter(
    (m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div
      className="flex flex-col h-full no-select"
      style={{
        width: "240px",
        minWidth: "180px",
        backgroundColor: "var(--bg-sidebar)",
        borderRight:
          state.sidebarPosition === "left"
            ? "1px solid var(--border-primary)"
            : undefined,
        borderLeft:
          state.sidebarPosition === "right"
            ? "1px solid var(--border-primary)"
            : undefined,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-1 px-3 py-2 text-xs font-semibold uppercase"
        style={{
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-primary)",
        }}
      >
        <span className="flex-1">Modules</span>

        {/* Dock-left button */}
        <button
          onClick={() =>
            dispatch({ type: "SET_SIDEBAR_POSITION", position: "left" })
          }
          title="Dock left"
          className="flex items-center justify-center w-5 h-5 rounded"
          style={{
            backgroundColor: "transparent",
            color:
              state.sidebarPosition === "left"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              "var(--text-primary)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              state.sidebarPosition === "left"
                ? "var(--text-primary)"
                : "var(--text-secondary)")
          }
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <rect
              x="1"
              y="1"
              width="14"
              height="14"
              rx="1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <rect x="1" y="1" width="5" height="14" rx="1" />
          </svg>
        </button>

        {/* Dock-right button */}
        <button
          onClick={() =>
            dispatch({ type: "SET_SIDEBAR_POSITION", position: "right" })
          }
          title="Dock right"
          className="flex items-center justify-center w-5 h-5 rounded"
          style={{
            backgroundColor: "transparent",
            color:
              state.sidebarPosition === "right"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              "var(--text-primary)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              state.sidebarPosition === "right"
                ? "var(--text-primary)"
                : "var(--text-secondary)")
          }
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <rect
              x="1"
              y="1"
              width="14"
              height="14"
              rx="1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <rect x="10" y="1" width="5" height="14" rx="1" />
          </svg>
        </button>

        {/* Hide panel button */}
        <button
          onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
          title="Hide panel"
          className="flex items-center justify-center w-5 h-5 rounded"
          style={{
            backgroundColor: "transparent",
            color: "var(--text-secondary)",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              "var(--text-primary)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              "var(--text-secondary)")
          }
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.146 4.146a.5.5 0 0 1 .708 0L8 7.293l3.146-3.147a.5.5 0 0 1 .708.708L8.707 8l3.147 3.146a.5.5 0 0 1-.708.708L8 8.707l-3.146 3.147a.5.5 0 0 1-.708-.708L7.293 8 4.146 4.854a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>

        {/* Refresh button */}
        <button
          onClick={refreshModules}
          title="Refresh modules"
          className="flex items-center justify-center w-5 h-5 rounded"
          style={{
            backgroundColor: "transparent",
            color: "var(--text-secondary)",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              "var(--text-primary)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.color =
              "var(--text-secondary)")
          }
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.451 5.609a5.5 5.5 0 1 0 .259 4.893l.972.324a6.5 6.5 0 1 1-.306-5.783l.949-.316-.316.949.324.972-.949.316.316-.949-.324-.972z" />
            <path d="M14 1v4h-4l1.29-1.29L14 1z" />
          </svg>
        </button>
      </div>

      {/* Search filter */}
      <div className="px-2 py-1">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter modules..."
          className="w-full text-xs"
          style={{
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
            padding: "3px 6px",
            borderRadius: "2px",
          }}
        />
      </div>

      {/* Module list */}
      <div
        className="flex-1 overflow-auto"
        style={{
          fontFamily: "var(--sidebar-font-family)",
          fontSize: "var(--sidebar-font-size)",
        }}
      >
        {state.modulesLoading && (
          <div
            className="p-3 animate-pulse"
            style={{ color: "var(--text-muted)" }}
          >
            Loading modules...
          </div>
        )}

        {!state.modulesLoading && loadError && (
          <div className="p-3" style={{ color: "var(--text-danger, #f44747)" }}>
            <div style={{ marginBottom: "4px", fontWeight: 600 }}>
              Failed to load modules
            </div>
            <div
              style={{
                fontSize: "10px",
                wordBreak: "break-word",
                opacity: 0.8,
              }}
            >
              {loadError}
            </div>
            <button
              onClick={refreshModules}
              style={{
                marginTop: "6px",
                fontSize: "10px",
                color: "var(--text-accent)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Retry
            </button>
          </div>
        )}

        {!state.modulesLoading &&
          !loadError &&
          filteredModules.length === 0 && (
            <div className="p-3" style={{ color: "var(--text-muted)" }}>
              {state.modules.length === 0 ? "No modules found." : "No matches."}
            </div>
          )}

        {filteredModules.map((mod) => (
          <div key={mod.name + mod.version}>
            <div
              onClick={() => toggleModule(mod)}
              className="flex items-center gap-1 px-3 py-1 cursor-pointer transition-colors"
              style={{
                color:
                  expandedModule === mod.name
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.backgroundColor =
                  "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.backgroundColor =
                  "transparent")
              }
            >
              <span className="text-[10px] shrink-0" style={{ width: "10px" }}>
                {expandedModule === mod.name ? "\u25BC" : "\u25B6"}
              </span>
              <span className="truncate" title={mod.name}>
                {mod.name}
              </span>
              <span
                className="ml-auto shrink-0"
                style={{ color: "var(--text-muted)", fontSize: "10px" }}
              >
                {mod.version}
              </span>
            </div>

            {/* Expanded commands */}
            {expandedModule === mod.name && (
              <div className="pl-6">
                {loadingCommands === mod.name && (
                  <div
                    className="py-1 animate-pulse"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Loading...
                  </div>
                )}
                {moduleCommands[mod.name]?.map((c) => (
                  <div
                    key={c.name}
                    onClick={() => insertCommand(c.name)}
                    className="py-0.5 px-2 cursor-pointer truncate transition-colors"
                    style={{ color: "var(--text-accent)" }}
                    title={`${c.name} (${c.commandType}) - Click to insert`}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.backgroundColor =
                        "var(--bg-hover)")
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.backgroundColor =
                        "transparent")
                    }
                  >
                    {c.name}
                  </div>
                ))}
                {moduleCommands[mod.name]?.length === 0 &&
                  loadingCommands !== mod.name && (
                    <div
                      className="py-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      No exported commands.
                    </div>
                  )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
