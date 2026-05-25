/** Combined Problems, Show Command, and Help views for script-runner workflow. */

import React from "react";
import type { ReferenceSubview } from "../types";

const SUBVIEWS: { id: ReferenceSubview; label: string }[] = [
  { id: "problems", label: "Problems" },
  { id: "show-command", label: "Show Command" },
  { id: "help", label: "Help" },
];

export interface ReferencePaneProps {
  subview: ReferenceSubview;
  onSubviewChange: (subview: ReferenceSubview) => void;
  problems: React.ReactNode;
  showCommand: React.ReactNode;
  help: React.ReactNode;
}

export function ReferencePane({
  subview,
  onSubviewChange,
  problems,
  showCommand,
  help,
}: ReferencePaneProps) {
  return (
    <div
      data-testid="reference-panel"
      className="flex flex-col h-full min-h-0 overflow-hidden"
    >
      <div
        className="flex items-center gap-1 px-2 py-1 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border-primary)" }}
      >
        {SUBVIEWS.map((item) => {
          const active = subview === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`reference-subview-${item.id}`}
              onClick={() => onSubviewChange(item.id)}
              className="px-2 py-1 rounded text-xs transition-colors"
              style={{
                backgroundColor: active ? "var(--bg-hover)" : "transparent",
                color: active ? "var(--text-accent)" : "var(--text-secondary)",
                border: active
                  ? "1px solid var(--border-primary)"
                  : "1px solid transparent",
                fontWeight: active ? 600 : 400,
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {subview === "problems" && (
          <div data-testid="problems-panel" className="h-full overflow-auto">
            {problems}
          </div>
        )}
        {subview === "show-command" && (
          <div className="h-full min-h-0 overflow-hidden">{showCommand}</div>
        )}
        {subview === "help" && (
          <div className="h-full min-h-0 overflow-hidden">{help}</div>
        )}
      </div>
    </div>
  );
}
