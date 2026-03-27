/** PSForge Show Command pane.
 *  ISE-style command builder: pick a module + command, fill parameters, and insert the generated command text.
 */

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { CommandInfo, CommandParameterInfo } from "../types";

function quotePsArgument(value: string): string {
  if (!/[\s'"`]/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function sortParams(params: CommandParameterInfo[]): CommandParameterInfo[] {
  return [...params].sort((a, b) => {
    const aPos = typeof a.position === "number" ? a.position : Number.MAX_SAFE_INTEGER;
    const bPos = typeof b.position === "number" ? b.position : Number.MAX_SAFE_INTEGER;
    if (aPos !== bPos) return aPos - bPos;
    return a.name.localeCompare(b.name);
  });
}

export function ShowCommandPane() {
  const { state, dispatch } = useAppState();
  const [moduleFilter, setModuleFilter] = useState("");
  const [commandFilter, setCommandFilter] = useState("");
  const [selectedModule, setSelectedModule] = useState("");
  const [selectedCommand, setSelectedCommand] = useState("");
  const [moduleError, setModuleError] = useState("");
  const [commandsError, setCommandsError] = useState("");
  const [paramsError, setParamsError] = useState("");
  const [loadingCommands, setLoadingCommands] = useState(false);
  const [loadingParams, setLoadingParams] = useState(false);
  const [commandsByModule, setCommandsByModule] = useState<
    Record<string, CommandInfo[]>
  >({});
  const [commandParams, setCommandParams] = useState<CommandParameterInfo[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const loadModules = useCallback(async () => {
    if (!state.selectedPsPath) return;
    setModuleError("");
    dispatch({ type: "SET_MODULES_LOADING", loading: true });
    try {
      const modules = await cmd.getInstalledModules(state.selectedPsPath);
      dispatch({ type: "SET_MODULES", modules });
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setModuleError(message);
    } finally {
      dispatch({ type: "SET_MODULES_LOADING", loading: false });
    }
  }, [state.selectedPsPath, dispatch]);

  useEffect(() => {
    setSelectedModule("");
    setSelectedCommand("");
    setCommandsByModule({});
    setCommandParams([]);
    setParamValues({});
    setModuleError("");
    setCommandsError("");
    setParamsError("");
  }, [state.selectedPsPath]);

  useEffect(() => {
    if (!state.selectedPsPath) return;
    if (state.modules.length > 0 || state.modulesLoading) return;
    void loadModules();
  }, [
    loadModules,
    state.selectedPsPath,
    state.modules.length,
    state.modulesLoading,
  ]);

  const filteredModules = useMemo(() => {
    if (!moduleFilter.trim()) return state.modules;
    const q = moduleFilter.trim().toLowerCase();
    return state.modules.filter((m) => m.name.toLowerCase().includes(q));
  }, [state.modules, moduleFilter]);

  useEffect(() => {
    if (filteredModules.length === 0) {
      setSelectedModule("");
      return;
    }
    if (!selectedModule || !filteredModules.some((m) => m.name === selectedModule)) {
      setSelectedModule(filteredModules[0].name);
    }
  }, [filteredModules, selectedModule]);

  const moduleCommands = selectedModule ? commandsByModule[selectedModule] ?? [] : [];

  useEffect(() => {
    if (!state.selectedPsPath || !selectedModule) return;
    if (commandsByModule[selectedModule]) return;
    let cancelled = false;
    setLoadingCommands(true);
    setCommandsError("");
    cmd
      .getModuleCommands(state.selectedPsPath, selectedModule)
      .then((commands) => {
        if (cancelled) return;
        setCommandsByModule((prev) => ({ ...prev, [selectedModule]: commands }));
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        setCommandsError(message);
        setCommandsByModule((prev) => ({ ...prev, [selectedModule]: [] }));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingCommands(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.selectedPsPath, selectedModule, commandsByModule]);

  const filteredCommands = useMemo(() => {
    if (!commandFilter.trim()) return moduleCommands;
    const q = commandFilter.trim().toLowerCase();
    return moduleCommands.filter((c) => c.name.toLowerCase().includes(q));
  }, [moduleCommands, commandFilter]);

  useEffect(() => {
    if (filteredCommands.length === 0) {
      setSelectedCommand("");
      return;
    }
    if (!selectedCommand || !filteredCommands.some((c) => c.name === selectedCommand)) {
      setSelectedCommand(filteredCommands[0].name);
    }
  }, [filteredCommands, selectedCommand]);

  useEffect(() => {
    if (!state.selectedPsPath || !selectedCommand) {
      setCommandParams([]);
      setParamValues({});
      return;
    }
    let cancelled = false;
    setLoadingParams(true);
    setParamsError("");
    cmd
      .getCommandParameters(state.selectedPsPath, selectedCommand)
      .then((params) => {
        if (cancelled) return;
        const sorted = sortParams(params);
        setCommandParams(sorted);
        setParamValues((prev) =>
          Object.fromEntries(
            sorted.map((param) => [param.name, prev[param.name] ?? ""]),
          ),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        setParamsError(message);
        setCommandParams([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingParams(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.selectedPsPath, selectedCommand]);

  const commandPreview = useMemo(() => {
    if (!selectedCommand) return "";
    const parts: string[] = [selectedCommand];
    for (const param of commandParams) {
      const raw = paramValues[param.name] ?? "";
      if (param.isSwitch) {
        if (raw === "true") parts.push(`-${param.name}`);
        continue;
      }
      const trimmed = raw.trim();
      if (!trimmed) continue;
      parts.push(`-${param.name}`);
      parts.push(quotePsArgument(trimmed));
    }
    return parts.join(" ");
  }, [selectedCommand, commandParams, paramValues]);

  const insertCommand = () => {
    if (!commandPreview.trim()) return;
    window.dispatchEvent(
      new CustomEvent("psforge-insert", { detail: `${commandPreview} ` }),
    );
  };

  return (
    <div
      data-testid="show-command-pane"
      className="h-full overflow-auto px-3 py-2"
      style={{
        fontSize: `${state.settings.outputFontSize ?? 13}px`,
        fontFamily:
          state.settings.outputFontFamily ?? "Cascadia Code, Consolas, monospace",
      }}
    >
      <div
        className="mb-2 text-xs"
        style={{ color: "var(--text-muted)", lineHeight: 1.4 }}
      >
        Build a PowerShell command and insert it at the cursor.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
          placeholder="Filter modules..."
          style={{
            minWidth: "220px",
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
          }}
        />
        <select
          value={selectedModule}
          onChange={(e) => setSelectedModule(e.target.value)}
          style={{
            minWidth: "260px",
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
          }}
        >
          {filteredModules.length === 0 && <option value="">No modules</option>}
          {filteredModules.map((module) => (
            <option key={module.name + module.version} value={module.name}>
              {module.name} ({module.version})
            </option>
          ))}
        </select>
        <button
          onClick={() => void loadModules()}
          disabled={!state.selectedPsPath || state.modulesLoading}
          style={{
            backgroundColor: "transparent",
            color:
              !state.selectedPsPath || state.modulesLoading
                ? "var(--text-muted)"
                : "var(--text-secondary)",
            cursor:
              !state.selectedPsPath || state.modulesLoading ? "default" : "pointer",
          }}
          title="Refresh module list"
        >
          {state.modulesLoading ? "Loading..." : "Refresh Modules"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={commandFilter}
          onChange={(e) => setCommandFilter(e.target.value)}
          placeholder="Filter commands..."
          style={{
            minWidth: "220px",
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
          }}
        />
        <select
          value={selectedCommand}
          onChange={(e) => setSelectedCommand(e.target.value)}
          disabled={!selectedModule || loadingCommands}
          style={{
            minWidth: "260px",
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
          }}
        >
          {filteredCommands.length === 0 && <option value="">No commands</option>}
          {filteredCommands.map((command) => (
            <option key={command.name} value={command.name}>
              {command.name} ({command.commandType})
            </option>
          ))}
        </select>
      </div>

      {(moduleError || commandsError || paramsError) && (
        <div className="mt-2 text-xs" style={{ color: "var(--stream-stderr)" }}>
          {moduleError || commandsError || paramsError}
        </div>
      )}

      <div
        className="mt-3 rounded"
        style={{
          border: "1px solid var(--border-primary)",
          backgroundColor: "var(--bg-secondary)",
        }}
      >
        <div
          className="px-2 py-1 text-xs"
          style={{
            borderBottom: "1px solid var(--border-primary)",
            color: "var(--text-secondary)",
          }}
        >
          Parameters
        </div>
        {loadingParams && (
          <div className="px-2 py-2" style={{ color: "var(--text-muted)" }}>
            Loading command metadata...
          </div>
        )}
        {!loadingParams && selectedCommand && commandParams.length === 0 && (
          <div className="px-2 py-2" style={{ color: "var(--text-muted)" }}>
            This command has no parameters (or metadata is unavailable).
          </div>
        )}
        {!loadingParams && commandParams.length > 0 && (
          <div className="p-2 flex flex-col gap-2">
            {commandParams.map((param) => (
              <div
                key={param.name}
                className="rounded px-2 py-1"
                style={{
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "var(--bg-panel)",
                }}
              >
                <div
                  className="flex items-center gap-2 text-xs"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <span style={{ color: "var(--text-accent)" }}>-{param.name}</span>
                  <span>{param.typeName || "System.Object"}</span>
                  {param.isMandatory && (
                    <span style={{ color: "var(--stream-warning)" }}>mandatory</span>
                  )}
                  {param.acceptsPipelineInput && (
                    <span style={{ color: "var(--text-muted)" }}>pipeline</span>
                  )}
                  {typeof param.position === "number" && (
                    <span style={{ color: "var(--text-muted)" }}>
                      position {param.position}
                    </span>
                  )}
                </div>
                {param.aliases.length > 0 && (
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    Aliases: {param.aliases.join(", ")}
                  </div>
                )}
                <div className="mt-1">
                  {param.isSwitch ? (
                    <label
                      className="flex items-center gap-2 text-xs"
                      style={{ color: "var(--text-primary)" }}
                    >
                      <input
                        type="checkbox"
                        checked={paramValues[param.name] === "true"}
                        onChange={(e) =>
                          setParamValues((prev) => ({
                            ...prev,
                            [param.name]: e.target.checked ? "true" : "",
                          }))
                        }
                      />
                      Include switch
                    </label>
                  ) : (
                    <input
                      value={paramValues[param.name] ?? ""}
                      onChange={(e) =>
                        setParamValues((prev) => ({
                          ...prev,
                          [param.name]: e.target.value,
                        }))
                      }
                      placeholder={`Value for -${param.name}`}
                      style={{
                        width: "100%",
                        backgroundColor: "var(--bg-input)",
                        border: "1px solid var(--border-primary)",
                        color: "var(--text-primary)",
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Command Preview
        </div>
        <textarea
          value={commandPreview}
          readOnly
          rows={3}
          className="w-full mt-1 px-2 py-1"
          style={{
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
            resize: "vertical",
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={insertCommand}
            disabled={!commandPreview.trim()}
            style={{
              backgroundColor: "transparent",
              color: commandPreview.trim()
                ? "var(--text-accent)"
                : "var(--text-muted)",
              cursor: commandPreview.trim() ? "pointer" : "default",
            }}
          >
            Insert At Cursor
          </button>
          <button
            onClick={() => navigator.clipboard.writeText(commandPreview).catch(() => {})}
            disabled={!commandPreview.trim()}
            style={{
              backgroundColor: "transparent",
              color: commandPreview.trim()
                ? "var(--text-secondary)"
                : "var(--text-muted)",
              cursor: commandPreview.trim() ? "pointer" : "default",
            }}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
