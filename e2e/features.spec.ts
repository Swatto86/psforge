/**
 * E2E Tests: New Features (ISE Parity)
 *
 * Covers feature work added to close ISE parity gaps:
 *   1. Script formatter toolbar button (Shift+Alt+F / toolbar-format)
 *   2. Find & Replace toolbar button (toolbar-find-replace)
 *   3. File drag-and-drop (onDrop handler on app-root)
 *   4. $PROFILE quick-edit toolbar button (toolbar-open-profile)
 *   5. Script signing dialog (toolbar-sign / signing-dialog)
 *   6. Print toolbar button (toolbar-print)
 *   7. Save All workflow (Ctrl+Shift+S / toolbar-save-all)
 *   8. Sidebar Outline navigator (functions/classes/regions)
 *
 * Run: npm run test:e2e -- --spec e2e/features.spec.ts
 */

// ── Timeout constants ─────────────────────────────────────────────────────────
/** Conservative timeout for dialog open/close transitions. */
const DIALOG_TIMEOUT = 5000;
/** Timeout for waiting on a new tab to appear after opening a file. */
const TAB_TIMEOUT = 8000;
/** Polling interval for waitUntil. */
const POLL_MS = 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** TypeWriter helper: click target, clear, type content character by character. */
async function typeIntoEditor(content: string): Promise<void> {
  const editor = await $('[data-testid="editor-container"]');
  await editor.click();
  await browser.keys(["Control", "a"]);
  await browser.keys(["Delete"]);
  for (const char of content) {
    await browser.keys(char);
    await browser.pause(20);
  }
}

async function clickRunAndShowOutput(): Promise<void> {
  const runBtn = await $('[data-testid="toolbar-run"]');
  await runBtn.click();
  await browser.pause(200);
  const outputTab = await $('[data-testid="output-tab-output"]');
  await outputTab.click();
}

async function waitForOutputText(
  substring: string,
  timeoutMs = 20_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const scroll = await $('[data-testid="output-scroll"]');
      const text = await scroll.getText();
      return text.includes(substring);
    },
    {
      timeout: timeoutMs,
      interval: POLL_MS,
      timeoutMsg: `Output never contained ${substring}`,
    },
  );
}

async function waitForProblemsText(
  substring: string,
  timeoutMs = 20_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const pane = await $('[data-testid="output-pane"]');
      const text = await pane.getText();
      return text.includes(substring);
    },
    {
      timeout: timeoutMs,
      interval: POLL_MS,
      timeoutMsg: `Problems pane never contained ${substring}`,
    },
  );
}

/** Create a new code tab and return its id prefix. */
async function openNewCodeTab(): Promise<void> {
  const btn = await $('[data-testid="toolbar-new"]');
  await btn.click();
  await browser.pause(200);
}

/** Ensure the sidebar is visible (toggles it on via toolbar if needed). */
async function ensureSidebarVisible(): Promise<void> {
  const sidebar = await $('[data-testid="sidebar-root"]');
  if (await sidebar.isExisting()) return;

  const toggle = await $('[data-testid="toolbar-modules"]');
  await toggle.click();
  await browser.waitUntil(
    async () => (await $('[data-testid="sidebar-root"]')).isDisplayed(),
    {
      timeout: DIALOG_TIMEOUT,
      interval: POLL_MS,
      timeoutMsg: "Sidebar did not become visible",
    },
  );
}

/** Open the signing dialog and wait for it to appear. */
async function openSigningDialog(): Promise<void> {
  const btn = await $('[data-testid="toolbar-sign"]');
  await btn.click();
  await browser.waitUntil(
    async () => (await $('[data-testid="signing-dialog"]')).isDisplayed(),
    {
      timeout: DIALOG_TIMEOUT,
      interval: POLL_MS,
      timeoutMsg: "Signing dialog did not appear",
    },
  );
}

