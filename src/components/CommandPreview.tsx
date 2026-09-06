import type { CSSProperties } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showAppToast } from "./ToastStack";

type Props = {
  commandPreview: string;
  insertCommand: () => void;
  controlStyle: CSSProperties;
  fontFamily: string;
  fontSize: number;
};

export function CommandPreview({ commandPreview, insertCommand, controlStyle, fontFamily, fontSize }: Props) {
  return (
      <div className="mt-3">
        <div style={{ color: "var(--text-secondary)" }}>
          Command Preview
        </div>
        <textarea
          value={commandPreview}
          readOnly
          rows={3}
          className="w-full mt-1 px-2 py-1"
          style={{
            ...controlStyle,
            fontFamily:
              fontFamily ??
              "Cascadia Code, Consolas, monospace",
            fontSize: `${fontSize ?? 13}px`,
            resize: "vertical",
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={insertCommand}
            disabled={!commandPreview.trim()}
            style={{
              backgroundColor: "transparent",
              color: commandPreview.trim()
                ? "var(--text-accent)"
                : "var(--text-muted)",
              cursor: commandPreview.trim() ? "pointer" : "default",
            }}
          >
            Insert At Cursor
          </button>
          <button
            onClick={() => writeText(commandPreview).catch(() => showAppToast("Could not copy the command to the clipboard."))}
            disabled={!commandPreview.trim()}
            style={{
              backgroundColor: "transparent",
              color: commandPreview.trim()
                ? "var(--text-secondary)"
                : "var(--text-muted)",
              cursor: commandPreview.trim() ? "pointer" : "default",
            }}
          >
            Copy
          </button>
        </div>
      </div>
  );
}
