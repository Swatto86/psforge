/** Modal shown when PSScriptAnalyzer reports errors before F5 (warn mode). */

import React, { useEffect, useRef } from "react";
import type { PssaDiagnostic } from "../types";
import { useFocusTrap } from "./use-focus-trap";

interface Props {
  errors: PssaDiagnostic[];
  onRunAnyway: () => void;
  onCancel: () => void;
  onViewProblems: () => void;
}

export function PssaRunGateDialog({
  errors,
  onRunAnyway,
  onCancel,
  onViewProblems,
}: Props) {
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    runButtonRef.current?.focus();
  }, []);

  const preview = errors.slice(0, 8);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      data-testid="pssa-run-gate-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pssa-gate-title"
        className="rounded-lg shadow-xl flex flex-col"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-primary)",
          color: "var(--text-primary)",
          width: "min(520px, 92vw)",
          maxHeight: "80vh",
          fontFamily: "var(--ui-font-family)",
          fontSize: "var(--ui-font-size)",
        }}
      >
        <div
          className="px-4 py-3 font-semibold"
          id="pssa-gate-title"
          style={{ borderBottom: "1px solid var(--border-primary)" }}
        >
          PSScriptAnalyzer found {errors.length} error
          {errors.length === 1 ? "" : "s"}
        </div>
        <div className="px-4 py-3 overflow-auto flex-1">
          <p className="mb-3" style={{ color: "var(--text-secondary)" }}>
            Fix these in Reference → Problems, or run anyway if you intend to
            test incomplete code.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {preview.map((diag, idx) => (
              <li
                key={`${diag.line}-${diag.column}-${idx}`}
                style={{
                  backgroundColor: "var(--bg-primary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "4px",
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  Line {diag.line}: {diag.message}
                </div>
                {diag.ruleName && (
                  <div
                    className="text-xs mt-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {diag.ruleName}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {errors.length > preview.length && (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              + {errors.length - preview.length} more in Problems
            </p>
          )}
        </div>
        <div
          className="px-4 py-3 flex flex-wrap justify-end gap-2"
          style={{ borderTop: "1px solid var(--border-primary)" }}
        >
          <button
            type="button"
            onClick={onCancel}
            data-testid="pssa-gate-cancel"
            className="px-3 py-1.5 rounded text-sm"
            style={{
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-tertiary)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onViewProblems}
            data-testid="pssa-gate-problems"
            className="px-3 py-1.5 rounded text-sm"
            style={{
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-tertiary)",
            }}
          >
            View Problems
          </button>
          <button
            ref={runButtonRef}
            type="button"
            onClick={onRunAnyway}
            data-testid="pssa-gate-run-anyway"
            className="px-3 py-1.5 rounded text-sm font-semibold"
            style={{
              backgroundColor: "var(--btn-primary-bg)",
              color: "var(--btn-primary-fg)",
              border: "none",
            }}
          >
            Run anyway
          </button>
        </div>
      </div>
    </div>
  );
}
