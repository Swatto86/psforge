/** PSForge About dialog.
 *
 *  Displays application name, version, description, author credits, GitHub link,
 *  license, and tech stack.  Mirrors the layout and content style used in
 *  DiskSleuth (github.com/Swatto86/DiskSleuth).
 *
 *  Opening/closing is controlled by the `showAbout` flag in the app store.
 *  The dialog is theme-aware via CSS variables, and adapts to dark, light,
 *  and ise-classic themes without any additional logic.
 */

import React, { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppState } from "../store";

export function AboutDialog() {
  const { dispatch } = useAppState();
  const [version, setVersion] = useState<string>("...");

  // Fetch the app version from Tauri once on mount.
  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion("1.0.5"));
  }, []);

  // Close on Escape key.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dispatch({ type: "TOGGLE_ABOUT" });
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [dispatch]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only close when clicking directly on the backdrop, not the dialog card.
    if (e.target === e.currentTarget) {
      dispatch({ type: "TOGGLE_ABOUT" });
    }
  };

  const handleGitHub = () => {
    openUrl("https://github.com/Swatto86/PSForge").catch(() => {});
  };

  return (
    // Semi-transparent backdrop.
    <div
      data-testid="about-dialog-backdrop"
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
      {/* Dialog card */}
      <div
        data-testid="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        style={{
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-primary)",
          borderRadius: "6px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.48)",
          width: "340px",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "0",
        }}
      >
        {/* App name with icon */}
        <div style={{ textAlign: "center", marginBottom: "4px" }}>
          <span
            id="about-dialog-title"
            data-testid="about-dialog-title"
            style={{
              fontSize: "24px",
              fontWeight: "bold",
              color: "var(--accent)",
            }}
          >
            ⚡ PS Forge
          </span>
        </div>

        {/* Version */}
        <div
          data-testid="about-dialog-version"
          style={{
            textAlign: "center",
            fontSize: "var(--ui-font-size-md)",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          v{version}
        </div>

        {/* Description */}
        <div
          data-testid="about-dialog-description"
          style={{
            fontSize: "var(--ui-font-size-sm)",
            color: "var(--text-primary)",
            textAlign: "center",
            lineHeight: "1.6",
            marginBottom: "16px",
          }}
        >
          A powerful PowerShell IDE for Windows.{"\n"}
          Syntax highlighting, IntelliSense,{"\n"}
          an integrated terminal and more.
        </div>

        {/* Separator */}
        <hr
          style={{
            border: "none",
            borderTop: "1px solid var(--border-primary)",
            margin: "0 0 12px 0",
          }}
        />

        {/* Developer */}
        <div
          data-testid="about-dialog-developer"
          style={{
            textAlign: "center",
            fontSize: "var(--ui-font-size-md)",
            fontWeight: "bold",
            color: "var(--text-primary)",
            marginBottom: "8px",
          }}
        >
          Developed by Swatto
        </div>

        {/* GitHub link */}
        <div style={{ textAlign: "center", marginBottom: "8px" }}>
          <button
            data-testid="about-dialog-github-link"
            onClick={handleGitHub}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "var(--ui-font-size-sm)",
              color: "var(--text-accent)",
              textDecoration: "underline",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = "0.8";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = "1";
            }}
          >
            github.com/Swatto86/PSForge
          </button>
        </div>

        {/* License */}
        <div
          style={{
            textAlign: "center",
            fontSize: "var(--ui-font-size-xs)",
            color: "var(--text-muted)",
            marginBottom: "4px",
          }}
        >
          MIT License - (c) 2025 Swatto
        </div>

        {/* Tech stack */}
        <div
          data-testid="about-dialog-tech"
          style={{
            textAlign: "center",
            fontSize: "var(--ui-font-size-xs)",
            color: "var(--text-muted)",
            marginBottom: "20px",
          }}
        >
          Built with PSForge runtime, React &amp; Monaco Editor
        </div>

        {/* Close button */}
        <div style={{ textAlign: "center" }}>
          <button
            data-testid="about-dialog-close"
            onClick={() => dispatch({ type: "TOGGLE_ABOUT" })}
            style={{
              backgroundColor: "var(--accent)",
              color: "#ffffff",
              border: "none",
              borderRadius: "4px",
              padding: "6px 24px",
              fontSize: "var(--ui-font-size-md)",
              cursor: "pointer",
              fontWeight: "500",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = "0.85";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = "1";
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

