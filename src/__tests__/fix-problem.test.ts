import { describe, expect, it } from "vitest";
import {
  buildFixAllProblemsQuestion,
  buildFixProblemQuestion,
  filterMarkersAtLine,
  pickPrimaryMarker,
  MAX_AI_QUESTION_CHARS,
  MAX_FIX_PROBLEM_CHARS,
} from "../fix-problem";
import type { editor as MonacoEditor } from "monaco-editor";
import type { PssaDiagnostic } from "../types";

function marker(
  partial: Partial<MonacoEditor.IMarker> &
    Pick<
      MonacoEditor.IMarker,
      "startLineNumber" | "endLineNumber" | "severity" | "message"
    >,
): MonacoEditor.IMarker {
  return {
    owner: "pssa",
    resource: {
      toString: () => "inmemory://x.ps1",
    } as MonacoEditor.IMarker["resource"],
    code: undefined,
    severity: partial.severity,
    message: partial.message,
    source: partial.source ?? "Parser",
    startLineNumber: partial.startLineNumber,
    startColumn: partial.startColumn ?? 1,
    endLineNumber: partial.endLineNumber,
    endColumn: partial.endColumn ?? 2,
    modelVersionId: 1,
    relatedInformation: undefined,
    tags: undefined,
  };
}

function diag(
  partial: Partial<PssaDiagnostic> & Pick<PssaDiagnostic, "message" | "line">,
): PssaDiagnostic {
  return {
    message: partial.message,
    severity: partial.severity ?? "Error",
    ruleName: partial.ruleName ?? "Parser",
    line: partial.line,
    column: partial.column ?? 1,
    endLine: partial.endLine ?? partial.line,
    endColumn: partial.endColumn ?? 2,
  };
}

describe("fix-problem helpers", () => {
  it("filters markers to the clicked line", () => {
    const markers = [
      marker({
        startLineNumber: 2,
        endLineNumber: 2,
        severity: 8,
        message: "a",
      }),
      marker({
        startLineNumber: 5,
        endLineNumber: 5,
        severity: 4,
        message: "b",
      }),
      marker({
        startLineNumber: 2,
        endLineNumber: 4,
        severity: 4,
        message: "span",
      }),
    ];
    const at2 = filterMarkersAtLine(markers, 2);
    expect(at2.map((m) => m.message).sort()).toEqual(["a", "span"]);
    expect(filterMarkersAtLine(markers, 9)).toEqual([]);
  });

  it("prefers Error severity when picking a primary marker", () => {
    const primary = pickPrimaryMarker([
      marker({
        startLineNumber: 1,
        endLineNumber: 1,
        startColumn: 1,
        severity: 4,
        message: "warn",
      }),
      marker({
        startLineNumber: 1,
        endLineNumber: 1,
        startColumn: 5,
        severity: 8,
        message: "err",
      }),
    ]);
    expect(primary?.message).toBe("err");
  });

  it("buildFixProblemQuestion includes location and asks for full script", () => {
    const { question, diagnostics } = buildFixProblemQuestion({
      message: "Unexpected token '('",
      severity: "ParseError",
      source: "Parser",
      startLineNumber: 12,
      startColumn: 5,
      endLineNumber: 12,
      endColumn: 6,
    });
    expect(diagnostics).toContain("line 12, column 5");
    expect(diagnostics).toContain("Unexpected token");
    expect(question).toContain("complete corrected script");
    expect(question).toContain("PROBLEM");
    expect(question.length).toBeLessThan(MAX_FIX_PROBLEM_CHARS + 800);
  });

  it("buildFixAllProblemsQuestion lists diagnostics and asks to fix", () => {
    const { question, diagnostics } = buildFixAllProblemsQuestion([
      diag({ message: "Unexpected token", line: 2, severity: "ParseError" }),
      diag({
        message: "Avoid Write-Host",
        line: 10,
        severity: "Warning",
        ruleName: "PSAvoidUsingWriteHost",
      }),
    ]);
    expect(diagnostics).toContain("Unexpected token");
    expect(diagnostics).toContain("Avoid Write-Host");
    expect(diagnostics).toContain("PSAvoidUsingWriteHost");
    expect(question).toContain("DIAGNOSTICS");
    expect(question).toContain("errors first");
    expect(question).toContain("complete corrected script");
    expect(question.length).toBeLessThan(MAX_AI_QUESTION_CHARS);
  });

  it("prioritizes parse/errors ahead of warnings in Fix All", () => {
    const batch = buildFixAllProblemsQuestion([
      diag({
        message: "Avoid Write-Host",
        line: 1,
        severity: "Warning",
        ruleName: "PSAvoidUsingWriteHost",
      }),
      diag({ message: "Unexpected token", line: 50, severity: "ParseError" }),
      diag({ message: "Null ref", line: 3, severity: "Error" }),
    ]);
    const first = batch.diagnostics.indexOf("Unexpected token");
    const second = batch.diagnostics.indexOf("Null ref");
    const third = batch.diagnostics.indexOf("Avoid Write-Host");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("keeps Fix All question under the backend limit for huge lists", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      diag({
        message: `Problem number ${i} with a moderately long explanation that would blow the question budget if inlined`,
        line: i + 1,
        severity: i % 5 === 0 ? "ParseError" : "Warning",
        ruleName: i % 5 === 0 ? "Parser" : "PSAvoidUsingWriteHost",
      }),
    );
    const batch = buildFixAllProblemsQuestion(many);
    expect(batch.question.length).toBeLessThanOrEqual(MAX_AI_QUESTION_CHARS);
    expect(batch.includedCount).toBeGreaterThan(0);
    expect(batch.includedCount + batch.omittedCount).toBe(400);
    expect(batch.diagnostics).toContain("ParseError");
    // Errors first: first line should be a ParseError, not a Warning-only dump.
    expect(batch.diagnostics.split("\n")[0]).toContain("ParseError");
  });
});

describe("Problems pane Fix This wiring", () => {
  it("exposes a right-click Fix This action on problem rows", async () => {
    const { default: problemsPane } = await import(
      "../components/ProblemsPane.tsx?raw"
    );
    expect(problemsPane).toContain("problems-fix-this");
    expect(problemsPane).toContain("Fix This");
    expect(problemsPane).toContain("onContextMenu");
    expect(problemsPane).toContain("buildFixProblemQuestion");
    expect(problemsPane).toContain("diagnosticToTarget");
  });
});
