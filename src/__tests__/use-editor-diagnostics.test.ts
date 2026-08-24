import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import hookSource from "../use-editor-diagnostics.ts?raw";

describe("useEditorDiagnostics wiring", () => {
  it("App runs diagnostics at shell level independent of Monaco", () => {
    expect(appSource).toContain("useEditorDiagnostics");
    expect(appSource).toContain("state.settingsLoaded");
  });

  it("hook dispatches SET_PROBLEMS from analyze_script results", () => {
    expect(hookSource).toContain("SET_PROBLEMS");
    expect(hookSource).toContain("analyzeScript");
  });
});
