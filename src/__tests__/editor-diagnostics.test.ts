import { describe, expect, it, vi } from "vitest";
import type { PssaDiagnostic } from "../types";
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
  it("EditorPane paints diagnostics markers from app-level analysis", () => {
    expect(editorPane).toContain("applyDiagnosticsMarkers");
    expect(editorPane).toContain("editorMountGen");
    expect(editorPane).not.toContain("scheduleEditorDiagnostics");
  });

  it("runs analyze when only the PS host is ready (Monaco model optional)", async () => {
    vi.useFakeTimers();
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
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };

    scheduleEditorDiagnostics({
      enabled: true,
      psPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      scriptContent: "$($$(",
      tabId: "tab-1",
      monaco: null,
      model: null,
      timerRef,
      debounceMs: 0,
      analyze,
      setProblems,
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(analyze).toHaveBeenCalledOnce();
    expect(setProblems).toHaveBeenCalledWith(
      "tab-1",
      expect.arrayContaining([
        expect.objectContaining({ ruleName: "Parser" }),
      ]),
    );
    vi.useRealTimers();
  });

  it("does not clear Problems while Monaco or the PS host are not ready", () => {
    const setProblems = vi.fn();
    scheduleEditorDiagnostics({
      enabled: true,
      psPath: "",
      scriptContent: "$($$(",
      tabId: "tab-1",
      monaco: null,
      model: null,
      timerRef: { current: null },
      debounceMs: 0,
      analyze: vi.fn(),
      setProblems,
    });
    expect(setProblems).not.toHaveBeenCalled();
  });

  it("maps ParseError to Monaco Error severity", () => {
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    } as unknown as typeof import("monaco-editor");
    expect(pssaSeverity(monaco, "ParseError")).toBe(8);
  });

  it("maps file-level PSSA diagnostics (line 0) to line 1 for Monaco", () => {
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    } as unknown as typeof import("monaco-editor");
    const markers = diagnosticsToMarkers(monaco, [
      {
        message: "Missing BOM",
        severity: "Warning",
        ruleName: "PSUseBOMForUnicodeEncodedFile",
        line: 0,
        column: 0,
        endLine: 0,
        endColumn: 0,
      },
    ]);
    expect(markers[0].startLineNumber).toBe(1);
    expect(markers[0].startColumn).toBe(1);
  });

  it("ignores stale results when the active tab changed mid-flight", async () => {
    vi.useFakeTimers();
    let resolveAnalyze: (v: PssaDiagnostic[]) => void = () => {};
    const analyze = vi.fn(
      () =>
        new Promise<PssaDiagnostic[]>((resolve) => {
          resolveAnalyze = resolve;
        }),
    );
    const setProblems = vi.fn();
    const activeTabIdRef = { current: "tab-1" };
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };

    scheduleEditorDiagnostics({
      enabled: true,
      psPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      scriptContent: "$x = 1",
      tabId: "tab-1",
      monaco: null,
      model: null,
      timerRef,
      debounceMs: 0,
      analyze,
      setProblems,
      activeTabIdRef,
    });

    await vi.advanceTimersByTimeAsync(0);
    activeTabIdRef.current = "tab-2";
    resolveAnalyze([
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
    await Promise.resolve();
    expect(setProblems).not.toHaveBeenCalled();
    vi.useRealTimers();
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
  it("bootstrap captures user prompt after deferred profile load", () => {
    const profileIdx = terminalBootstrap.indexOf("PSFORGE_LOAD_PROFILE");
    const priorIdx = terminalBootstrap.indexOf("PSForgePriorPrompt");
    expect(profileIdx).toBeGreaterThan(0);
    expect(priorIdx).toBeGreaterThan(profileIdx);
  });

  it("bootstrap forces PSReadLine InlineView and deferred profile load", () => {
    expect(terminalBootstrap).toContain(
      "Set-PSReadLineOption -PredictionViewStyle InlineView",
    );
    expect(terminalBootstrap).toContain("PSFORGE_LOAD_PROFILE");
    expect(terminalBootstrap).toContain("MIN_PTY_ROWS");
    expect(terminalBootstrap).toContain("SilentlyContinue");
  });
});
