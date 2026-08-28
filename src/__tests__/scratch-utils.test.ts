import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isScratchBackedTab,
  recoveredScratchTitle,
  scratchPathForTab,
  diskWriteTabChanges,
} from "../scratch-utils";
import type { EditorTab } from "../types";

describe("scratchPathForTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not duplicate an existing trailing separator", () => {
    expect(scratchPathForTab("C:\\Temp\\", "tab-1")).toBe(
      "C:\\Temp\\tab-1.ps1",
    );
    expect(scratchPathForTab("/tmp/psforge/", "tab-1")).toBe(
      "/tmp/psforge/tab-1.ps1",
    );
  });

  it("recognizes scratch-backed tabs when scratch dir has trailing separator", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const tab = {
      filePath: "c:\\TEMP\\tab-1.ps1",
      tabType: "code",
    } as EditorTab;

    expect(isScratchBackedTab(tab, "C:\\Temp\\")).toBe(true);
  });

  it("uses case-sensitive path semantics on Linux and macOS", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const tab = {
      filePath: "/tmp/PSForge/tab-1.ps1",
      tabType: "code",
    } as EditorTab;

    expect(isScratchBackedTab(tab, "/tmp/psforge")).toBe(false);
  });

  it("preserves backslashes as filename characters on Unix", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });

    expect(scratchPathForTab("/tmp/psforge\\archive", "tab-1")).toBe(
      "/tmp/psforge\\archive/tab-1.ps1",
    );
  });

  it("uses Untitled-N for recovered scratch tabs, not the UUID filename", () => {
    expect(recoveredScratchTitle(3)).toBe("Untitled-3");
    expect(recoveredScratchTitle(3)).not.toMatch(/\.ps1$/);
  });
});

describe("diskWriteTabChanges", () => {
  it("clears dirty only when the live buffer still matches what was written", () => {
    expect(diskWriteTabChanges("/tmp/a.ps1", "old", "old")).toEqual({
      filePath: "/tmp/a.ps1",
      savedContent: "old",
      isDirty: false,
    });
    expect(diskWriteTabChanges("/tmp/a.ps1", "old", "newer")).toEqual({
      filePath: "/tmp/a.ps1",
      savedContent: "old",
      isDirty: true,
    });
    expect(diskWriteTabChanges("/tmp/a.ps1", "old", undefined)).toBeNull();
  });
});
