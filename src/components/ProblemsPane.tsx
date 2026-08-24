/** Problems pane: list diagnostics and Fix All (AI). */

import React, { useState } from "react";
import type {
  AppSettings,
  EditorTab,
  LastRunResult,
  PssaDiagnostic,
} from "../types";
import { applyAiFix, buildFixAllProblemsQuestion } from "../fix-problem";
import { collectDebugBundleMarkdown } from "../debug-bundle";
import { showAppToast } from "./ToastStack";
import { ProblemsPssaHint } from "./PssaInstallControls";

declare global {
  interface Window {
    __psforge_setEditorText?: (text: string) => void;
  }
}

function problemSeverity(
  severity: PssaDiagnostic["severity"],
): "error" | "warning" | "info" {
  switch (severity) {
    case "Error":
    case "ParseError":
      return "error";
    case "Warning":
      return "warning";
    default:
      return "info";
  }
}

function formatProblemLocation(problem: PssaDiagnostic): string {
  return `Ln ${problem.line}, Col ${problem.column}`;
}

export function ProblemsPane({
  diagnostics,
  activeTabName,
  pssaEnabled,
  psPath,
  aiEnabled,
  settings,
  activeTab,
  workingDir,
  lastRun,
  onNavigate,
  onApplyFixedScript,
  fontSize,
  fontFamily,
}: {
  diagnostics: PssaDiagnostic[];
  activeTabName?: string;
  pssaEnabled: boolean;
  psPath: string;
  aiEnabled: boolean;
  settings: AppSettings;
  activeTab?: EditorTab;
  workingDir: string;
  lastRun: LastRunResult | null;
  onNavigate: (line: number, column: number) => void;
  onApplyFixedScript: (tabId: string, code: string) => void;
  fontSize: number;
  fontFamily: string;
}) {
  const [busy, setBusy] = useState(false);
  const monoStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily,
  };

  const runFixAll = async () => {
    if (!aiEnabled || busy || !activeTab || diagnostics.length === 0) return;
    setBusy(true);
    showAppToast(
      `Asking AI to fix ${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}…`,
    );
    try {
      const { question, diagnostics: diagnosticsText } =
        buildFixAllProblemsQuestion(diagnostics);
      const bundle = collectDebugBundleMarkdown({
        tab: activeTab,
        lastRun,
        workingDir,
        problems: diagnostics,
      });
      const result = await applyAiFix({
        settings,
        question,
        diagnostics: diagnosticsText,
        script: activeTab.content,
        scriptPath: activeTab.filePath || activeTab.title,
        debugBundle: bundle,
      });
      if (result.ok && result.code) {
        onApplyFixedScript(activeTab.id, result.code);
        if (typeof window.__psforge_setEditorText === "function") {
          window.__psforge_setEditorText(result.code);
        }
      }
      showAppToast(result.toast);
    } finally {
      setBusy(false);
    }
  };

  if (!activeTabName) {
    return (
      <div className="bottom-pane-empty" data-testid="problems-empty">
        <strong>No active script</strong>
        <span>Open a PowerShell editor tab to review pre-run diagnostics.</span>
      </div>
    );
  }

  if (!pssaEnabled) {
    return (
      <div className="bottom-pane-empty" data-testid="problems-empty">
        <strong>Problems pane is disabled</strong>
        <span>
          Enable editor diagnostics in Settings to populate Problems for{" "}
          {activeTabName}.
        </span>
      </div>
    );
  }

  if (diagnostics.length === 0) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <ProblemsPssaHint psPath={psPath} />
        <div className="bottom-pane-empty" data-testid="problems-empty">
          <strong>No problems</strong>
          <span>
            {activeTabName} has no parser or analyzer diagnostics.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bottom-pane-problems flex flex-col h-full min-h-0"
      style={monoStyle}
    >
      <ProblemsPssaHint psPath={psPath} />
      <div
        className="flex items-center justify-between gap-2 px-2 py-1 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border-primary)" }}
      >
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {diagnostics.length} issue{diagnostics.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          data-testid="problems-fix-all"
          disabled={!aiEnabled || busy}
          title={
            aiEnabled
              ? "Send all problems and warnings to the configured AI and apply the fixed script"
              : "Enable AI in Settings to use Fix All"
          }
          onClick={() => void runFixAll()}
        >
          {busy ? "Fixing…" : "Fix All"}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {diagnostics.map((problem, index) => {
          const severity = problemSeverity(problem.severity);
          const severityLabel =
            severity === "error"
              ? "Error"
              : severity === "warning"
                ? "Warning"
                : "Info";
          const location = formatProblemLocation(problem);
          return (
            <button
              key={`${problem.ruleName}-${problem.line}-${problem.column}-${index}`}
              type="button"
              data-testid={`problem-item-${index}`}
              className="bottom-pane-problem"
              onClick={() => onNavigate(problem.line, problem.column)}
              title={`Go to ${location}`}
            >
              <div className="bottom-pane-problem-header">
                <span
                  className={[
                    "bottom-pane-problem-severity",
                    `bottom-pane-problem-severity-${severity}`,
                  ].join(" ")}
                >
                  {severityLabel}
                </span>
                <span className="bottom-pane-problem-location">{location}</span>
                <span className="bottom-pane-problem-rule">
                  {problem.ruleName || "Diagnostics"}
                </span>
              </div>
              <div className="bottom-pane-problem-message">{problem.message}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
