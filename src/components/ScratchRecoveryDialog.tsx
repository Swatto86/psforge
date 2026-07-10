/** Offer to recover orphan scratch auto-saves after startup. */

import React, { useEffect, useRef, useState } from "react";
import * as cmd from "../commands";
import { basename } from "../path-utils";
import { useFocusTrap } from "./use-focus-trap";

export interface ScratchRecoveryCandidate {
  tabId: string;
  path: string;
}

interface Props {
  candidates: ScratchRecoveryCandidate[];
  onRecover: (selected: ScratchRecoveryCandidate[]) => void;
  onDismiss: () => void;
}

export function ScratchRecoveryDialog({
  candidates,
  onRecover,
  onDismiss,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.map((c) => c.tabId)),
  );
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const candidate of candidates) {
        try {
          const file = await cmd.readFileContent(candidate.path);
          const firstLines = file.content.split("\n").slice(0, 3).join("\n");
          next[candidate.tabId] = firstLines.trim() || "(empty script)";
        } catch {
          next[candidate.tabId] = "(could not read file)";
        }
      }
      if (!cancelled) setPreviews(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [candidates]);

  const toggle = (tabId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  };

  const recoverSelected = () => {
    const picked = candidates.filter((c) => selected.has(c.tabId));
    if (picked.length > 0) onRecover(picked);
    else onDismiss();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      data-testid="scratch-recovery-dialog"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scratch-recovery-title"
        className="rounded-lg shadow-xl flex flex-col"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-primary)",
          color: "var(--text-primary)",
          width: "min(560px, 92vw)",
          maxHeight: "80vh",
          fontFamily: "var(--ui-font-family)",
          fontSize: "var(--ui-font-size)",
        }}
      >
        <div
          id="scratch-recovery-title"
          className="px-4 py-3 font-semibold"
          style={{ borderBottom: "1px solid var(--border-primary)" }}
        >
          Recover unsaved scripts
        </div>
        <div className="px-4 py-3 overflow-auto">
          <p className="mb-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            PSForge found auto-saved scratch files that are not open in this
            session. Select which scripts to restore.
          </p>
          <ul className="flex flex-col gap-2">
            {candidates.map((candidate) => (
              <li
                key={candidate.tabId}
                className="rounded p-2 text-sm"
                style={{
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "var(--bg-primary)",
                }}
              >
                <label className="flex gap-2 cursor-pointer items-start">
                  <input
                    type="checkbox"
                    checked={selected.has(candidate.tabId)}
                    onChange={() => toggle(candidate.tabId)}
                    data-testid={`scratch-recover-check-${candidate.tabId}`}
                  />
                  <span className="min-w-0 flex-1">
                    <div style={{ fontWeight: 600 }}>
                      {basename(candidate.path)}
                    </div>
                    <div
                      className="text-xs mt-1 font-mono whitespace-pre-wrap break-all"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {previews[candidate.tabId] ?? "Loading…"}
                    </div>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div
          className="px-4 py-3 flex justify-end gap-2"
          style={{ borderTop: "1px solid var(--border-primary)" }}
        >
          <button
            type="button"
            onClick={onDismiss}
            data-testid="scratch-recovery-dismiss"
            className="px-3 py-1.5 rounded text-sm"
            style={{
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-tertiary)",
            }}
          >
            Not now
          </button>
          <button
            ref={primaryRef}
            type="button"
            onClick={recoverSelected}
            data-testid="scratch-recovery-confirm"
            className="px-3 py-1.5 rounded text-sm font-semibold"
            style={{
              backgroundColor: "var(--btn-primary-bg)",
              color: "var(--btn-primary-fg)",
              border: "none",
            }}
          >
            Recover selected
          </button>
        </div>
      </div>
    </div>
  );
}
