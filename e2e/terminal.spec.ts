/**
 * E2E Tests: Integrated Terminal
 *
 * Verifies the xterm.js-based PowerShell terminal panel end-to-end:
 *  - Terminal tab navigation shows/hides the terminal panel
 *  - PS session starts and shows a prompt
 *  - Character input (typing) is echoed to the display
 *  - Backspace deletes correctly
 *  - Command execution produces output in the buffer
 *  - Keyboard Enter key reaches xterm's onData handler (regression test)
 *  - Command history is navigable via arrow keys
 *  - cls command clears the screen
 *  - prompt path reflects the current directory
 *
 * Two test strategies for command submission:
 *
 *  1. window.__psforge_terminal_submit_current_input()
 *     Directly invokes the Enter-key logic inside TerminalPane without going
 *     through the OS keyboard path.  Used for "does command execution work"
 *     tests so they pass regardless of whether the keyboard Enter path works.
 *
 *  2. browser.keys(['\uE006'])  — the WebDriver Return key
 *     Sends a real trusted keydown event via WebDriver.  Used specifically
 *     in the "keyboard Enter" regression test to document whether xterm's
 *     keydown handler receives Enter key presses from WebView2.
 *     IF THE APP BUG IS PRESENT (Enter not routed to xterm), THIS TEST FAILS.
 *
 * Run: npm run test:e2e:terminal
 */

// ── Timeout constants ─────────────────────────────────────────────────────────
const TERMINAL_READY_TIMEOUT = 30000;
const COMMAND_OUTPUT_TIMEOUT = 20000;
const PROMPT_TIMEOUT = 10000;
const KEY_DELAY_MS = 60;

// ── Page-context helpers ──────────────────────────────────────────────────────

async function getTerminalContent(lineCount = 200): Promise<string> {
  return browser.execute((n: number): string => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_terminal_get_content;
    if (typeof fn !== "function") return "";
    return (fn as (n: number) => string)(n);
  }, lineCount);
}

async function isSessionReady(): Promise<boolean> {
  return browser.execute((): boolean => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_terminal_is_ready;
    return typeof fn === "function" && (fn as () => boolean)();
  });
}

/**
 * Invoke the Enter-key handling logic directly inside TerminalPane, bypassing
 * the OS keyboard path.  This lets command-execution tests pass regardless of
 * whether the keyboard Enter route is currently broken.
 */
async function submitInput(): Promise<void> {
  await browser.execute(() => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_terminal_submit_current_input;
    if (typeof fn === "function") (fn as () => void)();
  });
  await browser.pause(100);
}

// ── WebDriver helpers ─────────────────────────────────────────────────────────

async function waitForPrompt(
  timeoutMs = TERMINAL_READY_TIMEOUT,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const c = await getTerminalContent();
      return c.includes("PS") && c.includes(">");
    },
    {
      timeout: timeoutMs,
      interval: 300,
      timeoutMsg: `PS prompt not found (waited ${timeoutMs}ms)`,
    },
  );
}

/**
 * Give the terminal keyboard focus.  First attempts a WebDriver click on the
 * container (which ensures the OS window has focus AND triggers xterm's
 * onClick→term.focus()).  Falls back to a JS focus call if the click is
 * intercepted by an overlapping element (e.g. the Variables pane mid-suite).
 */
async function focusTerminal(): Promise<void> {
  try {
    const container = await $('[data-testid="terminal-container"]');
    await container.click();
  } catch {
    await browser.execute(() => {
      const ta = document.querySelector(
        ".xterm-helper-textarea",
      ) as HTMLTextAreaElement | null;
      if (ta) ta.focus();
    });
  }
  await browser.pause(150);
}

async function resetToPrompt(): Promise<void> {
  await browser.execute(() => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_terminal_reset_input;
    if (typeof fn === "function") (fn as () => void)();
  });
  await browser.pause(200);
  await waitForPrompt(PROMPT_TIMEOUT);
}

async function typeInTerminal(text: string): Promise<void> {
  for (const ch of text) {
    await browser.keys([ch]);
    await browser.pause(KEY_DELAY_MS);
  }
}

