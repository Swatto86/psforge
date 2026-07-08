import { describe, expect, it } from "vitest";
import { isScratchBackedTab, scratchPathForTab } from "../scratch-utils";
import type { EditorTab } from "../types";

describe("scratchPathForTab", () => {
  it("does not duplicate an existing trailing separator", () => {
    expect(scratchPathForTab("C:\\Temp\\", "tab-1")).toBe(
      "C:\\Temp\\tab-1.ps1",
    );
    expect(scratchPathForTab("/tmp/psforge/", "tab-1")).toBe(
      "/tmp/psforge/tab-1.ps1",
    );
  });

  it("recognizes scratch-backed tabs when scratch dir has trailing separator", () => {
    const tab = {
      filePath: "C:\\Temp\\tab-1.ps1",
      tabType: "code",
    } as EditorTab;

    expect(isScratchBackedTab(tab, "C:\\Temp\\")).toBe(true);
  });
});
