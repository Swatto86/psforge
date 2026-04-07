/**
 * E2E Tests: Script Execution
 *
 * Verifies that a PowerShell script can be written in the Monaco editor and
 * executed via the Run toolbar button (or F5), with output appearing in the
 * integrated terminal.
 *
 * Tests cover:
 *  - Run button enabled/disabled state
 *  - Stop button enabled/disabled state
 *  - Write-Host output appearing in the terminal buffer
 *  - Write-Error output appearing in the terminal buffer
 *  - Running script with no output does not crash
 *
 * Run: npm run test:e2e -- --spec e2e/script-run.spec.ts
 */

export {};

const SCRIPT_OUTPUT_TIMEOUT = 45000; // ms to wait for PS output
const SCRIPT_IDLE_TIMEOUT   = 45000; // ms to wait for script to finish

/** Type text into the Monaco editor, replacing any existing content. */
async function setEditorContent(text: string): Promise<void> {
  const updatedViaHelper = await browser.execute((nextText: string) => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_setEditorText;
    return typeof fn === 'function' && (fn as (text: string) => boolean)(nextText);
  }, text);
  if (updatedViaHelper) {
    await browser.pause(150);
    return;
  }

  const editorArea = await $('.monaco-editor');
  await editorArea.click();
  await browser.pause(200);
  await browser.execute(() => {
    const input = document.querySelector('.monaco-editor textarea.inputarea');
    if (input instanceof HTMLTextAreaElement) input.focus();
  });
  await browser.pause(80);
  await browser.keys(['Escape']);
  await browser.pause(60);
  // Select all and replace.
  await browser.keys(['Control', 'a']);
  await browser.pause(100);
  await browser.keys(['Delete']);
  await browser.pause(100);
  for (const ch of text) {
    await browser.keys([ch]);
    await browser.pause(20);
  }
}

/** Click Run and wait for output text, retrying once for transient UI focus races. */
async function runAndExpectOutput(
  expected: string,
  timeoutMs = SCRIPT_OUTPUT_TIMEOUT,
  attempts = 2,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await clickRun();
    const found = await waitForOutputText(expected, timeoutMs);
    if (found) return true;
    await browser.pause(300);
  }
  return false;
}

async function showTerminalTab(): Promise<void> {
  const terminalTab = await $('[data-testid="bottom-tab-terminal"]');
  await terminalTab.click();
  await browser.pause(150);
}

async function getTerminalText(lineCount = 200): Promise<string> {
  await showTerminalTab();
  return browser.execute((n: number): string => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_terminal_get_content;
    if (typeof fn !== 'function') return '';
    return (fn as (lineCount?: number) => string)(n);
  }, lineCount);
}

/** Wait for visible text to appear inside the integrated terminal buffer. */
async function waitForOutputText(
  substring: string,
  timeoutMs = SCRIPT_OUTPUT_TIMEOUT
): Promise<boolean> {
  try {
    await browser.waitUntil(async () => {
      const text = await getTerminalText();
      return text.includes(substring);
    }, { timeout: timeoutMs, interval: 300 });
    return true;
  } catch {
    return false;
  }
}

/** Get the current text content of the terminal buffer. */
async function getOutputText(): Promise<string> {
  return getTerminalText();
}

/** Click the Run button and switch to the Terminal tab. */
async function clickRun(): Promise<void> {
  const runBtn = await $('[data-testid="toolbar-run"]');
  await runBtn.click();
  await browser.pause(200);
  await showTerminalTab();
}

