/**
 * E2E Tests: Syntax Highlighting
 *
 * Verifies two independent highlighting systems:
 *
 *  1. Terminal input highlighter (highlightPs)
 *     A pure tokeniser function exposed on window.__psforge_highlight_ps.
 *     Tests call it directly via browser.execute() and assert that the
 *     returned string contains the expected ANSI 24-bit colour sequences.
 *     No terminal session startup is required for these tests.
 *
 *  2. Monaco editor token colours
 *     The dark and light themes now declare explicit PowerShell token rules
 *     (keywords, variables, strings, comments, numbers, types).
 *     Tests type a small PS snippet into the editor, wait for Monaco to
 *     tokenise it, then read getComputedStyle().color on individual token
 *     spans to confirm the correct colour is applied.
 *
 * Run: npm run test:e2e:syntax-highlighting
 */

export {};

// ── Timeout constants ─────────────────────────────────────────────────────────
const RENDER_TIMEOUT = 8000;

// ── ANSI colour codes produced by highlightPs (24-bit, matching Dark+ palette) ─
//   Format: \x1b[38;2;R;G;Bm
const ANSI_KEYWORD = "\x1b[38;2;86;156;214m"; // #569cd6
const ANSI_CMDLET = "\x1b[38;2;220;220;170m"; // #dcdcaa  (Verb-Noun commands)
const ANSI_VARIABLE = "\x1b[38;2;156;220;254m"; // #9cdcfe
const ANSI_STRING = "\x1b[38;2;206;145;120m"; // #ce9178
const ANSI_COMMENT = "\x1b[38;2;106;153;85m"; // #6a9955
const ANSI_NUMBER = "\x1b[38;2;181;206;168m"; // #b5cea8
const ANSI_RESET = "\x1b[0m";

// ── Expected Monaco rendered colours (CSS rgb() strings) ─────────────────────
// Dark theme
const RGB_DARK_KEYWORD = "rgb(86, 156, 214)"; // #569cd6
const RGB_DARK_CMDLET = "rgb(220, 220, 170)"; // #dcdcaa
const RGB_DARK_PARAM = "rgb(156, 220, 254)"; // #9cdcfe (same as variable)
const RGB_DARK_VARIABLE = "rgb(156, 220, 254)"; // #9cdcfe
const RGB_DARK_STRING = "rgb(206, 145, 120)"; // #ce9178
// Light theme
const RGB_LIGHT_KEYWORD = "rgb(0, 0, 255)"; // #0000ff
const RGB_LIGHT_CMDLET = "rgb(121, 94, 38)"; // #795e26
// ISE Classic theme
const RGB_ISE_KEYWORD = "rgb(255, 255, 0)"; // #ffff00
const RGB_ISE_CMDLET = "rgb(255, 255, 255)"; // #ffffff

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Call window.__psforge_highlight_ps() inside the browser and return the result. */
async function highlight(text: string): Promise<string> {
  return browser.execute((t: string) => {
    const fn = (window as unknown as Record<string, unknown>)
      .__psforge_highlight_ps;
    if (typeof fn !== "function")
      throw new Error("__psforge_highlight_ps not available");
    return (fn as (s: string) => string)(t);
  }, text);
}

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[^m]*m/g, "");
}

/**
 * Type code into the Monaco editor from a clean state.
 * Uses the same «select-all → delete → type char-by-char» pattern as the
 * IntelliSense tests so Monaco's tokeniser has time to process each character.
 */
async function setEditorContent(code: string): Promise<void> {
  const viewLines = await $(".monaco-editor .view-lines");
  await viewLines.click();
  await browser.pause(100);
  await browser.keys(["Escape"]);
  await browser.pause(100);
  await browser.keys(["Control", "a"]);
  await browser.pause(100);
  await browser.keys(["Delete"]);
  await browser.pause(200);
  for (const ch of code) {
    await browser.keys([ch]);
    await browser.pause(40);
  }
  await browser.pause(300);
}

/**
 * Finds the first Monaco view-line span that has an `mtkN` token class
 * AND whose textContent exactly matches `target`, then returns its computed
 * foreground colour as a CSS rgb() string, or null if not found.
 *
 * The wrapper `<span>` that surrounds all token spans on a line has the same
 * textContent as its children combined, but no `mtk` class.  We must skip
 * that wrapper or we'll read the inherited (default-foreground) colour instead
 * of the token-specific colour.
 */
async function getTokenColor(target: string): Promise<string | null> {
  return browser.execute((t: string) => {
    const spans = Array.from(
      document.querySelectorAll(".monaco-editor .view-lines span"),
    ) as HTMLSpanElement[];
    // Only consider spans that carry an mtk colour class — skip wrapper spans.
    const span = spans.find(
      (s) => s.textContent === t && /\bmtk\d+\b/.test(s.className),
    );
    return span ? getComputedStyle(span).color : null;
  }, target);
}

