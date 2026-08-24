import { describe, expect, it, vi } from "vitest";
import {
  diagnosticsToMarkers,
  pssaSeverity,
  scheduleEditorDiagnostics,
} from "../editor-diagnostics";
import { clampPtyDims, MIN_PTY_ROWS } from "../terminal-utils";
import editorPane from "../components/EditorPane.tsx?raw";
import terminalBootstrap from "../../src-tauri/src/terminal.rs?raw";

describe("clampPtyDims", () => {
  it("floors rows below PowerShell RawUI minimum", () => {
    expect(clampPtyDims(80, 3)).toEqual({ cols: 80, rows: MIN_PTY_ROWS });
    expect(clampPtyDims(0, 0).rows).toBeGreaterThanOrEqual(MIN_PTY_ROWS);
  });
});

describe("editor diagnostics scheduling", () => {
  it("EditorPane schedules analysis when a tab opens, not only onChange", () => {
    expect(editorPane).toContain("scheduleEditorDiagnostics");
    expect(editorPane).toContain("Opening a broken .ps1 previously showed no squiggles");
  });

  it("maps ParseError to Monaco Error severity", () => {
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    } as unknown as typeof import("monaco-editor");
    expect(pssaSeverity(monaco, "ParseError")).toBe(8);
  });

  it("builds markers from diagnostics", () => {
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    } as unknown as typeof import("monaco-editor");
    const markers = diagnosticsToMarkers(monaco, [
      {
        message: "Unexpected token",
        severity: "ParseError",
        ruleName: "Parser",
        line: 126,
        column: 40,
        endLine: 126,
        endColumn: 41,
      },
    ]);
    expect(markers).toHaveLength(1);
    expect(markers[0].startLineNumber).toBe(126);
    expect(markers[0].source).toBe("Parser");
  });

  it("invokes analyze after debounce when enabled", async () => {
    vi.useFakeTimers();
    const setModelMarkers = vi.fn();
    const setProblems = vi.fn();
    const analyze = vi.fn().mockResolvedValue([
      {
        message: "Unexpected token",
        severity: "ParseError",
        ruleName: "Parser",
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
      },
    ]);
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      editor: { setModelMarkers },
    } as unknown as typeof import("monaco-editor");
    const model = {} as import("monaco-editor").editor.ITextModel;
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };

    scheduleEditorDiagnostics({
      enabled: true,
      psPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      scriptContent: "$($$(",
      tabId: "tab-1",
      monaco,
      model,
      timerRef,
      debounceMs: 50,
      analyze,
      setProblems,
    });

    expect(analyze).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(analyze).toHaveBeenCalledOnce();
    expect(setModelMarkers).toHaveBeenCalled();
    expect(setProblems).toHaveBeenCalledWith(
      "tab-1",
      expect.arrayContaining([
        expect.objectContaining({ ruleName: "Parser" }),
      ]),
    );
    vi.useRealTimers();
  });
});

describe("terminal WindowHeight warning mitigations", () => {
  it("bootstrap forces PSReadLine InlineView", () => {
    expect(terminalBootstrap).toContain(
      "Set-PSReadLineOption -PredictionViewStyle InlineView",
    );
    expect(terminalBootstrap).toContain("MIN_PTY_ROWS");
  });
});
