import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import packageLock from "../../package-lock.json";
import cargoToml from "../../src-tauri/Cargo.toml?raw";
import cargoLock from "../../src-tauri/Cargo.lock?raw";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import readme from "../../README.md?raw";

function cargoVersion(text: string): string {
  const match = /^version = "([^"]+)"/m.exec(text);
  if (!match) throw new Error("Cargo.toml package version not found");
  return match[1];
}

function cargoLockVersion(text: string): string {
  const match = /name = "psforge"\r?\nversion = "([^"]+)"/.exec(text);
  if (!match) throw new Error("Cargo.lock psforge version not found");
  return match[1];
}

describe("release metadata", () => {
  it("keeps app versions and README release link in sync", () => {
    const version = packageJson.version;

    expect(packageLock.version).toBe(version);
    expect(packageLock.packages[""].version).toBe(version);
    expect(tauriConfig.version).toBe(version);
    expect(cargoVersion(cargoToml)).toBe(version);
    expect(cargoLockVersion(cargoLock)).toBe(version);
    expect(readme).toContain(`**Current version:** [${version}]`);
    expect(readme).toContain(`/releases/tag/v${version}`);
  });

});
