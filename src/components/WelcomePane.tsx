/** PSForge Welcome Pane — script-runner focused quick start. */

import React, { useMemo } from "react";
import { useAppState, newTabId, untitledCounter } from "../store";
import type { EditorTab, ScriptRunRecord } from "../types";
import { isPowerShellScriptPath } from "../script-utils";
import { basename } from "../path-utils";

export function WelcomePane() {
  const { state, dispatch } = useAppState();

  const recentScripts = useMemo(
    () => state.settings.recentFiles.filter(isPowerShellScriptPath).slice(0, 12),
    [state.settings.recentFiles],
  );

  const recentRuns = useMemo(
    () => (state.settings.recentRuns ?? []).slice(0, 10),
    [state.settings.recentRuns],
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

  const pasteRuns = state.settings.runAfterPasteCleanFormat !== false;

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
        <div className="welcome-card mb-6">
          <h1
            className="font-bold mb-2"
            style={{
              color: "var(--text-accent)",
              fontSize: "30px",
              lineHeight: 1.2,
            }}
          >
            Paste a script. Run it. Iterate.
          </h1>
          <p
            className="mb-4"
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--ui-font-size-lg)",
            }}
          >
            Built for the AI loop: paste a generated PowerShell script, run it,
            and copy the results back to your assistant when something needs
            fixing.
          </p>
          <div className="flex flex-wrap gap-2 mb-5">
            <ActionButton
              onClick={() => {
                (
                  window as unknown as Record<string, (() => void) | undefined>
                ).__psforge_pasteFromClipboardAsNewScript?.();
              }}
              label={pasteRuns ? "Paste from clipboard + run" : "Paste from clipboard"}
              hint="Ctrl+Shift+Alt+V — cleans smart quotes and code fences, formats, then runs"
            />
            <ActionButton onClick={createNewFile} label="New script" hint="Ctrl+N" secondary />
            <ActionButton onClick={handleOpenFile} label="Open script" hint="Ctrl+O" secondary />
            <ActionButton
              onClick={handleOpenFolder}
              label="Open folder"
              hint="Loads .ps1 / .psm1 / .psd1"
              secondary
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="welcome-step">
              <span className="welcome-step-label">
                <span className="welcome-step-num">1</span>
                Paste
              </span>
              <span className="welcome-step-hint">
                Ctrl+Shift+Alt+V cleans smart quotes, zero-width characters, and
                Markdown fences, then formats the script.
              </span>
            </div>
            <div className="welcome-step">
              <span className="welcome-step-label">
                <span className="welcome-step-num">2</span>
                Run
              </span>
              <span className="welcome-step-hint">
                F5 runs in the integrated terminal below. PSScriptAnalyzer warns
                before running anything suspicious.
              </span>
            </div>
            <div className="welcome-step">
              <span className="welcome-step-label">
                <span className="welcome-step-num">3</span>
                Copy for AI
              </span>
              <span className="welcome-step-hint">
                One click on the toolbar copies output, exit code, and
                diagnostics — paste it back to your assistant.
              </span>
            </div>
          </div>
        </div>

        <div className="welcome-card" style={{ padding: "16px" }}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2
              className="text-xs font-semibold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
            >
              Recent scripts
            </h2>
            {recentScripts.length > 0 && (
              <button onClick={clearRecentFiles} className="btn btn-ghost btn-sm" style={{ border: "1px solid var(--border-primary)" }}>
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
                      className="btn btn-ghost btn-sm"
                      style={{ border: "1px solid var(--border-primary)" }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="welcome-card mt-4" style={{ padding: "16px" }}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2
              className="text-xs font-semibold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
            >
              Recent runs
            </h2>
            {recentRuns.length > 0 && (
              <button
                type="button"
                data-testid="welcome-clear-recent-runs"
                onClick={() => {
                  (
                    window as unknown as Record<string, (() => void) | undefined>
                  ).__psforge_clearRecentRuns?.();
                }}
                className="btn btn-ghost btn-sm"
                style={{ border: "1px solid var(--border-primary)" }}
              >
                Clear
              </button>
            )}
          </div>
          {recentRuns.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              F5 runs appear here with exit code and duration.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recentRuns.map((run) => (
                <RecentRunRow
                  key={`${run.runAt}-${run.tabTitle}`}
                  run={run}
                  onOpen={run.scriptPath ? () => openPath(run.scriptPath) : undefined}
                  onRerun={() => {
                    const rerun = (
                      window as unknown as Record<string, unknown>
                    ).__psforge_rerunFromRecord as
                      | ((r: ScriptRunRecord) => void)
                      | undefined;
                    rerun?.(run);
                  }}
                  onOpenWorkingDir={
                    run.workingDir
                      ? () => {
                          const openDir = (
                            window as unknown as Record<string, unknown>
                          ).__psforge_openRunDirectory as
                            | ((dir: string) => void)
                            | undefined;
                          openDir?.(run.workingDir);
                        }
                      : undefined
                  }
                />
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

function RecentRunRow({
  run,
  onOpen,
  onRerun,
  onOpenWorkingDir,
}: {
  run: ScriptRunRecord;
  onOpen?: () => void;
  onRerun: () => void;
  onOpenWorkingDir?: () => void;
}) {
  const failed = run.exitCode === null || (run.exitCode ?? 0) !== 0;
  const label =
    run.exitCode === null
      ? "Failed"
      : run.exitCode === 0
        ? "Exit 0"
        : `Exit ${run.exitCode}`;
  const duration =
    run.durationMs < 1000
      ? `${run.durationMs} ms`
      : `${(run.durationMs / 1000).toFixed(2)} s`;
  const title = run.scriptPath
    ? basename(run.scriptPath)
    : run.tabTitle || "Untitled script";

  return (
    <li
      className="welcome-list-row text-sm"
      style={{ flexDirection: "column", alignItems: "stretch", gap: "4px" }}
    >
      {onOpen ? (
        <button
          onClick={onOpen}
          className="text-left w-full"
          style={{
            backgroundColor: "transparent",
            color: "var(--text-accent)",
            cursor: "pointer",
            fontWeight: 600,
          }}
          title={run.scriptPath}
        >
          {title}
        </button>
      ) : (
        <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
          {title}
        </div>
      )}
      <div
        className="mt-1 flex flex-wrap gap-3 text-xs items-center"
        style={{ color: "var(--text-secondary)" }}
      >
        <span
          style={{
            fontWeight: 600,
            color: failed ? "var(--text-warning, #e8a838)" : undefined,
          }}
        >
          {label}
        </span>
        <span>{duration}</span>
        <span>{new Date(run.runAt).toLocaleString()}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <SmallAction label="Re-run" onClick={onRerun} testId="welcome-rerun" />
        {onOpenWorkingDir && (
          <SmallAction
            label="Open run folder"
            onClick={onOpenWorkingDir}
            testId="welcome-open-run-dir"
          />
        )}
      </div>
    </li>
  );
}

function SmallAction({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} className="btn btn-sm">
      {label}
    </button>
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
      className={secondary ? "btn" : "btn btn-primary"}
      style={{ padding: "8px 16px" }}
      title={hint}
    >
      {label}
    </button>
  );
}