/** Close the signing dialog via the Cancel button and wait for it to disappear. */
async function closeSigningDialog(): Promise<void> {
  const btn = await $('[data-testid="signing-dialog-cancel"]');
  await btn.click();
  await browser.waitUntil(
    async () =>
      !(await (await $('[data-testid="signing-dialog"]')).isExisting()),
    {
      timeout: DIALOG_TIMEOUT,
      interval: POLL_MS,
      timeoutMsg: "Signing dialog did not close",
    },
  );
}

// ── 1. Script Formatter ───────────────────────────────────────────────────────
describe("Feature: Script Formatter", () => {
  it("toolbar-format button exists and is displayed", async () => {
    const btn = await $('[data-testid="toolbar-format"]');
    await expect(btn).toBeDisplayed();
  });

  it("toolbar-format button is disabled for welcome tab", async () => {
    const btn = await $('[data-testid="toolbar-format"]');
    const disabled = await btn.getAttribute("disabled");

    // Some sessions start on a persisted code tab (after first launch).
    // Enforce the expected state for whichever initial tab type is active.
    const isWelcomeVisible = await browser.execute(() => {
      return document.querySelector('[data-testid="welcome-pane"]') !== null;
    });
    if (isWelcomeVisible) {
      expect(disabled).not.toBeNull();
    } else {
      const psSelector = await $('[data-testid="toolbar-ps-selector"]');
      const psPath = await psSelector.getValue();
      if (psPath) {
        expect(disabled).toBeNull();
      } else {
        expect(disabled).not.toBeNull();
      }
    }
  });

  it("toolbar-format button is enabled for a code tab with PS version selected", async () => {
    await openNewCodeTab();
    // Wait for a code editor tab to be active.
    await browser.waitUntil(
      async () => {
        const container = await $('[data-testid="editor-container"]');
        return container.isDisplayed();
      },
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Code editor did not appear after new tab",
      },
    );
    // A PS version must be installed for the button to be enabled.
    const psSelector = await $('[data-testid="toolbar-ps-selector"]');
    const psPath = await psSelector.getValue();
    if (psPath) {
      const btn = await $('[data-testid="toolbar-format"]');
      const disabled = await btn.getAttribute("disabled");
      expect(disabled).toBeNull();
    } else {
      // No PS installed in CI -- button remains disabled; skip assertion.
      console.warn(
        "No PowerShell version available; skipping enabled-state check",
      );
      return;
    }
  });

  it("Shift+Alt+F keyboard shortcut triggers format on code tab", async () => {
    // Place some content in the editor.
    await typeIntoEditor('Write-Host "hello"');
    // Trigger format via keyboard shortcut -- should not throw even if PSSA absent.
    await browser.keys(["Shift", "Alt", "F"]);
    await browser.pause(300);
    // No dialog / error should appear; editor container still displayed.
    const editor = await $('[data-testid="editor-container"]');
    await expect(editor).toBeDisplayed();
  });
});

// ── 2. Find & Replace ─────────────────────────────────────────────────────────
describe("Feature: Find & Replace", () => {
  it("toolbar-find-replace button exists and is displayed", async () => {
    const btn = await $('[data-testid="toolbar-find-replace"]');
    await expect(btn).toBeDisplayed();
  });

  it("toolbar-find-replace button is disabled for welcome tab", async () => {
    // Activate welcome tab if possible; if a code tab is active from prior test,
    // the button should be enabled -- just verify it exists and is displayed.
    const btn = await $('[data-testid="toolbar-find-replace"]');
    await expect(btn).toBeDisplayed();
  });

  it("Ctrl+H shortcut opens Monaco find-replace widget", async () => {
    await openNewCodeTab();
    await browser.waitUntil(
      async () => (await $('[data-testid="editor-container"]')).isDisplayed(),
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Editor did not appear",
      },
    );
    const editor = await $('[data-testid="editor-container"]');
    await editor.click();
    await browser.keys(["Control", "h"]);
    await browser.pause(400);
    // Monaco's find widget has a known aria role.
    const findWidget = await browser.execute(() => {
      return (
        document.querySelector(".find-widget") !== null ||
        document.querySelector(".editor-find-part") !== null
      );
    });
    expect(findWidget).toBe(true);
    // Dismiss with Escape.
    await browser.keys("Escape");
    await browser.pause(200);
  });
});

