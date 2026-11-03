import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const capability = JSON.parse(
  readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as { permissions: Array<string | { identifier?: string; allow?: unknown }> };

describe("main window filesystem capability", () => {
  it("does not grant recursive read access to every directory", () => {
    const broadReadDir = capability.permissions.some(
      (permission) =>
        typeof permission !== "string" &&
        permission.identifier === "fs:allow-read-dir" &&
        JSON.stringify(permission.allow).includes("**"),
    );

    expect(broadReadDir).toBe(false);
  });
});
