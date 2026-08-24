import { describe, expect, it, vi } from "vitest";
import {
  formatAppVersionLabel,
  normalizeAppVersion,
} from "../components/AboutDialog";
import { contextMenuStateAfterRefresh } from "../components/SettingsPanel";
import { recoveredScratchTitle } from "../scratch-utils";
import { closeTabIdsSequentially } from "../components/TabBar";
import app from "../App.tsx?raw";
import editorPane from "../components/EditorPane.tsx?raw";
import executionActions from "../use-execution-actions.ts?raw";
import closeScratchDialog from "../components/CloseScratchDialog.tsx?raw";
import keyboardShortcutPanel from "../components/KeyboardShortcutPanel.tsx?raw";
import scratchRecoveryDialog from "../components/ScratchRecoveryDialog.tsx?raw";
import settingsPanel from "../components/SettingsPanel.tsx?raw";
import store from "../store.tsx?raw";
import tabBar from "../components/TabBar.tsx?raw";
import toolbar from "../components/Toolbar.tsx?raw";
import terminalPane from "../components/TerminalPane.tsx?raw";
import executionActionsSource from "../use-execution-actions.ts?raw";
import xtermSetup from "../terminal/xterm-setup.ts?raw";

describe("Integrated terminal stability", () => {
  it("does not enable xterm WebGL (WebView2 blank-webview regression)", () => {
    expect(xtermSetup).toContain("return null");
    expect(xtermSetup).not.toContain("term.loadAddon(webgl)");
  });

  it("reveals the terminal pane and refits when opening a local console tab", () => {
    expect(terminalPane).toContain('dispatch({ type: "SET_BOTTOM_TAB", tab: "terminal" })');
    expect(terminalPane).toContain("term.refresh(0, term.rows - 1)");
  });

  it("applies Windows Terminal scheme and glyph font to consoles", () => {
    expect(terminalPane).toContain("readWindowsTerminalSettings");
    expect(terminalPane).toContain("windowsTerminalSchemeToXtermTheme");
    expect(terminalPane).toContain("resolveConsoleFontFamily");
    expect(xtermSetup).toContain("customGlyphs: true");
  });
});

describe("Script param inspection and run guard", () => {
  it("blocks runs when param inspection fails with status error", () => {
    expect(executionActionsSource).toContain("hasScriptLevelParamBlock");
    expect(executionActionsSource).toContain('inspect.status === "error"');
    expect(executionActionsSource).toContain(
      "Run blocked: the script declares a param() block but PSForge could not read its parameters",
    );
  });
});

describe("System tray window lifecycle", () => {
  it("does not destroy the window while flushing settings on close", () => {
    // Tauri's onCloseRequested wrapper destroys the window (exiting the app
    // and dropping the tray icon) unless the handler calls preventDefault
    // before it returns — and before anything that can throw.
    const closeHandler = store.indexOf("win.onCloseRequested");
    expect(closeHandler).toBeGreaterThan(-1);
    const prevent = store.indexOf("event.preventDefault()", closeHandler);
    const flush = store.indexOf("await flushPendingSettings()", closeHandler);
    expect(prevent).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(prevent);
    expect(store).not.toContain("win.destroy()");
  });

  it("flushes pending settings before honoring the tray exit request", () => {
    const exitListener = store.indexOf('listen("psforge-exit-requested"');
    expect(exitListener).toBeGreaterThan(-1);
    const flush = store.indexOf("await flushPendingSettings()", exitListener);
    const exit = store.indexOf("await exit(0)", exitListener);
    expect(flush).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(flush);
  });

  it("routes File > Exit through the exit flow, not window.close()", () => {
    // Closing the main window only hides it to the tray; Exit must terminate.
    expect(toolbar).toContain('emit("psforge-exit-requested")');
    expect(toolbar).not.toContain("getCurrentWindow().close()");
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

describe("Paste Clean + Format editor bridge (S10-1)", () => {
  it("registers the insert and buffer-read globals the App flow consumes", () => {
    // The feature commit shipped the consumer and the cleanup deletes but
    // never the registrations, so paste-into-tab silently no-oped.
    expect(editorPane).toContain("w.__psforge_insertTextAtSelection = ");
    expect(editorPane).toContain("w.__psforge_getEditorText = ");
    expect(app).toContain("w.__psforge_insertTextAtSelection as");
  });
});

describe("Recent files and project config merge against current settings (S10-2)", () => {
  it("uses reducer-side merges instead of stale settings snapshots", () => {
    expect(store).toContain('case "MERGE_RECENT_FILES"');
    expect(store).toContain('case "APPLY_PROJECT_CONFIG"');
    expect(app).toContain('dispatch({ type: "MERGE_RECENT_FILES", paths: [selected] })');
    // openFile must no longer dispatch a whole settings object for recents.
    expect(app).not.toContain("recentFiles: recent");
  });
});

describe("Paste Clean + Format entry point (S11-1)", () => {
  it("routes toolbar, shortcut, and command palette through one Welcome-tab branch", () => {
    // The palette used to call pasteCleanAndFormat directly, which no-ops on
    // the Welcome tab; all three triggers must share the branching wrapper.
    expect(app).toContain(
      "w.__psforge_pasteCleanAndFormat = pasteScriptFromClipboard",
    );
    expect(app).toContain("onPasteScript={pasteScriptFromClipboard}");
    const shared = app.indexOf("const pasteScriptFromClipboard = useCallback");
    expect(shared).toBeGreaterThan(-1);
    const welcomeBranch = app.indexOf(
      'activeTab.tabType === "welcome"',
      shared,
    );
    const newScriptCall = app.indexOf(
      "void pasteFromClipboardAsNewScript()",
      shared,
    );
    expect(welcomeBranch).toBeGreaterThan(shared);
    expect(newScriptCall).toBeGreaterThan(welcomeBranch);
  });
});

describe("Re-run from recent runs (S10-3/S10-4)", () => {
  it("consumes the one-shot working-dir override before any early return", () => {
    const runScript = executionActions.indexOf("const runScript = useCallback");
    expect(runScript).toBeGreaterThan(-1);
    const consume = executionActions.indexOf(
      "runWorkingDirOverrideRef.current = null",
      runScript,
    );
    const firstGuard = executionActions.indexOf(
      'tab.tabType === "welcome" || current.isRunning) return',
      runScript,
    );
    expect(consume).toBeGreaterThan(runScript);
    expect(firstGuard).toBeGreaterThan(-1);
    expect(consume).toBeLessThan(firstGuard);
  });

  it("aborts the re-run when the recorded script cannot be opened or found", () => {
    expect(app).toContain("if (!(await openFile(run.scriptPath))) return;");
    expect(app).toMatch(/if \(!match\) \{[\s\S]*?return;[\s\S]*?\}\s*dispatch\(\{ type: "SET_ACTIVE_TAB", id: match\.id \}\);/);
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