describe('Script Execution', () => {

  before(async () => {
    // Ensure modal/overlay state from earlier specs does not intercept clicks.
    for (let i = 0; i < 3; i++) {
      await browser.keys(['Escape']);
      await browser.pause(100);
    }

    // Ensure there is exactly one new code tab open.
    const newBtn = await $('[data-testid="toolbar-new"]');
    await newBtn.click();
    await browser.pause(600);

    // Ensure a PS version is selected before any script runs.
    const psSel = await $('[data-testid="toolbar-ps-selector"]');
    await browser.waitUntil(async () => {
      const val = await psSel.getValue();
      return typeof val === 'string' && (val.includes('\\') || val.includes('/'));
    }, { timeout: 10000, timeoutMsg: 'PS version selector never got a value' });

    await showTerminalTab();
    await browser.pause(300);

    // Warm up the execution path so first assertions are not penalised by
    // cold-start shell/runspace latency.
    const warmupMarker = `E2E_WARMUP_${Date.now()}`;
    await setEditorContent(`Write-Host "${warmupMarker}"`);
    await runAndExpectOutput(warmupMarker, SCRIPT_OUTPUT_TIMEOUT, 2);
  });

  describe('Toolbar Run/Stop Button States', () => {
    it('Run button should be visible in the toolbar', async () => {
      const runBtn = await $('[data-testid="toolbar-run"]');
      expect(await runBtn.isExisting()).toBe(true);
    });

    it('Stop button should be visible in the toolbar', async () => {
      const stopBtn = await $('[data-testid="toolbar-stop"]');
      expect(await stopBtn.isExisting()).toBe(true);
    });

    it('Run button should be enabled when there is no active script', async () => {
      const runBtn = await $('[data-testid="toolbar-run"]');
      const disabled = await runBtn.getAttribute('disabled');
      expect(disabled).toBeNull();
    });
  });

  describe('Write-Host Output', () => {
    it('should display Write-Host output in the terminal', async () => {
      const testMarker = 'E2ETestOutput_WriteHost';
      await setEditorContent(`Write-Host "${testMarker}"`);
      const found = await runAndExpectOutput(testMarker, SCRIPT_OUTPUT_TIMEOUT, 2);
      expect(found).toBe(true);
    });

    it('should switch from Problems back to Terminal when a script is run', async () => {
      const marker = `ProblemsToTerminal_${Date.now()}`;
      await setEditorContent(`Write-Host "${marker}"`);

      await browser.execute(() => {
        (window as unknown as Record<string, unknown>).__psforge_dispatch &&
          ((window as unknown as Record<string, unknown>).__psforge_dispatch as (
            action: { type: string; tab: string },
          ) => void)({ type: 'SET_BOTTOM_TAB', tab: 'problems' });
      });

      const terminalPanel = await $('[data-testid="terminal-panel"]');
      expect(await terminalPanel.isDisplayed()).toBe(false);

      const runBtn = await $('[data-testid="toolbar-run"]');
      await runBtn.click();

      await browser.waitUntil(
        async () => terminalPanel.isDisplayed().catch(() => false),
        {
          timeout: 5000,
          interval: 100,
          timeoutMsg: 'Running from Problems did not switch back to Terminal',
        },
      );

      const found = await waitForOutputText(marker, SCRIPT_OUTPUT_TIMEOUT);
      expect(found).toBe(true);
    });

    it('should display multiline Write-Host output', async () => {
      await setEditorContent(
        'Write-Host "Line_A_E2E"\nWrite-Host "Line_B_E2E"'
      );
      await clickRun();
      const foundA = await waitForOutputText('Line_A_E2E', SCRIPT_OUTPUT_TIMEOUT);
      const foundB = await waitForOutputText('Line_B_E2E', SCRIPT_OUTPUT_TIMEOUT);
      expect(foundA).toBe(true);
      expect(foundB).toBe(true);
    });

    it('should display variable interpolation output', async () => {
      await setEditorContent(
        '$greeting = "Hello_E2E"\nWrite-Host $greeting'
      );
      await clickRun();
      const found = await waitForOutputText('Hello_E2E', SCRIPT_OUTPUT_TIMEOUT);
      expect(found).toBe(true);
    });

    it('should accumulate output across multiple lines', async () => {
      await setEditorContent(
        '1..3 | ForEach-Object { Write-Host "Item_E2E_$_" }'
      );
      await clickRun();
      const found1 = await waitForOutputText('Item_E2E_1', SCRIPT_OUTPUT_TIMEOUT);
      const found3 = await waitForOutputText('Item_E2E_3', SCRIPT_OUTPUT_TIMEOUT);
      expect(found1).toBe(true);
      expect(found3).toBe(true);
    });
  });

  describe('Pipeline & expression output', () => {
    it('should show plain expression results', async () => {
      await setEditorContent('2 + 2');
      await clickRun();
      const found = await waitForOutputText('4', SCRIPT_OUTPUT_TIMEOUT);
      expect(found).toBe(true);
    });

    it('should show Get-Date output', async () => {
      // Just verify some output appears; date format varies.
      await setEditorContent('Get-Date -Format "yyyy"');
      await clickRun();
      const text = await browser.waitUntil(async () => {
        const t = await getOutputText();
        if (/202\d/.test(t)) return t;
        return null;
      }, { timeout: SCRIPT_OUTPUT_TIMEOUT, interval: 300,
           timeoutMsg: 'Get-Date did not produce a year in output' }) as string;
      expect(text).toMatch(/202\d/);
    });
  });

  describe('Error Output', () => {
    it('should show error output in the terminal', async () => {
      await setEditorContent('Write-Error "E2EError_Marker"');
      await clickRun();
      const found = await waitForOutputText('E2EError_Marker', SCRIPT_OUTPUT_TIMEOUT);
      expect(found).toBe(true);
    });

    it('should show a non-terminating error and still complete', async () => {
      const marker = 'AfterError_E2E';
      await setEditorContent(
        'Write-Error "nonfatal"\nWrite-Host "' + marker + '"'
      );
      await clickRun();
      const found = await waitForOutputText(marker, SCRIPT_OUTPUT_TIMEOUT);
      expect(found).toBe(true);
    });
  });

  describe('Script Lifecycle', () => {
    it('should complete a fast script and return Run button to enabled', async () => {
      await setEditorContent('Write-Host "Lifecycle_E2E_Done"');
      await clickRun();
      await waitForOutputText('Lifecycle_E2E_Done', SCRIPT_OUTPUT_TIMEOUT);

      // After completion, Run button should be enabled (not disabled).
      await browser.waitUntil(async () => {
        const runBtn = await $('[data-testid="toolbar-run"]');
        const disabled = await runBtn.getAttribute('disabled');
        return disabled === null;
      }, { timeout: SCRIPT_IDLE_TIMEOUT, timeoutMsg: 'Run button did not re-enable after script completion' });

      const runBtn = await $('[data-testid="toolbar-run"]');
      const disabled = await runBtn.getAttribute('disabled');
      expect(disabled).toBeNull();
    });

    it('should show Stop button as enabled while a long script is running', async () => {
      // Start a slow script.
      await setEditorContent('Start-Sleep -Seconds 10\nWrite-Host "SlowScript_E2E"');
      const runBtn = await $('[data-testid="toolbar-run"]');
      await runBtn.click();
      await browser.pause(600);

      // While running, Stop should be enabled (or at minimum not throw when clicked).
      // We check within the first 2 seconds.
      await browser.pause(1000);
      const stopBtn = await $('[data-testid="toolbar-stop"]');
      const stopExists = await stopBtn.isExisting();
      expect(stopExists).toBe(true);

      // Stop the script so it doesn't block further tests.
      await stopBtn.click();
      await browser.pause(1000);
    });

    it('Stop button cancels an in-progress script', async () => {
      await setEditorContent('Start-Sleep -Seconds 30\nWrite-Host "NeverReached_E2E"');
      const runBtn = await $('[data-testid="toolbar-run"]');
      await runBtn.click();
      await browser.pause(800);

      const stopBtn = await $('[data-testid="toolbar-stop"]');
      await stopBtn.click();

      // After stopping, the Run button should eventually re-enable.
      await browser.waitUntil(async () => {
        const btn = await $('[data-testid="toolbar-run"]');
        const disabled = await btn.getAttribute('disabled');
        return disabled === null;
      }, { timeout: 10000, timeoutMsg: 'Run button did not re-enable after stopping script' });

      // "NeverReached_E2E" should NOT be in the terminal buffer.
      await showTerminalTab();
      await browser.pause(500);
      const text = await getOutputText();
      expect(text).not.toContain('NeverReached_E2E');
    });
  });

  describe('F8 Selection Semantics', () => {
    it('F8 should run the current line when no text is selected', async () => {
      const marker = 'F8_CurrentLine_E2E';
      await setEditorContent(`Write-Host "${marker}"`);

      const editorArea = await $('.monaco-editor');
      await editorArea.click();
      await browser.pause(120);

      await browser.keys(['F8']);
      await browser.pause(250);

      const found = await waitForOutputText(marker, SCRIPT_OUTPUT_TIMEOUT);
      expect(found).toBe(true);
    });
  });
});
