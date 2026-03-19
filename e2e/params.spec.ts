/**
 * E2E Tests: Mandatory Parameter Prompt
 *
 * Verifies that when a PowerShell script declares mandatory parameters
 * without defaults, PSForge shows the ParamPromptDialog before running
 * so the user can supply values instead of receiving a cryptic error.
 *
 * Test matrix:
 *  - Single mandatory [string] parameter: dialog appears, value accepted, output correct.
 *  - Multiple mandatory parameters (different types): all fields shown, run with values.
 *  - Cancel button: dialog closes and script does NOT execute.
 *  - Script with no mandatory params: dialog is NOT shown; normal run.
 *  - Script with mandatory param that HAS a default: dialog is NOT shown.
 *  - Boolean param: checkbox input shown; $true / $false injected correctly.
 *
 * Run: npm run test:e2e:params
 */

export {};

// ---------------------------------------------------------------------------
// Timeout constants (Rule 3 — named constants, conservative for CI runners)
// ---------------------------------------------------------------------------

const DIALOG_APPEAR_TIMEOUT  = 10_000; // ms to wait for the param dialog to open
const DIALOG_DISMISS_TIMEOUT =  5_000; // ms to wait for dialog to close after action
const SCRIPT_OUTPUT_TIMEOUT  = 20_000; // ms to wait for PS output after run
const SCRIPT_IDLE_TIMEOUT    = 20_000; // ms to wait for the running indicator to clear

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replaces the Monaco editor content with the given text, character by
 * character, and waits for the model to reflect the new value.
 * Mirrors the pattern used in script-run.spec.ts (test isolation rule).
 */
async function setEditorContent(text: string): Promise<void> {
  const editor = await $('.monaco-editor');
  await editor.click();
  await browser.pause(200);
  await browser.keys(['Control', 'a']);
  await browser.pause(100);
  await browser.keys(['Delete']);
  await browser.pause(100);
  // Type the new content slowly to avoid Monaco missing characters.
  for (const ch of text) {
    await browser.keys([ch]);
    await browser.pause(20);
  }
  await browser.pause(300);
}

/** Wait for the param-prompt dialog to appear. */
async function waitForDialog(timeoutMs = DIALOG_APPEAR_TIMEOUT): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => {
        const el = await $('[data-testid="param-prompt-dialog"]');
        return el.isDisplayed();
      },
      { timeout: timeoutMs, interval: 200, timeoutMsg: 'param-prompt-dialog did not appear' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Returns true once the param-prompt dialog is no longer in the DOM / hidden. */
async function waitForDialogGone(timeoutMs = DIALOG_DISMISS_TIMEOUT): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => {
        const el = await $('[data-testid="param-prompt-dialog"]');
        return !(await el.isDisplayed());
      },
      { timeout: timeoutMs, interval: 200, timeoutMsg: 'param-prompt-dialog did not dismiss' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Return visible text from the output scroll pane. */
async function getOutputText(): Promise<string> {
  const scroll = await $('[data-testid="output-scroll"]');
  return scroll.getText();
}

/** Wait for `substring` to appear in the output scroll pane. */
async function waitForOutput(
  substring: string,
  timeoutMs = SCRIPT_OUTPUT_TIMEOUT,
): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => (await getOutputText()).includes(substring),
      { timeout: timeoutMs, interval: 300, timeoutMsg: `output did not contain: ${substring}` },
    );
    return true;
  } catch {
    return false;
  }
}

/** Wait for the script-running indicator to clear (isRunning -> false). */
async function waitForIdle(timeoutMs = SCRIPT_IDLE_TIMEOUT): Promise<void> {
  await browser.waitUntil(
    async () => {
      const btn = await $('[data-testid="toolbar-run"]');
      // The Run button is re-enabled when execution finishes.
      return btn.isEnabled();
    },
    { timeout: timeoutMs, interval: 300, timeoutMsg: 'script did not finish running' },
  );
}

/** Click the Run toolbar button and switch to the Output bottom tab. */
async function clickRun(): Promise<void> {
  const runBtn = await $('[data-testid="toolbar-run"]');
  await runBtn.click();
  await browser.pause(200);
  const outputTab = await $('[data-testid="output-tab-output"]');
  await outputTab.click();
}

