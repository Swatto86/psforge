import { describe, expect, it } from "vitest";
import { mergeRecentFilePaths, removeRecentFilePath } from "../script-utils";

describe("mergeRecentFilePaths", () => {
  it("deduplicates Windows paths by case and separator style", () => {
    expect(
      mergeRecentFilePaths(
        ["C:\\Scripts\\Foo.ps1", "D:\\Bar.ps1"],
        ["c:/scripts/foo.ps1"],
        10,
        true,
      ),
    ).toEqual(["c:/scripts/foo.ps1", "D:\\Bar.ps1"]);
  });

  it("keeps case-distinct Unix paths separate", () => {
    expect(
      mergeRecentFilePaths(["/home/me/Foo.ps1"], ["/home/me/foo.ps1"], 10, false),
    ).toEqual(["/home/me/foo.ps1", "/home/me/Foo.ps1"]);
  });

  it("removes all Windows variants of the same recent file", () => {
    expect(
      removeRecentFilePath(
        ["C:\\Scripts\\Foo.ps1", "c:/scripts/foo.ps1", "D:\\Bar.ps1"],
        "C:/SCRIPTS/FOO.ps1",
        true,
      ),
    ).toEqual(["D:\\Bar.ps1"]);
  });

  it("honors a zero max recent cap", () => {
    expect(mergeRecentFilePaths(["old.ps1"], ["new.ps1"], 0, true)).toEqual([]);
    expect(
      mergeRecentFilePaths(["old.ps1"], ["new.ps1"], Number.NaN, true),
    ).toEqual([]);
  });
});
