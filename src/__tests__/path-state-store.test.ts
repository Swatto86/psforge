import { afterEach, describe, expect, it, vi } from "vitest";
import { pathKey } from "../path-state-store";

describe("pathKey (S3-24)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes separators and case to one key on Windows", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    // The same file surfaces with both separator styles (native open uses "\",
    // Open Folder forward-slashes) — both must hash to one key.
    expect(pathKey("C:\\Scripts\\Foo.ps1")).toBe(pathKey("C:/Scripts/Foo.ps1"));
    expect(pathKey("C:\\Scripts\\Foo.ps1")).toBe("c:/scripts/foo.ps1");
  });

  it("leaves paths untouched off Windows (backslash is a valid filename char)", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    expect(pathKey("/home/Me/Foo.ps1")).toBe("/home/Me/Foo.ps1");
  });
});
