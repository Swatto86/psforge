import React, { useMemo, useState } from "react";
import { askAi } from "../commands";
import { buildDebugBundleMarkdown } from "../debug-bundle";
import {
  getRunOutputLineCount,
  getTerminalPlainContent,
} from "../terminal-utils";
import type { AiMode } from "../types";
import { useAppState, newTabId, untitledCounter } from "../store";

function getLastRunOutput(): string {
  const count = getRunOutputLineCount();
  if (count === 0) return "";
  return count !== null
    ? getTerminalPlainContent(count)
    : getTerminalPlainContent();
}

function modeQuestion(mode: AiMode, current: string): string {
  const trimmed = current.trim();
  if (trimmed) return trimmed;
  if (mode === "fix") return "Fix the active script.";
  return "";
}

export function AssistantPane() {
  const { state, dispatch, activeTab } = useAppState();
  const [mode, setMode] = useState<AiMode>("ask");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [code, setCode] = useState("");
  const [meta, setMeta] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const codeTab =
    activeTab && activeTab.tabType !== "welcome" ? activeTab : undefined;
  const activeProblems = useMemo(() => {
    if (!codeTab) return [];
    return state.problems[codeTab.id] ?? [];
  }, [codeTab, state.problems]);

  const hasCodeTab = !!codeTab;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === "fix" && !hasCodeTab) {
      setError("Open a script tab to fix.");
      return;
    }
    const prompt = modeQuestion(mode, question);
    if (!prompt) {
      setError("Type a question or describe the script you want.");
      return;
    }
    setBusy(true);
    setError("");
    setAnswer("");
    setCode("");
    setMeta("");
    try {
      const terminalOutput = getLastRunOutput();
      const diagnostics = activeProblems
        .map((d) => `Line ${d.line}: ${d.message}${d.ruleName ? ` (${d.ruleName})` : ""}`)
        .join("\n");
      const response = await askAi(state.settings, {
        mode,
        question: prompt,
        scriptPath: codeTab ? codeTab.filePath || codeTab.title : "",
        script: codeTab ? codeTab.content : "",
        terminalOutput,
        diagnostics,
      });
      setAnswer(response.answer);
      setCode(response.code ?? "");
      setMeta(`${response.provider} · ${response.model}`);
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const replaceScript = () => {
    if (!code.trim()) return;
    if (codeTab) {
      dispatch({
        type: "UPDATE_TAB",
        id: codeTab.id,
        changes: {
          content: code,
          isDirty: code !== codeTab.savedContent,
        },
      });
      return;
    }
    const id = newTabId();
    dispatch({
      type: "ADD_TAB",
      tab: {
        id,
        title: `Untitled-${untitledCounter()}`,
        filePath: "",
        content: code,
        savedContent: "",
        encoding: "utf8",
        language: "powershell",
        isDirty: true,
        tabType: "code",
      },
    });
  };

  const insertAtCursor = () => {
    if (!code.trim()) return;
    window.dispatchEvent(new CustomEvent("psforge-insert", { detail: code }));
  };

  const copyContext = async () => {
    const markdown = buildDebugBundleMarkdown({
      tab: codeTab,
      lastRun: state.lastRunResult,
      workingDir: state.workingDir,
      problems: activeProblems,
      getRunOutput: getLastRunOutput,
    });
    await navigator.clipboard.writeText(markdown);
  };

  return (
    <div
      data-testid="assistant-pane"
      className="flex h-full min-h-0 gap-3 p-3"
      style={{
        color: "var(--text-primary)",
        fontFamily: "var(--ui-font-family)",
        fontSize: "var(--ui-font-size-sm)",
      }}
    >
      <form onSubmit={submit} className="flex min-w-[280px] w-[36%] flex-col gap-2">
        <div className="flex gap-1">
          {(["ask", "write", "fix"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={mode === id ? "bottom-pane-action bottom-pane-action-primary" : "bottom-pane-action"}
            >
              {id === "ask" ? "Ask" : id === "write" ? "Write" : "Fix"}
            </button>
          ))}
        </div>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            mode === "fix"
              ? "What should be fixed? Blank means fix the active script."
              : mode === "write"
                ? "Describe the script you want."
                : "Ask about the active script or last run."
          }
          rows={8}
          className="w-full resize-none rounded px-2 py-1"
          style={{
            backgroundColor: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
            fontFamily: state.settings.outputFontFamily,
          }}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            className="bottom-pane-action bottom-pane-action-primary"
          >
            {busy ? "Asking..." : "Send"}
          </button>
          <button type="button" onClick={() => void copyContext()} className="bottom-pane-action">
            Copy Context
          </button>
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Context includes the active script, PSSA diagnostics, and last run output.
        </div>
      </form>

      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden">
        {error && (
          <div
            className="rounded p-2"
            style={{
              color: "var(--stream-stderr)",
              border: "1px solid var(--border-primary)",
              backgroundColor: "var(--bg-secondary)",
            }}
          >
            {error}
          </div>
        )}
        {meta && <div style={{ color: "var(--text-muted)" }}>{meta}</div>}
        <div className="min-h-[72px] whitespace-pre-wrap rounded p-2 overflow-auto"
          style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}
        >
          {answer || "AI responses will appear here."}
        </div>
        {code && (
          <>
            <div className="flex flex-wrap gap-2">
              <button onClick={replaceScript} className="bottom-pane-action bottom-pane-action-primary">
                {hasCodeTab ? "Replace Script" : "New Script"}
              </button>
              <button onClick={insertAtCursor} className="bottom-pane-action" disabled={!hasCodeTab}>
                Insert at Cursor
              </button>
            </div>
            <pre
              className="min-h-0 flex-1 overflow-auto rounded p-2"
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-primary)",
                fontFamily: state.settings.outputFontFamily,
                fontSize: `${state.settings.outputFontSize ?? 13}px`,
              }}
            >
              <code>{code}</code>
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