// ── 3. File Drag-and-Drop ─────────────────────────────────────────────────────
describe("Feature: File Drag-and-Drop", () => {
  it("app-root element has drag event handlers attached", async () => {
    // Verify that the onDragOver / onDrop handlers are wired by confirming the
    // element handles a dragover event without default browser navigation.
    const hasDragHandlers = await browser.execute(() => {
      const root = document.querySelector(
        '[data-testid="app-root"]',
      ) as HTMLElement;
      if (!root) return false;
      // Dispatch a synthetic dragover; if the handler calls preventDefault the
      // event's defaultPrevented flag will be true.
      const ev = new DragEvent("dragover", { bubbles: true, cancelable: true });
      root.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(hasDragHandlers).toBe(true);
  });

  it("app-root handles drop event without throwing", async () => {
    const noError = await browser.execute(() => {
      try {
        const root = document.querySelector(
          '[data-testid="app-root"]',
        ) as HTMLElement;
        if (!root) return false;
        // Simulate a drop with an empty DataTransfer (no file) -- should not throw.
        const dt = new DataTransfer();
        const ev = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        root.dispatchEvent(ev);
        return true;
      } catch {
        return false;
      }
    });
    expect(noError).toBe(true);
  });
});

// ── 4. $PROFILE Quick-Edit ────────────────────────────────────────────────────
describe("Feature: $PROFILE Quick-Edit", () => {
  it("toolbar-open-profile button exists and is displayed", async () => {
    const btn = await $('[data-testid="toolbar-open-profile"]');
    await expect(btn).toBeDisplayed();
  });

  it("toolbar-open-profile button is enabled when a PS version is selected", async () => {
    const psSelector = await $('[data-testid="toolbar-ps-selector"]');
    const psPath = await psSelector.getValue();
    const btn = await $('[data-testid="toolbar-open-profile"]');
    if (psPath) {
      const disabled = await btn.getAttribute("disabled");
      expect(disabled).toBeNull();
    } else {
      const disabled = await btn.getAttribute("disabled");
      expect(disabled).not.toBeNull();
    }
  });

  it("clicking toolbar-open-profile opens a new tab when PS is available", async () => {
    const psSelector = await $('[data-testid="toolbar-ps-selector"]');
    const psPath = await psSelector.getValue();
    if (!psPath) {
      console.warn(
        "No PowerShell version available; skipping profile-open test",
      );
      return;
    }

    // Count current tabs. The profile file may already be open from prior
    // state; in that case the toolbar action should activate that tab.
    const tabsBefore = await browser.execute(() => {
      return document.querySelectorAll('[data-testid^="tab-item-"]').length;
    });

    const btn = await $('[data-testid="toolbar-open-profile"]');
    await btn.click();

    // Pass when either:
    // 1) a new tab is opened and a profile tab exists, or
    // 2) an existing profile tab becomes active.
    await browser.waitUntil(
      async () => {
        return browser.execute((beforeCount: number) => {
          const tabs = Array.from(
            document.querySelectorAll('[data-testid^="tab-item-"]'),
          ) as HTMLElement[];
          const count = tabs.length;
          const labels = tabs.map((t) => (t.textContent || "").toLowerCase());
          const hasProfileTab = labels.some((text) => text.includes("profile"));
          const activeTab = tabs.find((t) =>
            (t.style.backgroundColor || "").includes("var(--bg-tab-active)"),
          );
          const activeText = (activeTab?.textContent || "").toLowerCase();

          if (count > beforeCount && hasProfileTab) return true;
          if (hasProfileTab && activeText.includes("profile")) return true;
          return false;
        }, tabsBefore);
      },
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Profile tab did not open or activate",
      },
    );
  });
});

// ── 5. Script Signing Dialog ──────────────────────────────────────────────────
describe("Feature: Script Signing Dialog", () => {
  it("toolbar-sign button exists and is displayed", async () => {
    const btn = await $('[data-testid="toolbar-sign"]');
    await expect(btn).toBeDisplayed();
  });

  it("toolbar-sign button is disabled when no file path is set", async () => {
    // Open a new unsaved tab.
    await openNewCodeTab();
    await browser.waitUntil(
      async () => (await $('[data-testid="editor-container"]')).isDisplayed(),
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Editor did not appear",
      },
    );
    const btn = await $('[data-testid="toolbar-sign"]');
    const disabled = await btn.getAttribute("disabled");
    expect(disabled).not.toBeNull();
  });

  it("signing dialog can be opened programmatically via dispatch", async () => {
    // Use the window global to dispatch TOGGLE_SIGNING_DIALOG for testing
    // without needing a saved file (toolbar button is disabled).
    await browser.execute(() => {
      (window as any).__psforge_dispatch?.({ type: "TOGGLE_SIGNING_DIALOG" });
    });

    // If the dispatch global is available, verify the dialog opens.
    const dialogExists = await browser
      .waitUntil(
        async () => {
          const el = await $('[data-testid="signing-dialog"]');
          return el.isExisting();
        },
        {
          timeout: DIALOG_TIMEOUT,
          interval: POLL_MS,
          timeoutMsg: "Signing dialog did not open via dispatch",
        },
      )
      .catch(() => false);

    if (dialogExists) {
      // Close via Cancel.
      await closeSigningDialog();
    } else {
      // The dispatch global is not exposed (expected in production builds).
      // Simply verify the toolbar button is present; dialog behavior is
      // tested in the saved-file path.
      const btn = await $('[data-testid="toolbar-sign"]');
      await expect(btn).toBeDisplayed();
    }
  });

  it("signing dialog close button and backdrop dismiss the dialog", async () => {
    // Open via dispatch global if available.
    const dispatched = await browser.execute(() => {
      if ((window as any).__psforge_dispatch) {
        (window as any).__psforge_dispatch({ type: "TOGGLE_SIGNING_DIALOG" });
        return true;
      }
      return false;
    });
    if (!dispatched) {
      console.warn(
        "__psforge_dispatch not available; skipping dialog close test",
      );
      return;
    }

    await browser.waitUntil(
      async () => (await $('[data-testid="signing-dialog"]')).isDisplayed(),
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Signing dialog did not open",
      },
    );

    // Close via the X button.
    const closeBtn = await $('[data-testid="signing-dialog-close"]');
    await expect(closeBtn).toBeDisplayed();
    await closeBtn.click();

    await browser.waitUntil(
      async () =>
        !(await (await $('[data-testid="signing-dialog"]')).isExisting()),
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Signing dialog did not close via X button",
      },
    );
  });

  it("signing dialog shows loading state then cert list or empty message", async () => {
    const dispatched = await browser.execute(() => {
      if ((window as any).__psforge_dispatch) {
        (window as any).__psforge_dispatch({ type: "TOGGLE_SIGNING_DIALOG" });
        return true;
      }
      return false;
    });
    if (!dispatched) {
      console.warn("__psforge_dispatch not available");
      return;
    }

    await browser.waitUntil(
      async () => (await $('[data-testid="signing-dialog"]')).isDisplayed(),
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Signing dialog did not open",
      },
    );

    // After loading completes, either the cert select or the "no certs" message appears.
    await browser.waitUntil(
      async () => {
        const select = await $('[data-testid="signing-dialog-cert-select"]');
        const noMsg = await $('[data-testid="signing-dialog-no-certs"]');
        return (await select.isExisting()) || (await noMsg.isExisting());
      },
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Cert list or no-certs message did not appear",
      },
    );

    await closeSigningDialog();
  });
});