/**
 * Polls getTokenColor until it returns a non-null value or the timeout expires.
 * If `expectedColor` is supplied, continues polling until that specific colour
 * is seen — useful after a theme switch where the CSS may briefly show stale
 * colours from the previous theme.
 */
async function waitForTokenColor(
  target: string,
  timeoutMs = RENDER_TIMEOUT,
  expectedColor?: string,
): Promise<string | null> {
  let color: string | null = null;
  await browser.waitUntil(
    async () => {
      color = await getTokenColor(target);
      if (expectedColor !== undefined) {
        return color === expectedColor;
      }
      return color !== null;
    },
    {
      timeout: timeoutMs,
      interval: 200,
      timeoutMsg: expectedColor
        ? `Token span for "${target}" never reached colour ${expectedColor} (last: ${color})`
        : `Token span for "${target}" never appeared in Monaco view-lines`,
    },
  );
  return color;
}

/** Switch the app theme via the Settings panel and close it. */
async function switchTheme(
  themeName: "Dark" | "Light" | "PS ISE Classic",
): Promise<void> {
  await (await $('[data-testid="toolbar-settings"]')).click();
  await browser.waitUntil(
    async () => (await $('[data-testid="settings-panel"]')).isDisplayed(),
    { timeout: 5000, interval: 100, timeoutMsg: "Settings panel did not open" },
  );
  await (await $('[data-testid="settings-nav-appearance"]')).click();
  await browser.pause(150);
  const sel = await $('[data-testid="settings-theme"]');
  await sel.selectByVisibleText(themeName);
  await browser.pause(300);
  await (await $('[data-testid="settings-close"]')).click();
  await browser.waitUntil(
    async () =>
      !(await (await $('[data-testid="settings-panel"]')).isExisting()),
    {
      timeout: 5000,
      interval: 100,
      timeoutMsg: "Settings panel did not close",
    },
  );
  await browser.pause(200);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Syntax Highlighting", () => {
  // ── Terminal: highlightPs tokeniser ────────────────────────────────────────

  describe("Terminal: highlightPs tokeniser", () => {
    it("window.__psforge_highlight_ps is exposed", async () => {
      const available = await browser.execute(
        () =>
          typeof (window as unknown as Record<string, unknown>)
            .__psforge_highlight_ps === "function",
      );
      expect(available).toBe(true);
    });

    it("wraps keywords in the keyword ANSI colour", async () => {
      for (const kw of [
        "if",
        "else",
        "foreach",
        "function",
        "return",
        "try",
        "catch",
      ]) {
        const result = await highlight(kw);
        expect(result).toContain(ANSI_KEYWORD);
        expect(result).toContain(ANSI_RESET);
        expect(stripAnsi(result)).toBe(kw);
      }
    });

    it("wraps $variables in the variable ANSI colour", async () => {
      const result = await highlight("$myVar");
      expect(result).toContain(ANSI_VARIABLE);
      expect(result).toContain(ANSI_RESET);
      expect(stripAnsi(result)).toBe("$myVar");
    });

    it("wraps ${braced} variable in the variable ANSI colour", async () => {
      const result = await highlight("${env:PATH}");
      expect(result).toContain(ANSI_VARIABLE);
      expect(stripAnsi(result)).toBe("${env:PATH}");
    });

    it("wraps double-quoted strings in the string ANSI colour", async () => {
      const result = await highlight('"hello world"');
      expect(result).toContain(ANSI_STRING);
      expect(result).toContain(ANSI_RESET);
      expect(stripAnsi(result)).toBe('"hello world"');
    });

    it("wraps single-quoted strings in the string ANSI colour", async () => {
      const result = await highlight("'literal string'");
      expect(result).toContain(ANSI_STRING);
      expect(stripAnsi(result)).toBe("'literal string'");
    });

    it("wraps # comments in the comment ANSI colour — rest of token is consumed", async () => {
      const result = await highlight("# this is a comment");
      expect(result).toContain(ANSI_COMMENT);
      expect(result).toContain(ANSI_RESET);
      expect(stripAnsi(result)).toBe("# this is a comment");
    });

    it("wraps inline # comment portion in comment colour in a mixed line", async () => {
      const result = await highlight("Write-Host hi # comment part");
      expect(result).toContain(ANSI_COMMENT);
      // The cmdlet name before the comment should NOT contain comment colour
      const commentIdx = result.indexOf(ANSI_COMMENT);
      const prefix = result.slice(0, commentIdx);
      expect(prefix).toContain("Write-Host");
    });

    it("wraps -parameters in the keyword ANSI colour", async () => {
      for (const param of ["-Path", "-eq", "-like", "-Force", "-Recurse"]) {
        const result = await highlight(param);
        expect(result).toContain(ANSI_KEYWORD);
        expect(stripAnsi(result)).toBe(param);
      }
    });

    it("wraps integers in the number ANSI colour", async () => {
      const result = await highlight("42");
      expect(result).toContain(ANSI_NUMBER);
      expect(stripAnsi(result)).toBe("42");
    });

    it("wraps decimal numbers in the number ANSI colour", async () => {
      const result = await highlight("3.14");
      expect(result).toContain(ANSI_NUMBER);
      expect(stripAnsi(result)).toBe("3.14");
    });

    it("wraps Verb-Noun cmdlet names in the cmdlet ANSI colour", async () => {
      // Cmdlets follow the Verb-Noun convention and are highlighted with a
      // dedicated colour (#dcdcaa) separate from keywords and variables.
      const result = await highlight("Write-Host");
      expect(result).toContain(ANSI_CMDLET);
      expect(stripAnsi(result)).toBe("Write-Host");
    });

    it("wraps multi-segment cmdlet names (Invoke-WebRequest) in the cmdlet ANSI colour", async () => {
      const result = await highlight("Invoke-WebRequest");
      expect(result).toContain(ANSI_CMDLET);
      expect(stripAnsi(result)).toBe("Invoke-WebRequest");
    });

    it("wraps Get-ChildItem in the cmdlet ANSI colour", async () => {
      const result = await highlight("Get-ChildItem");
      expect(result).toContain(ANSI_CMDLET);
      expect(stripAnsi(result)).toBe("Get-ChildItem");
    });

    it("stripping ANSI from highlighted output always recovers the original text", async () => {
      const samples = [
        'if ($x -eq 42) { "hello" }',
        "foreach ($item in $list) { Write-Host $item }",
        '$result = Get-ChildItem -Path "C:\\\\Temp" -Recurse # get files',
        "function Invoke-Thing { param([string]$s) $s.ToUpper() }",
        "3.14 -lt 6.28",
      ];
      for (const s of samples) {
        const result = await highlight(s);
        expect(stripAnsi(result)).toBe(s);
      }
    });

    it("highlights a complete mixed expression with multiple token types", async () => {
      // if ($count -gt 0) { "found" } # check
      const result = await highlight('if ($count -gt 0) { "found" } # check');
      expect(result).toContain(ANSI_KEYWORD); // 'if' keyword
      expect(result).toContain(ANSI_VARIABLE); // $count
      expect(result).toContain(ANSI_NUMBER); // 0
      expect(result).toContain(ANSI_STRING); // "found"
      expect(result).toContain(ANSI_COMMENT); // # check
      expect(result).toContain(ANSI_RESET);
      expect(stripAnsi(result)).toBe('if ($count -gt 0) { "found" } # check');
    });

    it("highlights a command line with cmdlet + parameter + variable", async () => {
      // Write-Host $greeting -ForegroundColor Green
      const result = await highlight(
        "Write-Host $greeting -ForegroundColor Green",
      );
      expect(result).toContain(ANSI_CMDLET); // Write-Host
      expect(result).toContain(ANSI_VARIABLE); // $greeting
      expect(result).toContain(ANSI_KEYWORD); // -ForegroundColor (parameter)
      expect(result).toContain(ANSI_RESET);
      expect(stripAnsi(result)).toBe(
        "Write-Host $greeting -ForegroundColor Green",
      );
    });

    it("reset code \\x1b[0m always follows each coloured token", async () => {
      // Every opened colour sequence must be closed — an unclosed sequence
      // would "bleed" into subsequent terminal output.
      const tests = [
        "if",
        "$x",
        '"str"',
        "# comment",
        "-Path",
        "99",
        "Write-Host",
        "Get-ChildItem",
      ];
      for (const t of tests) {
        const result = await highlight(t);
        // Count opens vs resets.
        const opens = (result.match(/\x1b\[38;2;/g) ?? []).length;
        const resets = (result.match(/\x1b\[0m/g) ?? []).length;
        expect(resets).toBeGreaterThanOrEqual(opens);
      }
    });

    it("empty string returns empty string", async () => {
      expect(await highlight("")).toBe("");
    });

    it("plain whitespace passthrough — no ANSI injected", async () => {
      expect(await highlight("   ")).toBe("   ");
    });
  });

  // ── Editor: Monaco token colours ───────────────────────────────────────────

  describe("Editor: Monaco token colours (dark theme)", () => {
    // Ensure dark theme and editor pane are active for this suite.
    before(async () => {
      await switchTheme("Dark");
      // Make sure the editor is focused (not the terminal pane).
      const viewLines = await $(".monaco-editor .view-lines");
      await viewLines.click();
      await browser.pause(100);
    });

    it('"if" keyword token is rendered in the dark keyword colour (#569cd6)', async () => {
      await setEditorContent("if");
      const color = await waitForTokenColor("if");
      expect(color).toBe(RGB_DARK_KEYWORD);
    });

    it('"foreach" keyword token is rendered in the dark keyword colour', async () => {
      await setEditorContent("foreach");
      const color = await waitForTokenColor("foreach");
      expect(color).toBe(RGB_DARK_KEYWORD);
    });

    it('"function" keyword token is rendered in the dark keyword colour', async () => {
      await setEditorContent("function");
      const color = await waitForTokenColor("function");
      expect(color).toBe(RGB_DARK_KEYWORD);
    });

    it("$variable token is rendered in the dark variable colour (#9cdcfe)", async () => {
      await setEditorContent("$myVariable");
      // Monaco may tokenise the $ and the name as separate spans — find either
      // the full "$myVariable" span or the isolated "$" span.
      const color = await waitForTokenColor("$myVariable");
      // Accept null for full span (Monaco may split it) and look for "$" span.
      const finalColor = color ?? (await waitForTokenColor("$"));
      expect(finalColor).toBe(RGB_DARK_VARIABLE);
    });

    it("string token is rendered in the dark string colour (#ce9178)", async () => {
      await setEditorContent('"hello"');
      const color = await waitForTokenColor('"hello"');
      expect(color).toBe(RGB_DARK_STRING);
    });

    it("cmdlet token (Write-Host) is rendered in the dark cmdlet colour (#dcdcaa)", async () => {
      await setEditorContent("Write-Host");
      const color = await waitForTokenColor("Write-Host");
      expect(color).toBe(RGB_DARK_CMDLET);
    });

    it("cmdlet token (Get-ChildItem) is rendered in the dark cmdlet colour", async () => {
      await setEditorContent("Get-ChildItem");
      const color = await waitForTokenColor("Get-ChildItem");
      expect(color).toBe(RGB_DARK_CMDLET);
    });

    it("parameter token (-Path) is rendered in the dark parameter colour (#9cdcfe)", async () => {
      await setEditorContent("-Path");
      const color = await waitForTokenColor("-Path");
      expect(color).toBe(RGB_DARK_PARAM);
    });
  });

  // ── Editor: Light theme token colours ─────────────────────────────────────

  describe("Editor: Monaco token colours (light theme)", () => {
    before(async () => {
      await switchTheme("Light");
      const viewLines = await $(".monaco-editor .view-lines");
      await viewLines.click();
      await browser.pause(100);
    });

    after(async () => {
      // Restore dark theme so subsequent suites start in the default state.
      await switchTheme("Dark");
    });

    it('"if" keyword token is rendered in the light keyword colour (#0000ff)', async () => {
      await setEditorContent("if");
      const color = await waitForTokenColor("if");
      expect(color).toBe(RGB_LIGHT_KEYWORD);
    });

    it("light keyword colour is distinct from dark keyword colour", async () => {
      await setEditorContent("if");
      const lightColor = await waitForTokenColor("if");
      expect(lightColor).not.toBe(RGB_DARK_KEYWORD);
    });

    it("cmdlet token (Write-Host) is rendered in the light cmdlet colour (#795e26)", async () => {
      await setEditorContent("Write-Host");
      const color = await waitForTokenColor("Write-Host");
      expect(color).toBe(RGB_LIGHT_CMDLET);
    });
  });

  // ── Editor: ISE Classic theme token colours ────────────────────────────────

  describe("Editor: Monaco token colours (PS ISE Classic theme)", () => {
    before(async () => {
      await switchTheme("PS ISE Classic");
      const viewLines = await $(".monaco-editor .view-lines");
      await viewLines.click();
      await browser.pause(100);
    });

    after(async () => {
      await switchTheme("Dark");
    });

    it('"if" keyword token is rendered in ISE yellow (#ffff00)', async () => {
      await setEditorContent("if");
      // Poll specifically for ISE yellow — the CSS may briefly show the
      // previous theme's colour until Monaco regenerates the mtk rules.
      const color = await waitForTokenColor(
        "if",
        RENDER_TIMEOUT,
        RGB_ISE_KEYWORD,
      );
      expect(color).toBe(RGB_ISE_KEYWORD);
    });
    it("cmdlet token (Write-Host) is rendered in ISE white (#ffffff)", async () => {
      await setEditorContent("Write-Host");
      const color = await waitForTokenColor(
        "Write-Host",
        RENDER_TIMEOUT,
        RGB_ISE_CMDLET,
      );
      expect(color).toBe(RGB_ISE_CMDLET);
    });
  });
});
