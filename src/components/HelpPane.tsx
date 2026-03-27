/** PSForge context-sensitive Help pane.
 *  Resolves command help via Get-Help and renders it in a dedicated bottom tab.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { CommandHelpInfo } from "../types";

type HelpRequestEvent = CustomEvent<{ query?: string }>;

export function HelpPane() {
  const { state } = useAppState();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CommandHelpInfo | null>(null);

  const lookup = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      setQuery(q);
      setError("");
      if (!q || !state.selectedPsPath) {
        setResult(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const help = await cmd.getCommandHelp(state.selectedPsPath, q);
        setResult(help);
        if (!help) {
          setError(`No help found for "${q}".`);
        }
      } catch (err) {
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        setResult(null);
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [state.selectedPsPath],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const q = (event as HelpRequestEvent).detail?.query ?? "";
      void lookup(q);
    };
    window.addEventListener("psforge-help-request", handler);
    return () => window.removeEventListener("psforge-help-request", handler);
  }, [lookup]);

  const controlStyle = {
    minHeight: "30px",
    backgroundColor: "var(--bg-input)",
    border: "1px solid var(--border-primary)",
    color: "var(--text-primary)",
    padding: "4px 8px",
  } as const;

  return (
    <div
      data-testid="help-pane"
      className="h-full overflow-auto px-3 py-2"
      style={{
        fontFamily: "var(--ui-font-family)",
        fontSize: "var(--ui-font-size)",
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void lookup(query);
            }
          }}
          placeholder="Type a command/topic (for example Get-ChildItem)"
          className="flex-1"
          style={{
            ...controlStyle,
          }}
        />
        <button
          onClick={() => void lookup(query)}
          disabled={!state.selectedPsPath || loading || !query.trim()}
          style={{
            backgroundColor: "transparent",
            color:
              !state.selectedPsPath || loading || !query.trim()
                ? "var(--text-muted)"
                : "var(--text-accent)",
            cursor:
              !state.selectedPsPath || loading || !query.trim()
                ? "default"
                : "pointer",
          }}
        >
          {loading ? "Loading..." : "Get Help"}
        </button>
      </div>

      {!result && !error && !loading && (
        <div className="mt-3" style={{ color: "var(--text-muted)" }}>
          Press F1 in the editor for context help, or search manually here.
        </div>
      )}

      {error && (
        <div className="mt-3" style={{ color: "var(--stream-stderr)" }}>
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <div style={{ color: "var(--text-accent)", fontWeight: 600 }}>
              {result.name}
            </div>
            {result.onlineUri && (
              <a
                href={result.onlineUri}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--text-secondary)" }}
              >
                {result.onlineUri}
              </a>
            )}
          </div>

          <section>
            <div style={{ color: "var(--text-secondary)" }}>Synopsis</div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                color: "var(--text-primary)",
                margin: 0,
                fontFamily:
                  state.settings.outputFontFamily ??
                  "Cascadia Code, Consolas, monospace",
                fontSize: `${state.settings.outputFontSize ?? 13}px`,
              }}
            >
              {result.synopsis || "(none)"}
            </pre>
          </section>

          <section>
            <div style={{ color: "var(--text-secondary)" }}>Syntax</div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                color: "var(--text-primary)",
                margin: 0,
                fontFamily:
                  state.settings.outputFontFamily ??
                  "Cascadia Code, Consolas, monospace",
                fontSize: `${state.settings.outputFontSize ?? 13}px`,
              }}
            >
              {result.syntax || "(none)"}
            </pre>
          </section>

          <section>
            <div style={{ color: "var(--text-secondary)" }}>Details</div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                color: "var(--text-primary)",
                margin: 0,
                maxHeight: "360px",
                overflow: "auto",
                fontFamily:
                  state.settings.outputFontFamily ??
                  "Cascadia Code, Consolas, monospace",
                fontSize: `${state.settings.outputFontSize ?? 13}px`,
              }}
            >
              {result.fullText || "(none)"}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