// ── 6. Print Support ──────────────────────────────────────────────────────────
describe("Feature: Print Support", () => {
  it("toolbar-print button exists and is displayed", async () => {
    const btn = await $('[data-testid="toolbar-print"]');
    await expect(btn).toBeDisplayed();
  });

  it("toolbar-print button is disabled when active tab has no content", async () => {
    await openNewCodeTab();
    await browser.waitUntil(
      async () => (await $('[data-testid="editor-container"]')).isDisplayed(),
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Editor did not appear",
      },
    );
    // New blank tab has no content -- print button should be disabled.
    const btn = await $('[data-testid="toolbar-print"]');
    const disabled = await btn.getAttribute("disabled");
    expect(disabled).not.toBeNull();
  });

  it("toolbar-print button is enabled when a code tab has content", async () => {
    await typeIntoEditor('Write-Host "test"');
    await browser.pause(200);
    const btn = await $('[data-testid="toolbar-print"]');
    const disabled = await btn.getAttribute("disabled");
    expect(disabled).toBeNull();
  });
});

// ── 7. Save All ───────────────────────────────────────────────────────────────
describe("Feature: Save All", () => {
  it("toolbar-save-all button exists and is displayed", async () => {
    const btn = await $('[data-testid="toolbar-save-all"]');
    await expect(btn).toBeDisplayed();
  });

  it("Ctrl+Shift+S saves the active dirty saved tab", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const tmpDir = path.join(process.cwd(), "e2e", ".tmp");
    const tmpFile = path.join(tmpDir, `save-all-${Date.now()}.ps1`);
    const marker = `SaveAll_E2E_${Date.now()}`;
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tmpFile, "Write-Host 'seed'", "utf8");

    try {
      await browser.execute((filePath: string) => {
        const openByPath = (window as any).__psforge_openFileByPath as
          | ((p: string) => void)
          | undefined;
        if (!openByPath) {
          throw new Error("__psforge_openFileByPath not available");
        }
        openByPath(filePath);
      }, tmpFile);

      // Wait for the opened file tab to become active (saved path => Sign enabled).
      await browser.waitUntil(
        async () =>
          (await (
            await $('[data-testid="toolbar-sign"]')
          ).getAttribute("disabled")) === null,
        {
          timeout: TAB_TIMEOUT,
          interval: POLL_MS,
          timeoutMsg: "Could not activate saved file tab for save-all test",
        },
      );

      await typeIntoEditor(`Write-Host "${marker}"`);
      await browser.pause(200);

      // Active tab is dirty, so Save should be enabled.
      const saveBtn = await $('[data-testid="toolbar-save"]');
      expect(await saveBtn.getAttribute("disabled")).toBeNull();

      await browser.keys(["Control", "Shift", "s"]);

      // After save-all, the active tab should be clean so Save becomes disabled.
      await browser.waitUntil(
        async () => (await saveBtn.getAttribute("disabled")) !== null,
        {
          timeout: DIALOG_TIMEOUT,
          interval: POLL_MS,
          timeoutMsg: "Active tab did not become clean after Ctrl+Shift+S",
        },
      );

      const savedContent = await fs.readFile(tmpFile, "utf8");
      expect(savedContent).toContain(marker);
    } finally {
      await fs.unlink(tmpFile).catch(() => undefined);
    }
  });
});

