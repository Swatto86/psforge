/** Floating AI explanation popover anchored near the editor selection.
 *  Rendered by EditorPane over the Monaco container; closes on Escape or an
 *  outside click. Presentational only — the request lifecycle lives in
 *  EditorPane so a popover unmount can't orphan an in-flight ask_ai call.
 */

import React, { useEffect, useRef } from "react";

export type ExplainStatus = "loading" | "done" | "error";

interface ExplainPopoverProps {
  top: number;
  left: number;
  status: ExplainStatus;
  text: string;
  meta: string;
  onClose: () => void;
  onOpenInAssistant: () => void;
}

export function ExplainPopover({
  top,
  left,
  status,
  text,
  meta,
  onClose,
  onOpenInAssistant,
}: ExplainPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Capture phase so Escape closes the popover even while Monaco has focus.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      data-testid="explain-popover"
      className="menu-pop"
      style={{
        top,
        left,
        width: 420,
        maxWidth: "calc(100% - 16px)",
        padding: 8,
        fontFamily: "var(--ui-font-family)",
        fontSize: "var(--ui-font-size-sm)",
        color: "var(--text-primary)",
      }}
    >
      <div className="flex items-center gap-2 pb-1">
        <span className="font-semibold">AI Explanation</span>
        {meta && (
          <span className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
            {meta}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="icon-btn ml-auto"
          aria-label="Close explanation"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div
        className="whitespace-pre-wrap overflow-auto rounded p-2"
        style={{
          maxHeight: 280,
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-primary)",
          color: status === "error" ? "var(--stream-stderr)" : undefined,
        }}
      >
        {status === "loading" ? "Explaining selection…" : text}
      </div>
      {status === "done" && (
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onOpenInAssistant}
            className="bottom-pane-action"
          >
            Open in Assistant
          </button>
        </div>
      )}
    </div>
  );
}