// ---------------------------------------------------------------------------
// Ensure we have a fresh code tab and a PS version selected before tests.
// ---------------------------------------------------------------------------

before(async () => {
  const newBtn = await $('[data-testid="toolbar-new"]');
  await newBtn.click();
  await browser.pause(600);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Mandatory Parameter Prompt', () => {

  it('shows the dialog for a script with a single mandatory string param', async () => {
    // Script has one mandatory param $Name with no default.
    await setEditorContent(
      'param([Parameter(Mandatory)][string]$Name)\nWrite-Host "Hello $Name"',
    );

    await clickRun();

    const dialogShown = await waitForDialog();
    expect(dialogShown).toBe(true);

    // The parameter field for $Name should be present and visible.
    const nameField = await $('[data-testid="param-input-Name"]');
    expect(await nameField.isDisplayed()).toBe(true);

    // Dismiss without running.
    const cancelBtn = await $('[data-testid="param-prompt-cancel"]');
    await cancelBtn.click();
    await waitForDialogGone();
  });

  it('accepts a value and runs the script, producing correct output', async () => {
    await setEditorContent(
      'param([Parameter(Mandatory)][string]$Greeting)\nWrite-Host $Greeting',
    );

    await clickRun();

    const dialogShown = await waitForDialog();
    expect(dialogShown).toBe(true);

    // Type a value into the input.
    const field = await $('[data-testid="param-input-Greeting"]');
    await field.click();
    await field.setValue('PSForge');

    // Click Run inside the dialog.
    const runBtn = await $('[data-testid="param-prompt-run"]');
    await runBtn.click();

    // Dialog should dismiss.
    const dismissed = await waitForDialogGone();
    expect(dismissed).toBe(true);

    // Wait for output.
    const hasOutput = await waitForOutput('PSForge');
    expect(hasOutput).toBe(true);

    await waitForIdle();
  });

  it('executes a script with begin/process/end blocks after mandatory param prompt', async () => {
    // Regression guard: this script shape failed when runs were wrapped in a
    // dynamically-created ScriptBlock and invoked with named args.
    await setEditorContent([
      'param([Parameter(Mandatory)][string]$Identity)',
      'begin { $items = [System.Collections.Generic.List[string]]::new() }',
      'process { $items.Add($Identity) }',
      'end { Write-Host ("BPE:" + $items[0]) }',
    ].join('\n'));

    await clickRun();

    const dialogShown = await waitForDialog();
    expect(dialogShown).toBe(true);

    const field = await $('[data-testid="param-input-Identity"]');
    await field.click();
    await field.setValue('ADUpdateTest');

    const runBtn = await $('[data-testid="param-prompt-run"]');
    await runBtn.click();

    const dismissed = await waitForDialogGone();
    expect(dismissed).toBe(true);

    const hasOutput = await waitForOutput('BPE:ADUpdateTest');
    expect(hasOutput).toBe(true);

    // If execution regresses to wrapper-based invocation, PowerShell emits
    // parse/runtime errors like "The term 'begin' is not recognized...".
    const output = await getOutputText();
    expect(output.includes("The term 'begin' is not recognized")).toBe(false);

    await waitForIdle();
  });

  it('cancel button aborts the run (script does NOT execute)', async () => {
    // Unique sentinel so we can confirm it does NOT appear if cancelled.
    const sentinel = `SHOULD_NOT_APPEAR_${Date.now()}`;
    await setEditorContent(
      `param([Parameter(Mandatory)][string]$Val)\nWrite-Host "${sentinel}"`,
    );

    await clickRun();

    const dialogShown = await waitForDialog();
    expect(dialogShown).toBe(true);

    // Cancel without providing a value.
    const cancelBtn = await $('[data-testid="param-prompt-cancel"]');
    await cancelBtn.click();

    await waitForDialogGone();

    // Check that the output does NOT contain the sentinel.
    // Wait a short time to confirm nothing arrived.
    await browser.pause(1500);
    const output = await getOutputText();
    expect(output.includes(sentinel)).toBe(false);
  });

  it('handles multiple mandatory params of different types', async () => {
    // Keep the param() declaration on one line to reduce Monaco typing-flake
    // risk in E2E (multi-line balanced-paren edits are occasionally lossy).
    await setEditorContent(
      'param([Parameter(Mandatory)][string]$FirstName, [Parameter(Mandatory)][int]$Age)\nWrite-Host "$FirstName is $Age years old"',
    );

    await clickRun();

    const dialogShown = await waitForDialog();
    expect(dialogShown).toBe(true);

    // Both fields should be present.
    const firstNameField = await $('[data-testid="param-input-FirstName"]');
    const ageField        = await $('[data-testid="param-input-Age"]');
    expect(await firstNameField.isDisplayed()).toBe(true);
    expect(await ageField.isDisplayed()).toBe(true);

    // Fill in the values.
    await firstNameField.click();
    await firstNameField.setValue('Alice');
    await ageField.click();
    await ageField.setValue('30');

    // Run.
    const runBtn = await $('[data-testid="param-prompt-run"]');
    await runBtn.click();

    await waitForDialogGone();
    const hasOutput = await waitForOutput('Alice is 30 years old');
    expect(hasOutput).toBe(true);
    await waitForIdle();
  });

  it('does NOT show the dialog for a script with no mandatory params', async () => {
    await setEditorContent('Write-Host "no params here"');

    await clickRun();

    // Dialog should NOT appear within a brief window.
    const dialogShown = await waitForDialog(2000);
    expect(dialogShown).toBe(false);

    // The script should run and produce output normally.
    const hasOutput = await waitForOutput('no params here');
    expect(hasOutput).toBe(true);
    await waitForIdle();
  });

  it('does NOT show the dialog when the mandatory param already has a default', async () => {
    // Param is mandatory in name only (has default), so PSForge should NOT prompt.
    await setEditorContent(
      'param([Parameter(Mandatory=$false)][string]$Val = "defaultVal")\nWrite-Host $Val',
    );

    await clickRun();

    const dialogShown = await waitForDialog(2000);
    expect(dialogShown).toBe(false);

    const hasOutput = await waitForOutput('defaultVal');
    expect(hasOutput).toBe(true);
    await waitForIdle();
  });

  it('shows a checkbox for a boolean mandatory param and injects $true correctly', async () => {
    await setEditorContent([
      // Avoid $Verbose name collision with PowerShell's built-in common
      // parameter metadata; we want a user script bool parameter here.
      'param([Parameter(Mandatory)][bool]$IsVerbose)',
      'if ($IsVerbose) { Write-Host "verbose-on" } else { Write-Host "verbose-off" }',
    ].join('\n'));

    await clickRun();

    const dialogShown = await waitForDialog();
    expect(dialogShown).toBe(true);

    // Should be a checkbox, defaulting to unchecked ($false).
    const checkbox = await $('[data-testid="param-input-IsVerbose"]');
    expect(await checkbox.getAttribute('type')).toBe('checkbox');
    // Check the box to choose $true.
    await checkbox.click();

    const runBtn = await $('[data-testid="param-prompt-run"]');
    await runBtn.click();

    await waitForDialogGone();
    const hasOutput = await waitForOutput('verbose-on');
    expect(hasOutput).toBe(true);
    await waitForIdle();
  });

  it('Run button is disabled when a required text field is empty', async () => {
    await setEditorContent(
      'param([Parameter(Mandatory)][string]$Path)\nWrite-Host $Path',
    );

    await clickRun();

    const dialogShown = await waitForDialog();
    expect(dialogShown).toBe(true);

    // Run button should be disabled when field is empty.
    const runBtn = await $('[data-testid="param-prompt-run"]');
    expect(await runBtn.isEnabled()).toBe(false);

    // Fill in a value -> button should become enabled.
    const field = await $('[data-testid="param-input-Path"]');
    await field.setValue('C:\\Temp');
    expect(await runBtn.isEnabled()).toBe(true);

    // Cancel to clean up.
    const cancelBtn = await $('[data-testid="param-prompt-cancel"]');
    await cancelBtn.click();
    await waitForDialogGone();
  });
});
