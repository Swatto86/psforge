import { describe, expect, it, vi } from "vitest";
import {
  formatAppVersionLabel,
  normalizeAppVersion,
} from "../components/AboutDialog";
import { contextMenuStateAfterRefresh } from "../components/SettingsPanel";
import { recoveredScratchTitle } from "../scratch-utils";
import { closeTabIdsSequentially } from "../components/TabBar";
import app from "../App.tsx?raw";
import closeScratchDialog from "../components/CloseScratchDialog.tsx?raw";
import keyboardShortcutPanel from "../components/KeyboardShortcutPanel.tsx?raw";
import scratchRecoveryDialog from "../components/ScratchRecoveryDialog.tsx?raw";
import settingsPanel from "../components/SettingsPanel.tsx?raw";
import store from "../store.tsx?raw";
import tabBar from "../components/TabBar.tsx?raw";

describe("System tray window lifecycle", () => {
  it("does not destroy the window while flushing settings on close", () => {
    expect(store).toContain("win.onCloseRequested");
    expect(store).not.toContain("win.destroy()");
  });
});

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

describe("Scratch recovery display", () => {
  it("never labels recovered scratch tabs with the UUID filename", () => {
    const title = recoveredScratchTitle(7);
    expect(title).toBe("Untitled-7");
    expect(title).not.toContain("tab-");
    expect(title).not.toMatch(/\.ps1$/i);
  });
});

describe("Batch tab closing", () => {
  it("routes every tab through the close workflow, including the last tab", async () => {
    const requestClose = vi.fn(async () => true);

    await expect(
      closeTabIdsSequentially(["one", "two"], requestClose, true),
    ).resolves.toBe(true);
    expect(requestClose.mock.calls).toEqual([
      ["one", true],
      ["two", true],
    ]);
  });

  it("stops the batch when the user cancels a close", async () => {
    const requestClose = vi
      .fn<(tabId: string, allowCloseLast?: boolean) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      closeTabIdsSequentially(["one", "two", "three"], requestClose),
    ).resolves.toBe(false);
    expect(requestClose.mock.calls).toEqual([
      ["one", false],
      ["two", false],
    ]);
  });

  it("keeps scratch auto-save pending when Save As is cancelled", () => {
    expect(app).toMatch(
      /if \(choice === "save-as"\)[\s\S]*?if \(!result\.saved\) return false;[\s\S]*?const pendingTimer/,
    );
  });
});

describe("Dialog and icon-button accessibility", () => {
  it("gives modal dialogs accessible names", () => {
    expect(settingsPanel).toContain('aria-labelledby="settings-dialog-title"');
    expect(scratchRecoveryDialog).toContain(
      'aria-labelledby="scratch-recovery-title"',
    );
    expect(closeScratchDialog).toContain(
      'aria-labelledby="close-scratch-title"',
    );
  });

  it("gives close icon buttons descriptive labels", () => {
    expect(tabBar).toContain("aria-label={`Close ${displayLabel}`}");
    expect(keyboardShortcutPanel).toContain(
      'aria-label="Close keyboard shortcut reference"',
    );
  });
});
