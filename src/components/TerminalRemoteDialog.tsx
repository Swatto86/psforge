/** Modal that collects the computer name for a remote console tab. */

import { useEffect, useRef } from "react";
import { REMOTE_TARGET_MAX_LENGTH } from "../terminal/remote-console";

interface TerminalRemoteDialogProps {
  target: string;
  validationError: string;
  onTargetChange: (target: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TerminalRemoteDialog({
  target,
  validationError,
  onTargetChange,
  onCancel,
  onConfirm,
}: TerminalRemoteDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel, onConfirm]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "460px",
          maxWidth: "calc(100vw - 32px)",
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-primary)",
          borderRadius: "6px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
          padding: "14px",
          fontFamily: "var(--ui-font-family)",
          fontSize: "var(--ui-font-size)",
        }}
        data-testid="terminal-remote-dialog"
      >
        <div
          style={{
            color: "var(--text-primary)",
            fontSize: "var(--ui-font-size-lg)",
            marginBottom: "8px",
            fontWeight: 600,
          }}
        >
          PSForge
        </div>
        <div style={{ color: "var(--text-secondary)", marginBottom: "8px" }}>
          Remote target for Enter-PSSession -ComputerName:
        </div>
        <input
          data-testid="terminal-remote-input"
          ref={inputRef}
          value={target}
          onChange={(e) =>
            onTargetChange(e.target.value.slice(0, REMOTE_TARGET_MAX_LENGTH))
          }
          placeholder="server01.contoso.local"
          style={{ width: "100%" }}
        />
        {validationError && (
          <div
            data-testid="terminal-remote-error"
            style={{
              color: "var(--stream-stderr)",
              marginTop: "6px",
              fontSize: "var(--ui-font-size-sm)",
            }}
          >
            {validationError}
          </div>
        )}
        <div
          style={{
            marginTop: "12px",
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
          }}
        >
          <button
            data-testid="terminal-remote-cancel"
            onClick={onCancel}
            style={{
              backgroundColor: "transparent",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
              padding: "4px 12px",
              borderRadius: "4px",
            }}
          >
            Cancel
          </button>
          <button
            data-testid="terminal-remote-connect"
            onClick={onConfirm}
            style={{
              backgroundColor: "var(--accent)",
              border: "1px solid var(--accent)",
              color: "#ffffff",
              padding: "4px 12px",
              borderRadius: "4px",
            }}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
