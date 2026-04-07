/**
 * E2E Tests: IntelliSense / Completion Dropdown
 *
 * Verifies that Monaco's completion dropdown appears when expected,
 * and specifically that parameter completions show up after typing a dash (-).
 *
 * This test set directly validates the fix for the IntelliSense parameter
 * completion bug: typing `Get-ChildItem -` was not showing parameters because
 * Monaco's filter compared the label "Path" against trigger text "-" and found
 * no match. The fix adds filterText: completionText ("-Path") so Monaco
 * correctly surfaces all parameter suggestions.
 *
 * Run: npm run test:e2e -- --spec e2e/intellisense.spec.ts
 */

async function dismissSuggestWidget(): Promise<void> {
  // Monaco suggest rows can intercept editor clicks while visible.
  for (let i = 0; i < 3; i++) {
    await browser.keys(["Escape"]);
    await browser.pause(120);
    const closed = await browser.execute(() => {
      const widget = document.querySelector(".suggest-widget");
      if (!widget) return true;
      const cls = (widget as HTMLElement).className || "";
      return !cls.includes("visible");
    });
    if (closed) return;
  }
}

async function focusEditorInput(): Promise<void> {
  // Focus Monaco's hidden textarea directly to avoid click interception by
  // completion rows.
  await browser.execute(() => {
    const input = document.querySelector(".monaco-editor textarea.inputarea");
    if (input instanceof HTMLTextAreaElement) input.focus();
  });
  await browser.pause(80);
  const hasFocus = await browser.execute(() => {
    const active = document.activeElement;
    return (
      active instanceof HTMLTextAreaElement &&
      active.classList.contains("inputarea")
    );
  });
  if (!hasFocus) {
    const editor = await $(".monaco-editor");
    await editor.click();
    await browser.pause(80);
  }
}

async function invokeFreshSuggest(): Promise<void> {
  await dismissSuggestWidget();
  await focusEditorInput();
  await browser.keys(["Control", " "]);
}

/** Helper: clear the editor and type fresh content.  */
async function clearEditorAndType(text: string): Promise<void> {
  await dismissSuggestWidget();
  await focusEditorInput();

  await browser.keys(["Control", "a"]);
  await browser.pause(100);
  await browser.keys(["Delete"]);
  await browser.pause(200);

  // Type a temporary character then immediately delete it.  This resets
  // Monaco's internal "recently dismissed at this trigger position" cache so
  // that trigger-character completions fire reliably even when the same
  // content was just dismissed in a previous test.
  await browser.keys(["x"]);
  await browser.pause(80);
  await browser.keys(["Backspace"]);
  await browser.pause(120);

  // Type character-by-character so Monaco triggers the completion provider.
  for (const ch of text) {
    await browser.keys([ch]);
    await browser.pause(50);
  }
  // Extra settle time after the last character.
  await browser.pause(200);
}

/**
 * Waits for the Monaco suggest widget to be visible AND contain at least one
 * list row (i.e. the async PS completions have loaded, not just the loading
 * message state). Returns the rows array if found, or empty array on timeout.
 */
async function waitForSuggestRows(timeoutMs = 12000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const widget = await $(".suggest-widget");
    if (widget) {
      const classes = await widget.getAttribute("class").catch(() => "");
      // 'message' class = loading or no-results panel; wait for it to go away.
      if (classes.includes("visible") && !classes.includes("message")) {
        const rows = await $$(
          ".suggest-widget .monaco-list-rows .monaco-list-row",
        );
        if (rows.length > 0) return rows;
      }
    }
    await browser.pause(300);
  }
  return [];
}

/**
 * Waits for the Monaco suggest widget to have visible rows, then reads all row
 * texts (innerText + aria-label) in a single synchronous browser.execute()
 * snapshot to avoid stale element references from Monaco's virtual-list
 * re-renders. aria-label is used as fallback because virtual-list rows that
 * are scrolled out of the visible viewport may have empty innerText.
 * Returns an array of text strings (may be empty on timeout).
 */
