import { describe, expect, it } from "vitest";
import {
  formatAppVersionLabel,
  normalizeAppVersion,
} from "../components/AboutDialog";
import { contextMenuStateAfterRefresh } from "../components/SettingsPanel";

describe("About dialog version display", () => {
  it("does not fall back to a stale hard-coded version", () => {
    expect(normalizeAppVersion(" 1.3.5 ")).toBe("1.3.5");
    expect(normalizeAppVersion("")).toBe("unknown");
    expect(normalizeAppVersion(null)).toBe("unknown");
    expect(formatAppVersionLabel("1.3.5")).toBe("v1.3.5");
    expect(formatAppVersionLabel("unknown")).toBe("Version unknown");
  });
});

describe("Settings file-association state", () => {
  it("keeps the previous context-menu state when refresh fails", () => {
    expect(contextMenuStateAfterRefresh(false, null)).toBe(false);
    expect(contextMenuStateAfterRefresh(true, undefined)).toBe(true);
  });

  it("uses the refreshed context-menu state when available", () => {
    expect(contextMenuStateAfterRefresh(false, true)).toBe(true);
    expect(contextMenuStateAfterRefresh(true, false)).toBe(false);
  });
});
