/** Close confirmation for untitled / scratch-backed tabs. */

import React, { useEffect, useRef } from "react";
import { useFocusTrap } from "./use-focus-trap";

export type CloseScratchChoice = "save-as" | "discard" | "keep" | "cancel";

interface Props {
  tabTitle: string;
  onChoice: (choice: CloseScratchChoice) => void;
}

export function CloseScratchDialog({ tabTitle, onChoice }: Props) {
  const saveRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    saveRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      data-testid="close-scratch-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onChoice("cancel");
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-scratch-title"
        className="rounded-lg shadow-xl"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-primary)",
          color: "var(--text-primary)",
          width: "min(440px, 92vw)",
          fontFamily: "var(--ui-font-family)",
          fontSize: "var(--ui-font-size)",
        }}
      >
        <div
          id="close-scratch-title"
          className="px-4 py-3 font-semibold"
          style={{ borderBottom: "1px solid var(--border-primary)" }}
        >
          Close &quot;{tabTitle}&quot;?
        </div>
        <p className="px-4 py-3 text-sm" style={{ color: "var(--text-secondary)" }}>
          This untitled script has unsaved changes. Save it to a permanent
          location, keep the scratch copy on disk, or discard the scratch file.
        </p>
        <div
          className="px-4 py-3 flex flex-col sm:flex-row justify-end gap-2"
          style={{ borderTop: "1px solid var(--border-primary)" }}
        >
          <button
            type="button"
            onClick={() => onChoice("cancel")}
            data-testid="close-scratch-cancel"
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
            onClick={() => onChoice("keep")}
            data-testid="close-scratch-keep"
            className="px-3 py-1.5 rounded text-sm"
            style={{
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-tertiary)",
            }}
          >
            Keep in scratch
          </button>
          <button
            type="button"
            onClick={() => onChoice("discard")}
            data-testid="close-scratch-discard"
            className="px-3 py-1.5 rounded text-sm"
            style={{
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-tertiary)",
            }}
          >
            Discard
          </button>
          <button
            ref={saveRef}
            type="button"
            onClick={() => onChoice("save-as")}
            data-testid="close-scratch-save-as"
            className="px-3 py-1.5 rounded text-sm font-semibold"
            style={{
              backgroundColor: "var(--btn-primary-bg)",
              color: "var(--btn-primary-fg)",
              border: "none",
            }}
          >
            Save as…
          </button>
        </div>
      </div>
    </div>
  );
}
