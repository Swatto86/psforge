import { describe, expect, it } from "vitest";
import {
  buildExplainQuestion,
  fenceFor,
  setExplainHandoff,
  takeExplainHandoff,
  MAX_EXPLAIN_SELECTION_CHARS,
} from "../explain-selection";

describe("fenceFor", () => {
  it("uses a triple-backtick fence for plain code", () => {
    expect(fenceFor("Get-Process")).toBe("```");
  });

  it("outgrows backtick runs inside the snippet", () => {
    expect(fenceFor("a ```powershell block")).toBe("````");
    expect(fenceFor("`" + "`".repeat(4))).toBe("``````");
  });
});

describe("buildExplainQuestion", () => {
  it("embeds the snippet with its line range", () => {
    const { question, truncated } = buildExplainQuestion(
      "Get-ChildItem -Recurse",
      3,
      7,
    );
    expect(truncated).toBe(false);
    expect(question).toContain("lines 3-7");
    expect(question).toContain("```powershell\nGet-ChildItem -Recurse\n```");
  });

  it("labels a single-line selection as one line", () => {
    expect(buildExplainQuestion("$x = 1", 5, 5).question).toContain("(line 5)");
  });

  it("caps oversized selections and flags the truncation", () => {
    const big = "x".repeat(MAX_EXPLAIN_SELECTION_CHARS + 500);
    const { question, truncated } = buildExplainQuestion(big, 1, 400);
    expect(truncated).toBe(true);
    expect(question).toContain(", truncated");
    expect(question.length).toBeLessThan(MAX_EXPLAIN_SELECTION_CHARS + 600);
  });
});

describe("explain handoff", () => {
  it("is taken exactly once", () => {
    const handoff = { question: "q", answer: "a", meta: "m" };
    setExplainHandoff(handoff);
    expect(takeExplainHandoff()).toEqual(handoff);
    expect(takeExplainHandoff()).toBeNull();
  });
});