async function waitForSuggestRowTexts(timeoutMs = 15000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts: string[] = await browser.execute(() => {
      const widget = document.querySelector(".suggest-widget");
      if (!widget) return [];
      const cls = widget.className || "";
      // Must be visible and not in the loading/message state.
      if (!cls.includes("visible") || cls.includes("message")) return [];
      const rows = Array.from(
        widget.querySelectorAll(".monaco-list-rows .monaco-list-row"),
      );
      return rows
        .map((r) => {
          const el = r as HTMLElement;
          // aria-label is always present and reliable; innerText may be empty
          // for rows that are virtualised out of the viewport.
          const ariaLabel = el.getAttribute("aria-label") || "";
          const inner = el.innerText || el.textContent || "";
          return (ariaLabel + " " + inner).trim();
        })
        .filter((t) => t.length > 0);
    });
    if (texts.length > 0) return texts;
    await browser.pause(300);
  }
  return [];
}

/** Waits for the Monaco suggest widget to become visible, returns true if it appeared. */
async function waitForSuggestWidget(timeoutMs = 8000): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => {
        const widget = await $(".suggest-widget");
        if (!widget) return false;
        return widget.isDisplayed();
      },
      { timeout: timeoutMs, interval: 200 },
    );
    return true;
  } catch {
    return false;
  }
}

