/**
 * E2E Tests: Variables Tab
 *
 * Verifies the variable inspector panel that populates after a script run.
 * After a successful run, PSForge re-executes the script in a background
 * process alongside Get-Variable and surfaces the resulting variable list
 * in the Variables tab.
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
/** Max wait for the main script to finish and output to appear. */
const SCRIPT_TIMEOUT = 20_000;
/**
 * Max wait for the Variables tab to populate after a run.
 * The background Get-Variable process re-runs the entire script in a fresh
 * PS process, so it can take several seconds after the main run completes.
 */
const VAR_POPULATE_TIMEOUT = 35_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Select all text in the Monaco editor and replace it with `text`.
 * Types character-by-character to avoid Monaco autocomplete side effects.
 */
async function setEditorContent(text: string): Promise<void> {
  const editorArea = await $(".monaco-editor");
  await editorArea.click();
  await browser.pause(200);
  await browser.keys(["Control", "a"]);
  await browser.pause(100);
  await browser.keys(["Delete"]);
  await browser.pause(100);
  for (const ch of text) {
    await browser.keys([ch]);
    await browser.pause(20);
  }
}

/** Click Run and immediately switch to the Output tab to watch for completion. */
async function clickRunAndSwitchToOutput(): Promise<void> {
  const runBtn = await $('[data-testid="toolbar-run"]');
  await runBtn.click();
  await browser.pause(200);
  const outputTab = await $('[data-testid="output-tab-output"]');
  await outputTab.click();
}

/**
 * Poll the Output pane until it contains `substring` or the timeout expires.
 * Used to confirm the main script run has completed before checking variables.
 */
async function waitForOutputText(
  substring: string,
  timeoutMs = SCRIPT_TIMEOUT,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const scroll = await $('[data-testid="output-scroll"]');
      const text = await scroll.getText();
      return text.includes(substring);
    },
    {
      timeout: timeoutMs,
      interval: 300,
      timeoutMsg: `Output pane never contained "${substring}"`,
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
    // Make sure there is at least one code tab open.
    const newBtn = await $('[data-testid="toolbar-new"]');
    await newBtn.click();
    await browser.pause(600);

    // Wait for a PS version to be detected.
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
        timeoutMsg: "PS version selector never got a path value",
      },
    );
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
      const varTab = await $('[data-testid="output-tab-variables"]');
      await varTab.click();
      await browser.pause(200);
    });

    it("Variables tab button is present in the panel tab strip", async () => {
      const varTab = await $('[data-testid="output-tab-variables"]');
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
      await setEditorContent(SCRIPT);
      await clickRunAndSwitchToOutput();
      // Wait for the main script to emit its sentinel output line.
      await waitForOutputText("E2E_VarDone");
      // Switch to the Variables tab; the background variable-capture
      // process may still be running — waitForVariableRow will poll.
      const varTab = await $('[data-testid="output-tab-variables"]');
      await varTab.click();
      await browser.pause(300);
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
     * This suite depends on the Variables tab being populated from the
     * previous suite's run.  It runs in the same browser session, so state
     * carries over.  If the suite is run in isolation the before() hook
     * re-runs the population script.
     */
    before(async () => {
      // Make sure we are on the Variables tab.
      const varTab = await $('[data-testid="output-tab-variables"]');
      await varTab.click();
      await browser.pause(200);

      // Ensure the table is rendered; if not (isolated run), trigger a run.
      const table = await $('[data-testid="variables-table"]');
      if (!(await table.isExisting())) {
        const SCRIPT = [
          "$E2EStr = 'E2E_Hello'",
          "$E2EInt = 12345",
          "$E2EBool = $true",
          "Write-Host 'E2E_VarDone'",
        ].join("\n");
        await setEditorContent(SCRIPT);
        await clickRunAndSwitchToOutput();
        await waitForOutputText("E2E_VarDone");
        const varTab2 = await $('[data-testid="output-tab-variables"]');
        await varTab2.click();
        await waitForVariableRow("E2EStr");
      }

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
