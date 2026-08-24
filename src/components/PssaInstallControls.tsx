/** PSScriptAnalyzer status + install controls (PS 5.1 and 7 hosts). */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  checkPsScriptAnalyzer,
  installPsScriptAnalyzer,
} from "../commands";
import type { PssaInstallResult, PssaModuleStatus, PsVersion } from "../types";
import { showAppToast } from "./ToastStack";

interface Props {
  selectedPsPath: string;
  psVersions: PsVersion[];
  autoInstall: boolean;
  onAutoInstallChange: (value: boolean) => void;
}

export function PssaInstallControls({
  selectedPsPath,
  psVersions,
  autoInstall,
  onAutoInstallChange,
}: Props) {
  const [status, setStatus] = useState<PssaModuleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string>("");

  const refresh = useCallback(async () => {
    if (!selectedPsPath) {
      setStatus(null);
      return;
    }
    try {
      const next = await checkPsScriptAnalyzer(selectedPsPath);
      setStatus(next);
    } catch {
      setStatus({
        installed: false,
        version: "",
        hostVersion: "",
        message: "Could not check PSScriptAnalyzer status",
      });
    }
  }, [selectedPsPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runInstall = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || busy) return;
      setBusy(true);
      setLastResult("");
      const unique = [...new Set(paths.filter((p) => p.trim()))];
      const lines: string[] = [];
      try {
        for (const path of unique) {
          const label =
            psVersions.find((v) => v.path === path)?.name ?? path;
          showAppToast(`Installing PSScriptAnalyzer for ${label}…`);
          const result: PssaInstallResult =
            await installPsScriptAnalyzer(path);
          const ver = result.version ? ` v${result.version}` : "";
          if (result.status === "failed") {
            lines.push(`${label}: failed — ${result.message}`);
          } else {
            lines.push(`${label}: ${result.status}${ver}`);
          }
        }
        setLastResult(lines.join(" · "));
        showAppToast(lines.join(" · "));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, psVersions, refresh],
  );

  const statusLine = !selectedPsPath
    ? "Select a PowerShell host first."
    : status == null
      ? "Checking…"
      : status.installed
        ? `Installed v${status.version || "?"} (host ${status.hostVersion || "?"})`
        : `Not installed${status.hostVersion ? ` (host ${status.hostVersion})` : ""}`;

  return (
    <div className="flex flex-col gap-2" data-testid="pssa-install-controls">
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={autoInstall}
          onChange={(e) => onAutoInstallChange(e.target.checked)}
        />
        <span style={{ color: "var(--text-secondary)" }}>
          Auto-install PSScriptAnalyzer when missing (CurrentUser)
        </span>
      </label>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Style and best-practice rules need the gallery module. Syntax squiggles
        work without it. Installs separately for PowerShell 7 and Windows
        PowerShell 5.1.
      </p>
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        Current host: {statusLine}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary text-sm"
          disabled={busy || !selectedPsPath}
          onClick={() => void runInstall([selectedPsPath])}
        >
          {busy ? "Installing…" : "Install for current PowerShell"}
        </button>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          disabled={busy || psVersions.length === 0}
          onClick={() => void runInstall(psVersions.map((v) => v.path))}
        >
          Install for all discovered hosts
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm"
          disabled={busy || !selectedPsPath}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      {lastResult && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {lastResult}
        </p>
      )}
    </div>
  );
}

/** One-shot background install when diagnostics are on and the module is missing. */
export function usePssaAutoInstall(opts: {
  enabled: boolean;
  autoInstall: boolean;
  selectedPsPath: string;
}): void {
  const attemptedRef = useRef<string>("");

  useEffect(() => {
    const path = opts.selectedPsPath.trim();
    if (!opts.enabled || !opts.autoInstall || !path) return;
    if (attemptedRef.current === path) return;
    attemptedRef.current = path;

    let cancelled = false;
    void (async () => {
      try {
        const status = await checkPsScriptAnalyzer(path);
        if (cancelled || status.installed) return;
        showAppToast("Installing PSScriptAnalyzer for richer diagnostics…");
        const result = await installPsScriptAnalyzer(path);
        if (cancelled) return;
        if (result.status === "failed") {
          showAppToast(`PSScriptAnalyzer install failed: ${result.message}`);
        } else {
          showAppToast(
            `PSScriptAnalyzer ${result.status}${result.version ? ` v${result.version}` : ""}`,
          );
        }
      } catch (err) {
        if (!cancelled) {
          showAppToast(
            `PSScriptAnalyzer install skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [opts.enabled, opts.autoInstall, opts.selectedPsPath]);
}

/** Compact Problems-pane CTA when the gallery module is missing. */
export function ProblemsPssaHint({ psPath }: { psPath: string }) {
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!psPath.trim()) {
      setMissing(false);
      return;
    }
    void (async () => {
      try {
        const status = await checkPsScriptAnalyzer(psPath);
        if (!cancelled) setMissing(!status.installed);
      } catch {
        if (!cancelled) setMissing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [psPath]);

  if (!missing) return null;

  return (
    <div
      className="px-3 py-2 text-sm flex flex-wrap items-center gap-2"
      style={{
        borderBottom: "1px solid var(--border-primary)",
        color: "var(--text-secondary)",
        background: "var(--bg-secondary)",
      }}
      data-testid="problems-pssa-hint"
    >
      <span>
        Syntax checks are on. Install PSScriptAnalyzer for style rules (CurrentUser).
      </span>
      <button
        type="button"
        className="btn btn-secondary text-sm"
        disabled={busy || !psPath}
        onClick={() => {
          setBusy(true);
          void installPsScriptAnalyzer(psPath)
            .then((result) => {
              showAppToast(
                result.status === "failed"
                  ? `Install failed: ${result.message}`
                  : `PSScriptAnalyzer ${result.status}${result.version ? ` v${result.version}` : ""}`,
              );
              if (result.status !== "failed") setMissing(false);
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Installing…" : "Install now"}
      </button>
    </div>
  );
}