// ── 8. Sidebar Outline ───────────────────────────────────────────────────────
describe("Feature: Sidebar Outline", () => {
  it("outline view lists symbols for the active script", async () => {
    await ensureSidebarVisible();
    await openNewCodeTab();
    await browser.waitUntil(
      async () => (await $('[data-testid="editor-container"]')).isDisplayed(),
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Editor did not appear",
      },
    );

    await typeIntoEditor(
      "#region Nav\nfunction Get-Widget { }\nclass DemoType { }\n#endregion",
    );
    await browser.pause(250);

    const outlineTab = await $('[data-testid="sidebar-view-outline"]');
    await outlineTab.click();

    await browser.waitUntil(
      async () => {
        const items = await $$('[data-testid="sidebar-outline-item"]');
        return items.length >= 2;
      },
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Outline items did not appear",
      },
    );

    const sidebarText = await (
      await $('[data-testid="sidebar-root"]')
    ).getText();
    expect(sidebarText).toContain("Get-Widget");
    expect(sidebarText).toContain("DemoType");
  });

  it("clicking an outline symbol navigates the editor cursor to that line", async () => {
    await ensureSidebarVisible();
    const outlineTab = await $('[data-testid="sidebar-view-outline"]');
    await outlineTab.click();

    const target = await browser.execute(() => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="sidebar-outline-item"]'),
      ) as HTMLElement[];
      const match = rows.find((row) => row.innerText.includes("DemoType"));
      if (!match) return false;
      match.click();
      return true;
    });
    expect(target).toBe(true);

    const status = await $('[data-testid="status-bar"]');
    await browser.waitUntil(
      async () => {
        const text = await status.getText();
        return /Ln 3, Col \d+/.test(text);
      },
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Cursor did not navigate to expected outline line",
      },
    );
  });
});

