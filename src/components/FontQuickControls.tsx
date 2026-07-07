/** Status bar quick controls for editor/terminal monospace fonts. */

import React, { useEffect, useRef, useState } from "react";
import { useAppState } from "../store";
import {
  MONOSPACE_FONT_PRESETS,
  presetIdForFamily,
} from "../font-presets";

export function FontQuickControls() {
  const { state, dispatch } = useAppState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const linked = state.settings.linkEditorOutputFonts !== false;
  const presetId = presetIdForFamily(state.settings.fontFamily);

  const patchSettings = (changes: Partial<typeof state.settings>) => {
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, ...changes },
    });
  };

  const setFamily = (family: string) => {
    patchSettings(
      linked
        ? { fontFamily: family, outputFontFamily: family }
        : { fontFamily: family },
    );
  };

  const bumpEditorSize = (delta: number) => {
    const next = Math.max(
      8,
      Math.min(72, (state.settings.fontSize ?? 14) + delta),
    );
    // linkEditorOutputFonts governs font FAMILY only, not size — don't clobber
    // an independently-set terminal font size (S3-20).
    patchSettings({ fontSize: next });
  };

  const bumpTerminalSize = (delta: number) => {
    const next = Math.max(
      8,
      Math.min(72, (state.settings.outputFontSize ?? 13) + delta),
    );
    patchSettings({ outputFontSize: next });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        data-testid="status-font-control"
        onClick={() => setOpen((v) => !v)}
        title="Editor and terminal font (persisted in Settings)"
        style={{
          backgroundColor: "transparent",
          color: "var(--text-inverse)",
          cursor: "pointer",
          fontVariantNumeric: "tabular-nums",
          opacity: 0.9,
          fontSize: "inherit",
        }}
      >
        Editor {state.settings.fontSize}pt
        {!linked && ` · Term ${state.settings.outputFontSize ?? 13}pt`}
      </button>

      {open && (
        <div
          className="absolute z-50 rounded shadow-lg p-3 flex flex-col gap-2"
          style={{
            bottom: "100%",
            right: 0,
            marginBottom: "6px",
            backgroundColor: "var(--bg-tertiary)",
            border: "1px solid var(--border-primary)",
            minWidth: "240px",
            color: "var(--text-primary)",
            fontSize: "var(--ui-font-size-sm)",
          }}
        >
          <label className="flex flex-col gap-1">
            <span style={{ color: "var(--text-muted)" }}>Monospace font</span>
            <select
              value={presetId}
              onChange={(e) => {
                const preset = MONOSPACE_FONT_PRESETS.find(
                  (p) => p.id === e.target.value,
                );
                if (preset) setFamily(preset.family);
              }}
              className="text-sm"
            >
              {MONOSPACE_FONT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom (see Settings)</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={linked}
              onChange={(e) =>
                patchSettings({
                  linkEditorOutputFonts: e.target.checked,
                  outputFontFamily: e.target.checked
                    ? state.settings.fontFamily
                    : state.settings.outputFontFamily,
                })
              }
            />
            Same font for editor and terminal
          </label>

          <div className="flex items-center justify-between gap-2">
            <span>Editor size</span>
            <div className="flex items-center gap-1">
              <SizeButton label="−" onClick={() => bumpEditorSize(-1)} />
              <span style={{ minWidth: "2rem", textAlign: "center" }}>
                {state.settings.fontSize}
              </span>
              <SizeButton label="+" onClick={() => bumpEditorSize(1)} />
            </div>
          </div>

          {!linked && (
            <div className="flex items-center justify-between gap-2">
              <span>Terminal size</span>
              <div className="flex items-center gap-1">
                <SizeButton label="−" onClick={() => bumpTerminalSize(-1)} />
                <span style={{ minWidth: "2rem", textAlign: "center" }}>
                  {state.settings.outputFontSize ?? 13}
                </span>
                <SizeButton label="+" onClick={() => bumpTerminalSize(1)} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SizeButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: "24px",
        height: "24px",
        borderRadius: "4px",
        border: "1px solid var(--border-primary)",
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
