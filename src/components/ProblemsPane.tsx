/** Problems pane: list diagnostics, Fix All, and per-item Fix This (AI). */

import React, { useEffect, useRef, useState } from "react";
import type { AppSettings, EditorTab, PssaDiagnostic } from "../types";
import {
  applyAiFix,
  buildFixAllProblemsQuestion,
  buildFixProblemQuestion,
  diagnosticToTarget,
} from "../fix-problem";
import { captureLastRunOutput } from "../debug-bundle";
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

function applyFixedCode(
  tabId: string,
  code: string,
  onApplyFixedScript: (tabId: string, code: string) => void,
): void {
  onApplyFixedScript(tabId, code);
  if (typeof window.__psforge_setEditorText === "function") {
    window.__psforge_setEditorText(code);
  }
}

export function ProblemsPane({
  diagnostics,
  activeTabName,
  pssaEnabled,
  psPath,
  aiEnabled,
  settings,
  activeTab,
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
  onNavigate: (line: number, column: number) => void;
  onApplyFixedScript: (tabId: string, code: string) => void;
  fontSize: number;
  fontFamily: string;
}) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    problem: PssaDiagnostic;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const monoStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily,
  };

  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const runFixAll = async () => {
    if (!aiEnabled || busy || !activeTab || diagnostics.length === 0) return;
    setBusy(true);
    setMenu(null);
    try {
      const batch = buildFixAllProblemsQuestion(diagnostics);
      const scope =
        batch.omittedCount > 0
          ? `${batch.includedCount} of ${batch.totalCount} (errors first)`
          : `${batch.totalCount}`;
      showAppToast(
        `Asking AI to fix ${scope} problem${batch.includedCount === 1 ? "" : "s"}…`,
      );
      // Skip debug bundle: when present, backend ignores the diagnostics field
      // and only keeps ~8 errors from the bundle.
      const result = await applyAiFix({
        settings,
        question: batch.question,
        diagnostics: batch.diagnostics,
        script: activeTab.content,
        scriptPath: activeTab.filePath || activeTab.title,
        terminalOutput: captureLastRunOutput(),
      });
      if (result.ok && result.code) {
        applyFixedCode(activeTab.id, result.code, onApplyFixedScript);
        showAppToast(
          batch.omittedCount > 0
            ? `${result.toast} · ${batch.omittedCount} left — run Fix All again`
            : result.toast,
        );
      } else {
        showAppToast(result.toast);
      }
    } finally {
      setBusy(false);
    }
  };

  const runFixThis = async (problem: PssaDiagnostic) => {
    if (!aiEnabled || busy || !activeTab) return;
    setBusy(true);
    setMenu(null);
    showAppToast("Asking AI to fix this problem…");
    try {
      const { question, diagnostics: diagnosticsText } =
        buildFixProblemQuestion(diagnosticToTarget(problem));
      const result = await applyAiFix({
        settings,
        question,
        diagnostics: diagnosticsText,
        script: activeTab.content,
        scriptPath: activeTab.filePath || activeTab.title,
        terminalOutput: captureLastRunOutput(),
      });
      if (result.ok && result.code) {
        applyFixedCode(activeTab.id, result.code, onApplyFixedScript);
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
              ? "Fix errors first in batches that fit the AI request limit; run again for the rest"
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
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, problem });
              }}
              title={`Go to ${location}. Right-click for Fix This.`}
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
      {menu && (
        <div
          ref={menuRef}
          className="menu-pop"
          data-testid="problems-context-menu"
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            zIndex: 80,
          }}
        >
          <button
            type="button"
            className="menu-item"
            data-testid="problems-fix-this"
            disabled={!aiEnabled || busy}
            title={
              aiEnabled
                ? "Ask AI to fix only this problem"
                : "Enable AI in Settings to use Fix This"
            }
            onClick={() => void runFixThis(menu.problem)}
          >
            Fix This
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              onNavigate(menu.problem.line, menu.problem.column);
              setMenu(null);
            }}
          >
            Go to Line
          </button>
        </div>
      )}
    </div>
  );
}