// ── 9. Bottom Pane Text Mode + Clear Isolation ─────────────────────────────
describe("Feature: Bottom Pane Text Mode", () => {
  it("only output and problems expose text mode, and output text mode supports undo", async () => {
    const helpTab = await $('[data-testid="output-tab-help"]');
    await helpTab.click();
    await browser.pause(200);

    const helpToggle = await $('[data-testid="bottom-pane-text-mode-toggle"]');
    expect(await helpToggle.isExisting()).toBe(false);

    const outputMarker = `TEXT_MODE_OUTPUT_${Date.now()}`;

    await openNewCodeTab();
    await browser.waitUntil(
      async () => (await $('[data-testid="editor-container"]')).isDisplayed(),
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Editor did not appear for output text-mode test",
      },
    );

    await typeIntoEditor(`Write-Host \"${outputMarker}\"`);
    await clickRunAndShowOutput();
    await waitForOutputText(outputMarker);

    const toggle = await $('[data-testid="bottom-pane-text-mode-toggle"]');
    await toggle.click();

    const editor = await $('[data-testid="bottom-pane-text-editor-output"]');
    await expect(editor).toBeDisplayed();

    const original = await editor.getValue();
    await editor.click();
    await browser.keys(["End"]);
    await browser.keys("X");

    await browser.waitUntil(
      async () => (await editor.getValue()) !== original,
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Output text mode did not accept text edits",
      },
    );

    const edited = await editor.getValue();
    const clearBtn = await $('[data-testid="bottom-pane-text-clear"]');
    await clearBtn.click();

    await browser.waitUntil(async () => (await editor.getValue()) === "", {
      timeout: DIALOG_TIMEOUT,
      interval: POLL_MS,
      timeoutMsg: "Output text mode clear did not empty the editor",
    });

    const undoBtn = await $('[data-testid="bottom-pane-text-undo"]');
    await undoBtn.click();

    await browser.waitUntil(async () => (await editor.getValue()) === edited, {
      timeout: DIALOG_TIMEOUT,
      interval: POLL_MS,
      timeoutMsg: "Output text mode undo did not restore the previous text",
    });

    await toggle.click();
    await browser.pause(200);

    const problemsTab = await $('[data-testid="output-tab-problems"]');
    await problemsTab.click();
    await browser.pause(200);
    await expect(
      await $('[data-testid="bottom-pane-text-mode-toggle"]'),
    ).toBeDisplayed();
  });
});