async function getLastInputLine(): Promise<string> {
  const content = await getTerminalContent();
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trimEnd();
    if (t.trim().length > 0) return t;
  }
  return "";
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Integrated Terminal", () => {
  before(async () => {
    const termTab = await $('[data-testid="output-tab-terminal"]');
    await termTab.click();
    await browser.pause(400);
    await waitForPrompt(TERMINAL_READY_TIMEOUT);
  });

  beforeEach(async () => {
    await resetToPrompt();
  });

  // ── Tab Navigation ────────────────────────────────────────────────────────

  describe("Tab Navigation", () => {
    it("terminal panel has display:flex when Terminal tab is active", async () => {
      const panel = await $('[data-testid="terminal-panel"]');
      const display = await panel.getCSSProperty("display");
      expect(display.value).toBe("flex");
    });

    it("terminal panel has display:none when a different tab is active", async () => {
      await (await $('[data-testid="output-tab-output"]')).click();
      await browser.pause(200);

      const display = await (
        await $('[data-testid="terminal-panel"]')
      ).getCSSProperty("display");
      expect(display.value).toBe("none");

      await (await $('[data-testid="output-tab-terminal"]')).click();
      await browser.pause(200);
      await waitForPrompt(PROMPT_TIMEOUT);
    });
  });

  // ── Session Startup ───────────────────────────────────────────────────────

  describe("Session Startup", () => {
    it("PSForge Terminal banner appears in the buffer", async () => {
      expect(await getTerminalContent()).toContain("PSForge Terminal");
    });

    it("PS prompt is visible once the session has started", async () => {
      const content = await getTerminalContent();
      expect(content).toContain("PS");
      expect(content).toContain(">");
    });

    it("session ready flag is true — prerequisite for all keyboard input", async () => {
      // If this returns false, ALL keyboard-driven tests will silently drop
      // input.  A false result is the root-cause for "typing not working".
      expect(await isSessionReady()).toBe(true);
    });
  });

  // ── Remote Session Validation ───────────────────────────────────────────

  describe("Remote Session Validation", () => {
    it("rejects unsafe remote targets instead of building a startup command", async () => {
      const remoteBtn = await $('[data-testid="terminal-new-remote"]');
      await remoteBtn.click();
      await browser.pause(200);

      const dialog = await $('[data-testid="terminal-remote-dialog"]');
      await expect(dialog).toBeDisplayed();

      const input = await $('[data-testid="terminal-remote-input"]');
      await input.setValue("server01;Write-Host owned");

      const connect = await $('[data-testid="terminal-remote-connect"]');
      await connect.click();
      await browser.pause(200);

      const error = await $('[data-testid="terminal-remote-error"]');
      await expect(error).toBeDisplayed();
      await expect(error).toHaveText(
        "Remote computer name may only contain letters, numbers, dots, hyphens, underscores, and colons.",
      );

      await expect(dialog).toBeDisplayed();

      const cancel = await $('[data-testid="terminal-remote-cancel"]');
      await cancel.click();
      await browser.pause(200);
    });
  });

  // ── Keyboard Input ────────────────────────────────────────────────────────

  describe("Keyboard Input", () => {
    it("typing a single character echoes it to the terminal display", async () => {
      await focusTerminal();
      await browser.keys(["G"]);
      await browser.pause(200);
      expect(await getLastInputLine()).toContain("G");
    });

    it("a sequence of characters all appear on the input line", async () => {
      await focusTerminal();
      await typeInTerminal("Get-H");
      await browser.pause(100);
      expect(await getLastInputLine()).toContain("Get-H");
    });

    it("Backspace deletes the last typed character", async () => {
      await focusTerminal();
      await typeInTerminal("ab");
      await browser.pause(100);
      await browser.keys(["\uE003"]); // WebDriver Backspace
      await browser.pause(150);

      const line = await getLastInputLine();
      expect(line).toContain("a");
      expect(line).not.toContain("ab");
    });

    it("pressing Enter on an empty buffer shows a new prompt without errors", async () => {
      await focusTerminal();
      await submitInput(); // uses JS helper — tests the empty-Enter path
      await browser.pause(400);

      await waitForPrompt(PROMPT_TIMEOUT);
      const snippet = await getTerminalContent(10);
      expect(snippet).not.toContain("[Error");
      expect(snippet).not.toContain("[Failed");
    });

    /**
     * REGRESSION TEST — "Typing in the terminal no longer works"
     *
     * Sends the Enter key via the WebDriver keyboard API which generates a
     * trusted OS-level keydown event.  xterm's keydown handler converts
     * key='Return' to '\r' and its onData callback submits the command.
     *
     * IF THIS TEST FAILS: the keyboard Enter path is broken.
     * The session-ready flag (test above) and the submitInput() tests will
     * still pass, confirming the issue is specifically the keyboard routing
     * from WebView2 → xterm→ onData, not command execution itself.
     */
    it("keyboard Enter (browser.keys) submits the command and shows output", async () => {
      const marker = "PSFORGE_KEYBOARD_ENTER_REGRESSION";
      await focusTerminal();
      await typeInTerminal(`Write-Host ${marker}`);
      await browser.pause(100);

      // '\uE006' is the WebDriver Return key code — produces a trusted keydown
      // with key='Return' that xterm must convert to '\r' in its onData handler.
      await browser.keys(["\uE006"]);

      await browser.waitUntil(
        async () => (await getTerminalContent()).includes(marker),
        {
          timeout: COMMAND_OUTPUT_TIMEOUT,
          interval: 300,
          timeoutMsg:
            `"${marker}" never appeared — keyboard Enter is not reaching xterm's onData handler. ` +
            `The input char typing tests pass, confirming onData works for regular characters. ` +
            `The bug is in the keydown→onData path for the Enter key in WebView2.`,
        },
      );

      expect(await getTerminalContent()).toContain(marker);
    });

    it("Ctrl+C cancels pending input and echoes ^C", async () => {
      await focusTerminal();
      await typeInTerminal("partial");
      await browser.pause(100);

      // browser.keys(['Control','c']) is sent as a trusted OS key event.
      // WebView2 may intercept this for clipboard copy; if so, this test fails
      // and that interception is itself the bug to fix.
      await browser.keys(["Control", "c"]);
      await browser.pause(400);

      expect(await getTerminalContent()).toContain("^C");
      await waitForPrompt(PROMPT_TIMEOUT);
    });
  });

  // ── Command Execution ─────────────────────────────────────────────────────

  describe("Command Execution", () => {
    it("Write-Host output appears in the buffer", async () => {
      const marker = "PSFORGE_E2E_OUTPUT_TEST";
      await focusTerminal();
      await typeInTerminal(`Write-Host ${marker}`);
      await browser.pause(100);
      await submitInput();

      await browser.waitUntil(
        async () => (await getTerminalContent()).includes(marker),
        {
          timeout: COMMAND_OUTPUT_TIMEOUT,
          interval: 300,
          timeoutMsg: `"${marker}" never appeared in terminal output`,
        },
      );
      expect(await getTerminalContent()).toContain(marker);
    });

    it("a command that errors still shows output and a new prompt", async () => {
      const marker = "PSFORGE_E2E_STDERR";
      await focusTerminal();
      await typeInTerminal(`Write-Error ${marker}`);
      await browser.pause(100);
      await submitInput();

      await browser.waitUntil(
        async () => (await getTerminalContent()).includes(marker),
        {
          timeout: COMMAND_OUTPUT_TIMEOUT,
          interval: 300,
          timeoutMsg: `"${marker}" never appeared in output`,
        },
      );
      expect(await getTerminalContent()).toContain(marker);
      await waitForPrompt(PROMPT_TIMEOUT);
    });

    it("cls clears the screen, removing prior content", async () => {
      await focusTerminal();
      await typeInTerminal("Write-Host BEFORE_CLS");
      await browser.pause(100);
      await submitInput();
      await browser.waitUntil(
        async () => (await getTerminalContent()).includes("BEFORE_CLS"),
        {
          timeout: COMMAND_OUTPUT_TIMEOUT,
          interval: 300,
          timeoutMsg: "BEFORE_CLS did not appear",
        },
      );

      await resetToPrompt();
      await focusTerminal();
      await typeInTerminal("cls");
      await browser.pause(100);
      await submitInput();
      await browser.pause(600);

      expect(await getTerminalContent(20)).not.toContain("BEFORE_CLS");
      await waitForPrompt(PROMPT_TIMEOUT);
    });

    it("a command using PS variables produces the correct output", async () => {
      await focusTerminal();
      await typeInTerminal('$x = 55; Write-Host "RESULT_$x"');
      await browser.pause(100);
      await submitInput();

      await browser.waitUntil(
        async () => (await getTerminalContent()).includes("RESULT_55"),
        {
          timeout: COMMAND_OUTPUT_TIMEOUT,
          interval: 300,
          timeoutMsg: "RESULT_55 never appeared",
        },
      );
      expect(await getTerminalContent()).toContain("RESULT_55");
    });
  });

  // ── Command History ───────────────────────────────────────────────────────

  describe("Command History", () => {
    it("Up arrow recalls the most recently executed command", async () => {
      const cmd = "Write-Host PSFORGE_HISTORY_SEED";
      await focusTerminal();
      await typeInTerminal(cmd);
      await browser.pause(100);
      await submitInput();
      await browser.waitUntil(
        async () =>
          (await getTerminalContent()).includes("PSFORGE_HISTORY_SEED"),
        {
          timeout: COMMAND_OUTPUT_TIMEOUT,
          interval: 300,
          timeoutMsg: "history seed command never ran",
        },
      );

      await resetToPrompt();
      await focusTerminal();
      await browser.keys(["\uE013"]); // WebDriver ArrowUp
      await browser.pause(200);

      expect(await getLastInputLine()).toContain(
        "Write-Host PSFORGE_HISTORY_SEED",
      );
    });

    it("Down arrow after Up arrow returns the input to empty", async () => {
      await focusTerminal();
      await browser.keys(["\uE013"]); // ArrowUp
      await browser.pause(150);
      await browser.keys(["\uE015"]); // ArrowDown
      await browser.pause(150);

      expect(await getLastInputLine()).toMatch(/PS.*>\s*$/);
    });
  });

  // ── CWD in Prompt ──────────────────────────────────────────────────────────

  describe("CWD in Prompt", () => {
    it("prompt shows a real path once the session is ready", async () => {
      await waitForPrompt(TERMINAL_READY_TIMEOUT);
      const content = await getTerminalContent();
      // The prompt should contain a real directory path (contains a colon on Windows)
      const promptLine = content
        .split("\n")
        .find((l) => l.includes("PS") && l.includes(">"));
      expect(promptLine).toBeDefined();
      expect(promptLine).toMatch(/[A-Za-z]:[\\|/]/);
    });

    it("prompt path updates after a Set-Location command", async () => {
      const before = await getTerminalContent();
      const beforePrompt =
        before
          .split("\n")
          .reverse()
          .find((l) => l.includes("PS") && l.includes(">")) ?? "";

      await focusTerminal();
      await typeInTerminal("Set-Location $env:TEMP");
      await browser.pause(100);
      await submitInput();
      await waitForPrompt(COMMAND_OUTPUT_TIMEOUT);

      await browser.waitUntil(
        async () => {
          const c = await getTerminalContent();
          const lines = c.split("\n").reverse();
          const latest =
            lines.find((l) => l.includes("PS") && l.includes(">")) ?? "";
          return (
            latest.toLowerCase().includes("temp") && latest !== beforePrompt
          );
        },
        {
          timeout: 5000,
          interval: 200,
          timeoutMsg: "Prompt did not update to show $env:TEMP",
        },
      );

      const after = await getTerminalContent();
      const afterPrompt =
        after
          .split("\n")
          .reverse()
          .find((l) => l.includes("PS") && l.includes(">")) ?? "";
      expect(afterPrompt.toLowerCase()).toContain("temp");
    });
  });
});
