import { describe, expect, it } from "vitest";
import { applyAssistantMode, isAssistantModeEnabled } from "../assistant-mode";
import { DEFAULT_SETTINGS } from "../types";

describe("assistant mode", () => {
  it("applies paste-and-run defaults", () => {
    const next = applyAssistantMode({
      ...DEFAULT_SETTINGS,
      runAfterSanitizedPaste: true,
      splitPosition: 50,
    });
    expect(next.assistantMode).toBe(true);
    expect(next.runAfterPasteCleanFormat).toBe(true);
    expect(next.runAfterSanitizedPaste).toBe(false);
    expect(next.splitPosition).toBe(28);
    expect(isAssistantModeEnabled(next)).toBe(true);
  });
});
