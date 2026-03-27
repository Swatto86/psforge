/** PSForge Script Signing Dialog.
 *
 *  Lists Authenticode code-signing certificates installed in the current user's
 *  personal certificate store and allows the user to sign the active script with
 *  a selected certificate via `Set-AuthenticodeSignature`.
 *
 *  Rules applied:
 *  - Rule 11: input validation (disabled when no cert / unsaved file / no filePath).
 *  - Rule 16: controls disabled when action is invalid; `data-testid` on every
 *    interactive element and independently-testable region.
 *  - Rule 11: graceful degradation (empty list + informative message when no certs).
 */

import React, { useEffect, useState, useCallback } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { CertInfo } from "../types";

export function ScriptSigningDialog() {
  const { state, dispatch, activeTab } = useAppState();
  const [certs, setCerts] = useState<CertInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedThumbprint, setSelectedThumbprint] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  // Fetch code-signing certs whenever the dialog opens.
  useEffect(() => {
    if (!state.showSigningDialog) return;
    setLoading(true);
    setCerts([]);
    setSelectedThumbprint("");
    setStatus(null);
    setError(null);
    setSigning(false);
    cmd
      .getSigningCertificates(state.selectedPsPath)
      .then((c) => {
        setCerts(c);
        if (c.length > 0) setSelectedThumbprint(c[0].thumbprint);
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load certificates.");
        setLoading(false);
      });
  }, [state.showSigningDialog, state.selectedPsPath]);

  // Close on Escape.
  useEffect(() => {
    if (!state.showSigningDialog) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "TOGGLE_SIGNING_DIALOG" });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [state.showSigningDialog, dispatch]);

  const handleClose = useCallback(() => {
    dispatch({ type: "TOGGLE_SIGNING_DIALOG" });
  }, [dispatch]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) handleClose();
  };

  /**
   * The Sign button is only enabled when:
   * - A certificate is selected.
   * - The active tab is a saved (not dirty) code file with a file path.
   */
  const canSign =
    !signing &&
    selectedThumbprint !== "" &&
    !!activeTab &&
    activeTab.tabType === "code" &&
    !!activeTab.filePath &&
    !activeTab.isDirty;

  const unsavedWarning =
    activeTab?.tabType === "code" && activeTab.filePath && activeTab.isDirty
      ? "Save the file before signing."
      : !activeTab?.filePath
        ? "Save the file to disk before signing."
        : null;

  const handleSign = async () => {
    if (!canSign || !activeTab?.filePath || !state.selectedPsPath) return;
    setSigning(true);
    setStatus(null);
    setError(null);
    try {
      const result = await cmd.signScript(
        state.selectedPsPath,
        activeTab.filePath,
        selectedThumbprint,
      );
      setStatus(result);
    } catch (err: unknown) {
      setError(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Signing failed.",
      );
    } finally {
      setSigning(false);
    }
  };

  return (
    <div
      data-testid="signing-dialog-backdrop"
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        data-testid="signing-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signing-dialog-title"
        style={{
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-primary)",
          borderRadius: "6px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.48)",
          width: "480px",
          maxWidth: "92vw",
          display: "flex",
          flexDirection: "column",
          fontFamily: "var(--ui-font-family)",
          fontSize: "var(--ui-font-size)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--border-primary)",
          }}
        >
          <span
            id="signing-dialog-title"
            style={{
              fontWeight: 600,
              color: "var(--text-primary)",
              fontSize: "var(--ui-font-size-lg)",
            }}
          >
            Sign Script
          </span>
          <button
            data-testid="signing-dialog-close"
            onClick={handleClose}
            title="Close (Escape)"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "var(--ui-font-size-xl)",
              lineHeight: 1,
              padding: "2px 6px",
              borderRadius: "3px",
            }}
          >
            &#x2715;
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {/* Active file info */}
          {activeTab?.filePath ? (
            <div
              style={{
                fontSize: "var(--ui-font-size-sm)",
                color: "var(--text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={activeTab.filePath}
            >
              File:{" "}
              <span style={{ color: "var(--text-primary)" }}>
                {activeTab.filePath}
              </span>
            </div>
          ) : (
            <div
              style={{
                fontSize: "var(--ui-font-size-sm)",
                color: "var(--text-warning, #e0a000)",
              }}
            >
              No file path -- save the script before signing.
            </div>
          )}

          {/* Unsaved-change warning */}
          {unsavedWarning && (
            <div
              data-testid="signing-dialog-unsaved-warning"
              style={{
                fontSize: "var(--ui-font-size-sm)",
                color: "var(--text-warning, #e0a000)",
                padding: "6px 10px",
                borderRadius: "4px",
                border: "1px solid var(--text-warning, #e0a000)",
                backgroundColor: "rgba(224,160,0,0.08)",
              }}
            >
              {unsavedWarning}
            </div>
          )}

          {/* Certificate list */}
          <div>
            <label
              htmlFor="signing-cert-select"
              style={{
                display: "block",
                fontSize: "var(--ui-font-size-sm)",
                fontWeight: 600,
                marginBottom: "6px",
                color: "var(--text-primary)",
              }}
            >
              Code-Signing Certificate
            </label>

            {loading && (
              <div
                data-testid="signing-dialog-loading"
                style={{ fontSize: "var(--ui-font-size-sm)", color: "var(--text-muted)" }}
              >
                Loading certificates...
              </div>
            )}

            {!loading && certs.length === 0 && !error && (
              <div
                data-testid="signing-dialog-no-certs"
                style={{
                  fontSize: "var(--ui-font-size-sm)",
                  color: "var(--text-muted)",
                  padding: "8px 10px",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "4px",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                No code-signing certificates found in CurrentUser\My.
                <br />
                Install a certificate or use{" "}
                <code
                  style={{
                    backgroundColor: "var(--bg-tertiary)",
                    padding: "0 3px",
                    borderRadius: "2px",
                  }}
                >
                  New-SelfSignedCertificate
                </code>{" "}
                to create one.
              </div>
            )}

            {!loading && certs.length > 0 && (
              <select
                id="signing-cert-select"
                data-testid="signing-dialog-cert-select"
                value={selectedThumbprint}
                onChange={(e) => setSelectedThumbprint(e.target.value)}
                style={{
                  width: "100%",
                  backgroundColor: "var(--bg-input)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-primary)",
                  borderRadius: "4px",
                  padding: "4px 8px",
                  fontSize: "var(--ui-font-size-sm)",
                }}
              >
                {certs.map((c) => (
                  <option key={c.thumbprint} value={c.thumbprint}>
                    {c.friendlyName || c.subject} — expires {c.expiry}
                  </option>
                ))}
              </select>
            )}

            {/* Selected cert details */}
            {!loading && selectedThumbprint && (
              <div
                data-testid="signing-dialog-cert-details"
                style={{
                  marginTop: "6px",
                  fontSize: "var(--ui-font-size-xs)",
                  color: "var(--text-muted)",
                  fontFamily: "monospace",
                }}
              >
                {certs.find((c) => c.thumbprint === selectedThumbprint)
                  ?.subject ?? ""}
                <br />
                Thumbprint: {selectedThumbprint}
              </div>
            )}
          </div>

          {/* Status / error feedback */}
          {status && (
            <div
              data-testid="signing-dialog-status"
              style={{
                fontSize: "var(--ui-font-size-sm)",
                color: "var(--text-success, #4ec94e)",
                padding: "6px 10px",
                borderRadius: "4px",
                border: "1px solid var(--text-success, #4ec94e)",
                backgroundColor: "rgba(78,201,78,0.08)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {status}
            </div>
          )}

          {error && (
            <div
              data-testid="signing-dialog-error"
              style={{
                fontSize: "var(--ui-font-size-sm)",
                color: "var(--text-error, #f47174)",
                padding: "6px 10px",
                borderRadius: "4px",
                border: "1px solid var(--text-error, #f47174)",
                backgroundColor: "rgba(244,113,116,0.08)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer / actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "12px 20px 16px",
            borderTop: "1px solid var(--border-primary)",
          }}
        >
          <button
            data-testid="signing-dialog-cancel"
            onClick={handleClose}
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-primary)",
              borderRadius: "4px",
              padding: "5px 16px",
              cursor: "pointer",
              fontSize: "var(--ui-font-size-md)",
            }}
          >
            Cancel
          </button>
          <button
            data-testid="signing-dialog-sign-btn"
            onClick={() => void handleSign()}
            disabled={!canSign}
            title={
              !activeTab?.filePath
                ? "Save the script first"
                : activeTab.isDirty
                  ? "Save the script before signing"
                  : certs.length === 0
                    ? "No code-signing certificate available"
                    : "Sign script with selected certificate"
            }
            style={{
              backgroundColor: canSign
                ? "var(--accent-primary, #0078d4)"
                : "var(--bg-secondary)",
              color: canSign ? "#fff" : "var(--text-muted)",
              border: "1px solid var(--border-primary)",
              borderRadius: "4px",
              padding: "5px 16px",
              cursor: canSign ? "pointer" : "not-allowed",
              fontSize: "var(--ui-font-size-md)",
              opacity: canSign ? 1 : 0.55,
            }}
          >
            {signing ? "Signing..." : "Sign"}
          </button>
        </div>
      </div>
    </div>
  );
}

