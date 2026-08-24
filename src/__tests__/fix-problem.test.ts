import { describe, expect, it } from "vitest";
import {
  buildFixProblemQuestion,
  filterMarkersAtLine,
  pickPrimaryMarker,
  MAX_FIX_PROBLEM_CHARS,
} from "../fix-problem";
import type { editor as MonacoEditor } from "monaco-editor";

function marker(
  partial: Partial<MonacoEditor.IMarker> &
    Pick<
      MonacoEditor.IMarker,
      "startLineNumber" | "endLineNumber" | "severity" | "message"
    >,
): MonacoEditor.IMarker {
  return {
    owner: "pssa",
    resource: { toString: () => "inmemory://x.ps1" } as MonacoEditor.IMarker["resource"],
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

describe("fix-problem helpers", () => {
  it("filters markers to the clicked line", () => {
    const markers = [
      marker({ startLineNumber: 2, endLineNumber: 2, severity: 8, message: "a" }),
      marker({ startLineNumber: 5, endLineNumber: 5, severity: 4, message: "b" }),
      marker({ startLineNumber: 2, endLineNumber: 4, severity: 4, message: "span" }),
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
});
