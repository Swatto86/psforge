/** Console tab bar: tab selection/close plus the pane-level actions. */

interface TerminalTabStripProps {
  tabs: Array<{ id: string; title: string }>;
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAddLocal: () => void;
  onAddRemote: () => void;
  onClear: () => void;
}

const ACTION_STYLE = {
  backgroundColor: "transparent",
  color: "var(--text-secondary)",
} as const;

export function TerminalTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onAddLocal,
  onAddRemote,
  onClear,
}: TerminalTabStripProps) {
  // The last console cannot be closed: the pane always hosts one.
  const canClose = tabs.length > 1;

  return (
    <div
      className="flex items-center gap-2 px-2 py-1"
      style={{
        borderBottom: "1px solid var(--border-primary)",
        backgroundColor: "var(--bg-secondary)",
        fontFamily: "var(--ui-font-family)",
        fontSize: "var(--ui-font-size)",
      }}
    >
      <div className="flex items-center gap-1 flex-1 overflow-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className="flex items-center"
              style={{
                border: `1px solid ${isActive ? "var(--accent)" : "var(--border-primary)"}`,
                borderRadius: "3px",
                backgroundColor: isActive ? "var(--bg-hover)" : "transparent",
              }}
            >
              <button
                onClick={() => onSelect(tab.id)}
                style={{
                  backgroundColor: "transparent",
                  color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                  padding: "2px 8px",
                  whiteSpace: "nowrap",
                }}
              >
                {tab.title}
              </button>
              {canClose && (
                <button
                  onClick={() => onClose(tab.id)}
                  style={{
                    backgroundColor: "transparent",
                    color: "var(--text-muted)",
                    padding: "2px 6px",
                  }}
                  title="Close console tab"
                >
                  x
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        data-testid="terminal-new-local"
        onClick={onAddLocal}
        style={ACTION_STYLE}
        title="New local console tab"
      >
        + Local
      </button>
      <button
        data-testid="terminal-new-remote"
        onClick={onAddRemote}
        style={ACTION_STYLE}
        title="New remote console tab (Enter-PSSession)"
      >
        + Remote
      </button>
      <button
        data-testid="terminal-clear-active"
        onClick={onClear}
        style={ACTION_STYLE}
        title="Clear the console, then restart PowerShell (fresh prompt)"
      >
        Clear
      </button>
      <span
        style={{
          color: "var(--text-muted)",
          fontSize: "var(--ui-font-size-sm)",
          whiteSpace: "nowrap",
        }}
        title="Hold Alt while scrolling the terminal to move quickly through scrollback"
      >
        Alt+scroll: fast scroll
      </span>
    </div>
  );
}