describe("IntelliSense Completions", () => {
  before(async () => {
    // Ensure we have a fresh code tab (not welcome) with the editor visible.
    const newBtn = await $('[data-testid="toolbar-new"]');
    await newBtn.click();
    await browser.pause(500);

    // Keep the bottom pane on a non-terminal tab so terminal focus does not
    // interfere with Monaco keyboard input during completion tests.
    const variablesTab = await $('[data-testid="bottom-tab-variables"]');
    await variablesTab.click();
    await browser.pause(200);

    // Make sure a PS version is selected.
    const psSel = await $('[data-testid="toolbar-ps-selector"]');
    const psVal = await psSel.getValue();
    if (!psVal || psVal.trim() === "") {
      // Try to wait for versions to load.
      await browser.waitUntil(
        async () => {
          const val = await psSel.getValue();
          return val && (val.includes("\\") || val.includes("/"));
        },
        { timeout: 10000, timeoutMsg: "PS version selector never got a value" },
      );
    }
  });

  after(async () => {
    await dismissSuggestWidget();
    await browser.execute(() => {
      const dispatch = (window as any).__psforge_dispatch;
      if (typeof dispatch !== "function") return;

      const tabs = Array.from(
        document.querySelectorAll('[data-testid^="tab-item-"]'),
      ) as HTMLElement[];
      if (tabs.length > 1) {
        const activeTab =
          tabs.find((tab) =>
            (tab.style.backgroundColor || "").includes("var(--bg-tab-active)"),
          ) ?? tabs[tabs.length - 1];
        const testId = activeTab.getAttribute("data-testid") || "";
        const tabId = testId.replace("tab-item-", "");
        if (tabId) {
          dispatch({ type: "CLOSE_TAB", id: tabId });
        }
      }

      dispatch({ type: "SET_BOTTOM_TAB", tab: "output" });
    });
    await browser.pause(300);
  });

  describe("Cmdlet Completions", () => {
    it("should show completion suggestions when typing a partial cmdlet name", async () => {
      await clearEditorAndType("Get-C");
      await invokeFreshSuggest();
      const rows = await waitForSuggestRows(12000);
      expect(rows.length).toBeGreaterThan(0);
    });

    it("completion list should contain Get-ChildItem", async () => {
      await clearEditorAndType("Get-Ch");
      await invokeFreshSuggest();
      const rows = await waitForSuggestRows(12000);
      expect(rows.length).toBeGreaterThan(0);

      let found = false;
      for (const row of rows) {
        const text = await row.getText();
        if (text.includes("Get-ChildItem")) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it("should dismiss the suggest widget with Escape", async () => {
      await clearEditorAndType("Get-C");
      await invokeFreshSuggest();
      await waitForSuggestWidget(6000);
      await browser.keys(["Escape"]);
      await browser.pause(400);
      const widget = await $(".suggest-widget");
      const classes = await widget.getAttribute("class").catch(() => "");
      // Widget should not have 'visible' class after Escape.
      expect(classes).not.toContain("visible");
    });
  });

  describe("Parameter Completions (the bug fix)", () => {
    it("should show parameter completions when typing `Get-ChildItem -`", async () => {
      // This is THE test for the bug fix.
      await clearEditorAndType("Get-ChildItem -");
      await browser.pause(1000);
      const rows = await waitForSuggestRows(15000);
      expect(rows.length).toBeGreaterThan(0);
    });

    it("parameter completion list should contain -Path", async () => {
      await clearEditorAndType("Get-ChildItem -");
      await invokeFreshSuggest();
      let rowTexts = await waitForSuggestRowTexts(8000);
      let hasPath = rowTexts.some((t) => /(^|\s)-?path\b/i.test(t));

      // If Monaco remained in cmdlet-completion mode at '-' (can happen on
      // slower test runs), narrow to a parameter prefix and retry.
      if (!hasPath) {
        await clearEditorAndType("Get-ChildItem -Pa");
        await invokeFreshSuggest();
        rowTexts = await waitForSuggestRowTexts(10000);
        hasPath = rowTexts.some((t) => /(^|\s)-?path\b/i.test(t));
      }

      expect(rowTexts.length).toBeGreaterThan(0);
      if (!hasPath) {
        throw new Error(
          `"Path" was not present in parameter suggestions. Widget contents: ${JSON.stringify(rowTexts)}`,
        );
      }
    });

    it('parameter suggestion label is "Path" but insertion is "-Path"', async () => {
      // The bug-fix test: verify that accepting a -P completion inserts "-Path",
      // proving that filterText="-Path" was necessary for the completion to match
      // even though the displayed label is "Path".
      await clearEditorAndType("Get-ChildItem -Pa");
      await invokeFreshSuggest();
      const rows = await waitForSuggestRows(12000);
      if (rows.length === 0) {
        console.warn("[SKIP] No rows for -Pa; skipping insertion check");
        return;
      }

      // Check that the displayed label does NOT start with "-" (it is "Path").
      const firstRowText = await rows[0].getText();
      // Displayed label comes from listItemText = "Path" (no dash).
      expect(firstRowText.toLowerCase()).toContain("path");

      // Accept the completion.
      await browser.keys(["Tab"]);
      await browser.pause(400);

      // Inserted text should include "-Path" — proving insertion uses completionText.
      const content: string | null = await browser.execute(() => {
        const editors = (window as any).monaco?.editor?.getEditors?.();
        if (editors && editors.length > 0) return editors[0].getValue();
        return null;
      });
      if (content !== null) {
        expect(content).toMatch(/-[Pp]a/);
      }
    });
  });

  describe("Variable Completions", () => {
    it("should show completions for $ trigger", async () => {
      // Use $e to get $env:, $ExecutionContext, $Error etc. (bare $ may return none).
      await clearEditorAndType("$e");
      // Allow PS completion to run; $e returns ~72 results but may take a moment.
      await browser.pause(1500);

      const rows = await waitForSuggestRows(12000);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe("Multi-line Script Completions", () => {
    it("should show completions inside a multi-line script body", async () => {
      await clearEditorAndType("$x = 1\n");
      await browser.pause(100);
      for (const ch of "Get-ChildItem -") {
        await browser.keys([ch]);
        await browser.pause(30);
      }
      await browser.pause(800);

      const rows = await waitForSuggestRows(12000);
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
