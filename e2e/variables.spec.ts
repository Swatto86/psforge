/**
 * E2E Tests: Variables Tab
 *
 * Verifies the variable inspector panel that populates after a script run.
 * After a successful run, PSForge captures variables from the completed
 * runspace without replaying the script and surfaces the resulting list in
 * the Variables tab.
 *
 * Coverage:
 *  - Variables tab shows empty-state message before any run
 *  - After running a script, user-defined variables appear in the table
 *  - Name, value, and type columns are all populated correctly
 *  - String / integer / boolean type colouring rows are present
 *  - Filter by variable name narrows the displayed rows
 *  - Filter by variable value narrows the displayed rows
 *  - Clearing the filter restores the full list
 *  - Built-in PS variables are also present (HOME, PID, etc.)
 *
 * Run: npm run test:e2e:variables
 */

export {};

// ── Timeout constants ─────────────────────────────────────────────────────────
/**
 * Max wait for the Variables tab to populate after a run.
 * Variable snapshots are emitted at the end of the live session, but the UI
 * still updates asynchronously after the main output sentinel appears.
 */
const VAR_POPULATE_TIMEOUT = 35_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function dismissSuggestWidget(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
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

/**
 * Select all text in the Monaco editor and replace it with `text`.
 * Uses Monaco's active editor model directly when available so suggestion
 * widgets and provider triggers cannot corrupt the scripted test content.
 */
async function setEditorContent(text: string): Promise<void> {
  await dismissSuggestWidget();
  const setViaMonaco = await browser.execute((content: string) => {
    const dispatch = (window as any).__psforge_dispatch;
    const tabs = Array.from(
      document.querySelectorAll('[data-testid^="tab-item-"]'),
    ) as HTMLElement[];
    const activeTab =
      tabs.find((tab) =>
        (tab.style.backgroundColor || "").includes("var(--bg-tab-active)"),
      ) ?? tabs[tabs.length - 1];
    const testId = activeTab?.getAttribute("data-testid") || "";
    const activeTabId = testId.replace("tab-item-", "");
    if (typeof dispatch === "function" && activeTabId) {
      dispatch({
        type: "UPDATE_TAB",
        id: activeTabId,
        changes: { content, isDirty: true },
      });
    }

    const editors = (window as any).monaco?.editor?.getEditors?.();
    if (!Array.isArray(editors) || editors.length === 0) return false;
    const editor =
      editors.find((candidate: any) => {
        const domNode = candidate?.getDomNode?.();
        return domNode instanceof HTMLElement && domNode.offsetParent !== null;
      }) ?? editors[0];
    if (!editor) return false;
    editor.focus();
    editor.setValue(content);
    const model = editor.getModel?.();
    const lastLine = model?.getLineCount?.() ?? 1;
    const lastColumn = model?.getLineMaxColumn?.(lastLine) ?? 1;
    editor.setPosition({ lineNumber: lastLine, column: lastColumn });
    return true;
  }, text);

  if (!setViaMonaco) {
    await focusEditorInput();
    await browser.keys(["Control", "a"]);
    await browser.pause(100);
    await browser.keys(["Delete"]);
    await browser.pause(120);
    await browser.keys(["x"]);
    await browser.pause(80);
    await browser.keys(["Backspace"]);
    await browser.pause(120);
    for (const ch of text) {
      await browser.keys([ch]);
      await browser.pause(20);
    }
  }

  await browser.pause(500);
  await dismissSuggestWidget();
}

/** Click Run and switch to the Terminal tab to watch for completion. */
async function clickRunAndSwitchToOutput(): Promise<void> {
  await dismissSuggestWidget();
  const runBtn = await $('[data-testid="toolbar-run"]');
  await runBtn.click();
  await browser.pause(200);
  const terminalTab = await $('[data-testid="bottom-tab-terminal"]');
  await terminalTab.click();
}

async function openNewCodeTab(): Promise<void> {
  const tabsBefore = await $$('[data-testid^="tab-item-"]');
  const countBefore = tabsBefore.length;
  const newBtn = await $('[data-testid="toolbar-new"]');
  await newBtn.click();
  await browser.waitUntil(
    async () => {
      const tabs = await $$('[data-testid^="tab-item-"]');
      return tabs.length > countBefore;
    },
    {
      timeout: 5000,
      interval: 100,
      timeoutMsg: "New code tab did not appear",
    },
  );
  await browser.waitUntil(
    async () => {
      return browser.execute(() => {
        const tabs = Array.from(
          document.querySelectorAll('[data-testid^="tab-item-"]'),
        ) as HTMLElement[];
        if (tabs.length === 0) return false;
        const activeTab = tabs.find((tab) =>
          (tab.style.backgroundColor || "").includes("var(--bg-tab-active)"),
        );
        return activeTab === tabs[tabs.length - 1];
      });
    },
    {
      timeout: 5000,
      interval: 100,
      timeoutMsg: "New code tab did not become active",
    },
  );
  await browser.pause(150);
  await dismissSuggestWidget();
}

async function waitForSelectedPsPath(): Promise<void> {
  const psSel = await $('[data-testid="toolbar-ps-selector"]');
  await browser.waitUntil(
    async () => {
      const val = await psSel.getValue();
      return (
        typeof val === "string" && (val.includes("\\") || val.includes("/"))
      );
    },
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: "PS version selector never got a path value",
    },
  );
}

