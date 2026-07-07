import { describe, expect, it } from "vitest";
import { basename, dirname, joinPath } from "../path-utils";

describe("dirname", () => {
  it("returns the parent directory of a nested path", () => {
    expect(dirname("C:\\Scripts\\sub\\foo.ps1")).toBe("C:\\Scripts\\sub");
    expect(dirname("/home/me/foo.ps1")).toBe("/home/me");
  });

  it("keeps the Unix root separator", () => {
    expect(dirname("/foo.ps1")).toBe("/");
  });

  it("keeps the Windows drive-root separator (S3-7)", () => {
    // Must be "C:\\", not "C:" (a drive-relative reference to the remembered
    // cwd on that drive).
    expect(dirname("C:\\script.ps1")).toBe("C:\\");
    expect(dirname("D:\\run.ps1")).toBe("D:\\");
  });

  it("returns empty when there is no separator", () => {
    expect(dirname("foo.ps1")).toBe("");
  });
});

describe("basename", () => {
  it("returns the trailing component for both separator styles", () => {
    expect(basename("C:\\Scripts\\foo.ps1")).toBe("foo.ps1");
    expect(basename("/home/me/foo.ps1")).toBe("foo.ps1");
    expect(basename("foo.ps1")).toBe("foo.ps1");
  });
});

describe("joinPath", () => {
  it("uses the dominant separator and trims trailing separators", () => {
    expect(joinPath("C:\\Scripts", "foo.ps1")).toBe("C:\\Scripts\\foo.ps1");
    expect(joinPath("C:\\Scripts\\", "foo.ps1")).toBe("C:\\Scripts\\foo.ps1");
    expect(joinPath("/home/me", "foo.ps1")).toBe("/home/me/foo.ps1");
  });
});