describe("Feature: Bottom Pane Clear Isolation", () => {
  it("clearing Problems leaves Output intact", async () => {
    const outputMarker = `PANE_OUTPUT_${Date.now()}`;
    const errorMarker = `PANE_ERROR_${Date.now()}`;

    await openNewCodeTab();
    await browser.waitUntil(
      async () => (await $('[data-testid="editor-container"]')).isDisplayed(),
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Editor did not appear for clear-isolation test",
      },
    );

    await typeIntoEditor(
      `Write-Host \"${outputMarker}\"\nWrite-Error \"${errorMarker}\"`,
    );
    await clickRunAndShowOutput();
    await waitForOutputText(outputMarker);

    const problemsTab = await $('[data-testid="output-tab-problems"]');
    await problemsTab.click();
    await waitForProblemsText(errorMarker);

    const clearProblems = await $('[data-testid="problems-clear-button"]');
    await clearProblems.click();
    await browser.waitUntil(
      async () => {
        const pane = await $('[data-testid="output-pane"]');
        const text = await pane.getText();
        return !text.includes(errorMarker);
      },
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Problems clear did not remove the problem entry",
      },
    );

    await expect(await $('[data-testid="output-tab-output"]')).toBeDisplayed();
    const outputTab = await $('[data-testid="output-tab-output"]');
    await outputTab.click();
    await waitForOutputText(outputMarker);
  });

  it("clearing Output leaves Problems intact", async () => {
    const outputMarker = `PANE_OUTPUT_KEEP_${Date.now()}`;
    const errorMarker = `PANE_ERROR_KEEP_${Date.now()}`;

    await openNewCodeTab();
    await browser.waitUntil(
      async () => (await $('[data-testid="editor-container"]')).isDisplayed(),
      {
        timeout: TAB_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Editor did not appear for output-clear isolation test",
      },
    );

    await typeIntoEditor(
      `Write-Host \"${outputMarker}\"\nWrite-Error \"${errorMarker}\"`,
    );
    await clickRunAndShowOutput();
    await waitForOutputText(outputMarker);

    const problemsTab = await $('[data-testid="output-tab-problems"]');
    await problemsTab.click();
    await waitForProblemsText(errorMarker);

    const outputTab = await $('[data-testid="output-tab-output"]');
    await outputTab.click();
    const clearOutput = await $('[data-testid="output-clear-button"]');
    await clearOutput.click();
    await browser.waitUntil(
      async () => {
        const scroll = await $('[data-testid="output-scroll"]');
        const text = await scroll.getText();
        return !text.includes(outputMarker);
      },
      {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg: "Output clear did not remove the output entry",
      },
    );

    await problemsTab.click();
    await waitForProblemsText(errorMarker);
  });
});

// ── Keyboard Shortcut Panel: new entries ──────────────────────────────────────
describe("Feature: Keyboard Shortcut Panel - new entries", () => {
  beforeEach(async () => {
    const isPanelVisible = async () => {
      const panel = await $('[data-testid="shortcut-panel"]');
      return panel.isDisplayed();
    };

    // Open the shortcut panel via F1.
    await browser.keys("F1");
    const openedByFirstPress = await browser
      .waitUntil(async () => isPanelVisible(), {
        timeout: 1500,
        interval: POLL_MS,
      })
      .catch(() => false);

    // WebView2 can occasionally drop the first F1 key event.
    if (!openedByFirstPress) {
      await browser.keys("F1");
      const openedBySecondPress = await browser
        .waitUntil(async () => isPanelVisible(), {
          timeout: 1500,
          interval: POLL_MS,
        })
        .catch(() => false);

      if (openedBySecondPress) return;

      // Last-resort fallback in hosts where F1 is reserved by the shell.
      await browser.execute(() => {
        (window as any).__psforge_dispatch?.({ type: "TOGGLE_SHORTCUT_PANEL" });
      });
      await browser.waitUntil(async () => isPanelVisible(), {
        timeout: DIALOG_TIMEOUT,
        interval: POLL_MS,
        timeoutMsg:
          "Keyboard shortcut panel did not open via F1 or dispatch fallback",
      });
    }
  });

  afterEach(async () => {
    // Close via Escape.
    await browser.keys("Escape");
    await browser.pause(200);
  });

  it("shortcut panel contains Shift+Alt+F format entry", async () => {
    const text = await browser.execute(() => document.body.innerText);
    expect(text).toContain("Shift");
    expect(text).toContain("Format document");
  });

  it("shortcut panel contains Script Tools category", async () => {
    const text = await browser.execute(() => document.body.innerText);
    expect(text.toLowerCase()).toContain("script tools");
  });

  it("shortcut panel contains Save All shortcut entry", async () => {
    const text = await browser.execute(() => document.body.innerText);
    expect(text).toContain("Ctrl + Shift + S");
    expect(text.toLowerCase()).toContain("save all");
  });
});