/**
 * Poll until the row for `variableName` appears in the Variables table.
 * `variableName` is the PS variable name WITHOUT the leading `$` (e.g. "myStr").
 * The data-testid is lowercased at render time.
 */
async function waitForVariableRow(
  variableName: string,
  timeoutMs = VAR_POPULATE_TIMEOUT,
): Promise<void> {
  const testId = `variables-row-${variableName.toLowerCase()}`;
  await browser.waitUntil(
    async () => {
      const row = await $(`[data-testid="${testId}"]`);
      return row.isExisting();
    },
    {
      timeout: timeoutMs,
      interval: 500,
      timeoutMsg: `Variables table never showed row for $${variableName} (data-testid="${testId}") within ${timeoutMs}ms`,
    },
  );
}

async function runScriptAndWaitForVariable(
  scriptText: string,
  variableName: string,
  timeoutMs = VAR_POPULATE_TIMEOUT,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await openNewCodeTab();
      await setEditorContent(scriptText);
      await clickRunAndSwitchToOutput();

      const varTab = await $('[data-testid="bottom-tab-variables"]');
      await varTab.click();
      await browser.pause(250);
      await waitForVariableRow(variableName, timeoutMs);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** Return the text content of a variable row, or null if the row is absent. */
async function getVariableRowText(
  variableName: string,
): Promise<string | null> {
  const testId = `variables-row-${variableName.toLowerCase()}`;
  const row = await $(`[data-testid="${testId}"]`);
  if (!(await row.isExisting())) return null;
  return row.getText();
}

/** Type `text` into the Variables filter input (clears first). */
async function setVariableFilter(text: string): Promise<void> {
  const filter = await $('[data-testid="variables-filter"]');
  await filter.click();
  await browser.keys(["Control", "a"]);
  await browser.pause(50);
  await browser.keys(["Delete"]);
  await browser.pause(50);
  for (const ch of text) {
    await browser.keys([ch]);
    await browser.pause(20);
  }
  // Brief settle time for React re-render
  await browser.pause(100);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Variables Tab", () => {
  before(async () => {
    await browser.refresh();
    await browser.waitUntil(
      async () => (await $('[data-testid="app-root"]')).isDisplayed(),
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "App root did not reappear after refresh",
      },
    );
    await browser.pause(300);

    // Make sure there is at least one code tab open.
    await openNewCodeTab();

    // Wait for a PS version to be detected.
    await waitForSelectedPsPath();
  });

  // ── Empty state ─────────────────────────────────────────────────────────────

  describe("Empty state (before any run)", () => {
    before(async () => {
      // Reset any variables left over from previous spec files running in the
      // same shared browser session, so the assertions see a known-empty state.
      await browser.execute(() => {
        const w = window as unknown as Record<string, unknown>;
        if (typeof w.__psforge_reset_variables === "function") {
          (w.__psforge_reset_variables as () => void)();
        }
      });
      const varTab = await $('[data-testid="bottom-tab-variables"]');
      await varTab.click();
      await browser.pause(200);
    });

    it("Variables tab button is present in the panel tab strip", async () => {
      const varTab = await $('[data-testid="bottom-tab-variables"]');
      expect(await varTab.isExisting()).toBe(true);
    });

    it("empty-state message is shown before any run", async () => {
      const empty = await $('[data-testid="variables-empty"]');
      expect(await empty.isExisting()).toBe(true);
      const text = await empty.getText();
      expect(text.toLowerCase()).toContain("run a script");
    });

    it("variables table is NOT rendered while state is empty", async () => {
      const table = await $('[data-testid="variables-table"]');
      expect(await table.isExisting()).toBe(false);
    });

    it("filter input is visible when the Variables tab is active", async () => {
      const filter = await $('[data-testid="variables-filter"]');
      expect(await filter.isExisting()).toBe(true);
    });
  });

  // ── Population after run ────────────────────────────────────────────────────

  describe("Variable population after a script run", () => {
    /**
     * Script used for this suite.  Uses unique E2E markers so assertions
     * don't accidentally match built-in PS variable values.
     * Write-Host 'E2E_VarDone' signals that the main run has finished so
     * we know when to start polling the Variables tab.
     */
    const SCRIPT = [
      "$E2EStr = 'E2E_Hello'",
      "$E2EInt = 12345",
      "$E2EBool = $true",
      "Write-Host 'E2E_VarDone'",
    ].join("\n");

    before(async () => {
      await runScriptAndWaitForVariable(SCRIPT, "E2EStr");
    });

    it("the variables table is rendered after the run", async () => {
      // Wait for at least one variable row to appear so we know the table
      // has been populated (E2EStr is the row we use as the ready signal).
      await waitForVariableRow("E2EStr");
      const table = await $('[data-testid="variables-table"]');
      expect(await table.isExisting()).toBe(true);
    });

    it("empty-state message is gone after the run", async () => {
      const empty = await $('[data-testid="variables-empty"]');
      expect(await empty.isExisting()).toBe(false);
    });

    it("user-defined string variable ($E2EStr) row is present", async () => {
      await waitForVariableRow("E2EStr");
      const text = await getVariableRowText("E2EStr");
      expect(text).not.toBeNull();
      expect(text).toContain("E2EStr");
    });

    it("string variable value ('E2E_Hello') is shown", async () => {
      const text = await getVariableRowText("E2EStr");
      expect(text).toContain("E2E_Hello");
    });

    it("string variable type (String) is shown", async () => {
      const text = await getVariableRowText("E2EStr");
      expect(text).toContain("String");
    });

    it("user-defined integer variable ($E2EInt) row is present", async () => {
      await waitForVariableRow("E2EInt");
      const text = await getVariableRowText("E2EInt");
      expect(text).not.toBeNull();
      expect(text).toContain("E2EInt");
    });

    it("integer variable value (12345) is shown", async () => {
      const text = await getVariableRowText("E2EInt");
      expect(text).toContain("12345");
    });

    it("integer variable type (Int32) is shown", async () => {
      const text = await getVariableRowText("E2EInt");
      expect(text).toContain("Int32");
    });

    it("user-defined boolean variable ($E2EBool) row is present", async () => {
      await waitForVariableRow("E2EBool");
      const text = await getVariableRowText("E2EBool");
      expect(text).not.toBeNull();
      expect(text).toContain("E2EBool");
    });

    it("boolean variable type (Boolean) is shown", async () => {
      const text = await getVariableRowText("E2EBool");
      expect(text!.toLowerCase()).toContain("boolean");
    });

    it("built-in PS variable ($HOME) is also listed", async () => {
      // $HOME is excluded from the filter-out list and should always appear.
      await waitForVariableRow("HOME");
      const text = await getVariableRowText("HOME");
      expect(text).not.toBeNull();
    });
  });

  // ── Filter ──────────────────────────────────────────────────────────────────

  describe("Filter input", () => {
    /**
     * Reuse the populated snapshot from the previous suite. The population
     * tests already verify the run path and seed the exact variables the
     * filter assertions depend on, so re-running here only adds flake.
     */
    before(async () => {
      const varTab = await $('[data-testid="bottom-tab-variables"]');
      await varTab.click();
      await browser.pause(250);
      await waitForVariableRow("E2EStr");

      // Always start with a cleared filter
      await setVariableFilter("");
    });

    afterEach(async () => {
      // Reset filter between each test so they don't interfere.
      await setVariableFilter("");
    });

    it("filter input is present and interactive", async () => {
      const filter = await $('[data-testid="variables-filter"]');
      expect(await filter.isExisting()).toBe(true);
      expect(await filter.isEnabled()).toBe(true);
    });

    it("filtering by name hides non-matching rows", async () => {
      // Type the unique marker so only $E2EStr should match by name.
      await setVariableFilter("E2EStr");
      // $E2EInt should NOT be visible.
      const intRow = await $('[data-testid="variables-row-e2eint"]');
      expect(await intRow.isExisting()).toBe(false);
    });

    it("filtering by name keeps matching rows visible", async () => {
      await setVariableFilter("E2EStr");
      const strRow = await $('[data-testid="variables-row-e2estr"]');
      expect(await strRow.isExisting()).toBe(true);
    });

    it("filtering by value matches against the value column", async () => {
      // 'E2E_Hello' is the value of $E2EStr — filter should surface that row.
      await setVariableFilter("E2E_Hello");
      const strRow = await $('[data-testid="variables-row-e2estr"]');
      expect(await strRow.isExisting()).toBe(true);
    });

    it("filtering by value hides rows whose value does not match", async () => {
      await setVariableFilter("E2E_Hello");
      // $E2EInt has value '12345' — should be hidden.
      const intRow = await $('[data-testid="variables-row-e2eint"]');
      expect(await intRow.isExisting()).toBe(false);
    });

    it("clearing the filter restores all previously visible rows", async () => {
      await setVariableFilter("E2EStr");
      // Confirm filtered state
      const intRowHidden = await $('[data-testid="variables-row-e2eint"]');
      expect(await intRowHidden.isExisting()).toBe(false);

      // Clear filter
      await setVariableFilter("");

      // Both rows should be back
      const strRow = await $('[data-testid="variables-row-e2estr"]');
      const intRow = await $('[data-testid="variables-row-e2eint"]');
      expect(await strRow.isExisting()).toBe(true);
      expect(await intRow.isExisting()).toBe(true);
    });

    it("filter is case-insensitive for name matching", async () => {
      // Type in all-lowercase even though the variable is mixed-case.
      await setVariableFilter("e2estr");
      const strRow = await $('[data-testid="variables-row-e2estr"]');
      expect(await strRow.isExisting()).toBe(true);
    });

    it("empty-state message appears when filter matches nothing", async () => {
      await setVariableFilter("E2E_NOMATCH_XYZZY_9999");
      const empty = await $('[data-testid="variables-empty"]');
      expect(await empty.isExisting()).toBe(true);
    });
  });
});
