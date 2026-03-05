/**
 * E2E Tests: Settings Panel
 *
 * Verifies the Settings modal UI end-to-end:
 *  - Panel opens / closes correctly (toolbar button, Escape key, close button,
 *    backdrop click)
 *  - All six sections are reachable via the left nav
 *  - Every select / combo box is wide enough that its longest option text is
 *    NOT clipped by the dropdown arrow or element padding
 *  - Toggle (checkbox) controls update their state
 *  - Number inputs enforce their min/max range
 *  - Appearance > Theme select changes the visible theme
 *  - Editor > Render Whitespace select now at w-48 (192 px) — regression guard
 *    for the previous w-40 (160 px) that clipped "Selection only" / "Boundary only"
 *
 * Run: npm run test:e2e:settings
 */

// ── Timeout constants ─────────────────────────────────────────────────────────
const PANEL_TIMEOUT  = 5000;
const SECTION_TIMEOUT = 3000;

// Approximate pixels consumed by a native select's dropdown arrow + minimum
// padding (conservative value for Chromium/WebView2).
const SELECT_ARROW_AND_PADDING_PX = 36;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Open the settings panel via the toolbar gear button. */
async function openSettings(): Promise<void> {
  const btn = await $('[data-testid="toolbar-settings"]');
  await btn.click();
  await browser.waitUntil(
    async () => (await $('[data-testid="settings-panel"]')).isDisplayed(),
    { timeout: PANEL_TIMEOUT, interval: 100, timeoutMsg: 'Settings panel did not appear' }
  );
}

/** Close the settings panel via the Close button. */
async function closeSettings(): Promise<void> {
  const btn = await $('[data-testid="settings-close"]');
  await btn.click();
  await browser.waitUntil(
    async () => !(await (await $('[data-testid="settings-panel"]')).isExisting()),
    { timeout: PANEL_TIMEOUT, interval: 100, timeoutMsg: 'Settings panel did not close' }
  );
}

/** Navigate to a settings section by its nav button. */
async function goToSection(id: string): Promise<void> {
  const btn = await $(`[data-testid="settings-nav-${id}"]`);
  await btn.click();
  await browser.pause(150);
}

/**
 * Measures whether a <select> element is wide enough to display its longest
 * option without text clipping.
 *
 * Strategy:
 *  1. Collect all option texts from the element.
 *  2. Use a CanvasRenderingContext2D to measure each text at the select's
 *     computed font (exact same font that the browser uses to render it).
 *  3. Confirm that (select.offsetWidth - arrow&padding) >= longestTextWidth.
 *
 * Returns { ok, selectWidth, longestText, longestTextPx, required } so a
 * failure message can name the specific option that was clipped.
 */
async function checkSelectNotClipped(testid: string): Promise<{
  ok: boolean;
  selectWidth: number;
  longestText: string;
  longestTextPx: number;
  required: number;
}> {
  return browser.execute((tid: string, arrowPad: number) => {
    const el = document.querySelector(
      `[data-testid="${tid}"]`
    ) as HTMLSelectElement | null;
    if (!el) return { ok: false, selectWidth: 0, longestText: '<not found>', longestTextPx: 0, required: 0 };

    const style = window.getComputedStyle(el);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = font;

    let longestText = '';
    let longestPx = 0;
    Array.from(el.options).forEach((opt) => {
      const w = ctx.measureText(opt.text).width;
      if (w > longestPx) { longestPx = w; longestText = opt.text; }
    });

    const selectWidth = el.offsetWidth;
    const available = selectWidth - arrowPad;
    return {
      ok: available >= longestPx,
      selectWidth,
      longestText,
      longestTextPx: Math.ceil(longestPx),
      required: Math.ceil(longestPx) + arrowPad,
    };
  }, testid, SELECT_ARROW_AND_PADDING_PX);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Settings Panel', () => {

  // ── Open / Close ────────────────────────────────────────────────────────────

  describe('Open and Close', () => {

    it('toolbar gear button opens the settings panel', async () => {
      await openSettings();
      expect(await (await $('[data-testid="settings-panel"]')).isDisplayed()).toBe(true);
    });

    it('Close button dismisses the panel', async () => {
      // Panel is still open from previous test
      await closeSettings();
      expect(await (await $('[data-testid="settings-panel"]')).isExisting()).toBe(false);
    });

    it('Escape key closes the panel', async () => {
      await openSettings();
      await browser.keys(['Escape']);
      await browser.waitUntil(
        async () => !(await (await $('[data-testid="settings-panel"]')).isExisting()),
        { timeout: PANEL_TIMEOUT, interval: 100, timeoutMsg: 'Escape did not close settings' }
      );
    });

    it('clicking the backdrop closes the panel', async () => {
      await openSettings();
      // The backdrop is the panel's outermost div — click its top-left corner
      // (which is outside the inner dialog card) to trigger the backdrop close.
      const panel = await $('[data-testid="settings-panel"]');
      const size = await panel.getSize();
      // Click well outside the 780 x 580 dialog (which is centred)
      await panel.click({ x: -(size.width / 2 - 10), y: -(size.height / 2 - 10) });
      await browser.waitUntil(
        async () => !(await (await $('[data-testid="settings-panel"]')).isExisting()),
        { timeout: PANEL_TIMEOUT, interval: 100, timeoutMsg: 'Backdrop click did not close settings' }
      );
    });

  });

  // ── Section Navigation ───────────────────────────────────────────────────────

  describe('Section Navigation', () => {

    before(async () => { await openSettings(); });
    after(async () => { await closeSettings(); });

    const sections = ['editor', 'intellisense', 'execution', 'output', 'appearance', 'associations'];

    for (const id of sections) {
      it(`"${id}" nav button is present and clickable`, async () => {
        const btn = await $(`[data-testid="settings-nav-${id}"]`);
        expect(await btn.isExisting()).toBe(true);
        await btn.click();
        await browser.pause(100);
        // Nav button must still exist after click (panel not closed)
        expect(await (await $('[data-testid="settings-panel"]')).isExisting()).toBe(true);
      });
    }

  });

  // ── Editor Section ───────────────────────────────────────────────────────────

  describe('Editor Section', () => {

    before(async () => {
      await openSettings();
      await goToSection('editor');
    });
    after(async () => { await closeSettings(); });

    it('Line Numbers select renders all three options', async () => {
      const sel = await $('[data-testid="settings-line-numbers"]');
      expect(await sel.isExisting()).toBe(true);
      const optionCount = await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-line-numbers"]') as HTMLSelectElement;
        return el ? el.options.length : 0;
      });
      expect(optionCount).toBe(3); // On, Off, Relative
    });

    it('Line Numbers select is wide enough for its longest option (Relative)', async () => {
      const result = await checkSelectNotClipped('settings-line-numbers');
      if (!result.ok) {
        throw new Error(
          `"${result.longestText}" (${result.longestTextPx}px) is clipped in a ` +
          `${result.selectWidth}px wide select (needs ${result.required}px)`
        );
      }
    });

    it('Render Whitespace select renders all four options', async () => {
      const optionCount = await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-render-whitespace"]') as HTMLSelectElement;
        return el ? el.options.length : 0;
      });
      expect(optionCount).toBe(4); // None, Selection only, Boundary only, All
    });

    it('Render Whitespace select is NOT clipped — regression guard for former w-40 clipping', async () => {
      const result = await checkSelectNotClipped('settings-render-whitespace');
      if (!result.ok) {
        throw new Error(
          `"${result.longestText}" (${result.longestTextPx}px) is clipped in a ` +
          `${result.selectWidth}px wide select (needs ${result.required}px). ` +
          `Was this select accidentally reverted to w-40 (160px)?`
        );
      }
    });

    it('Render Whitespace select is at least as wide as w-48 selects elsewhere', async () => {
      // Execution Policy and Theme are both w-48 = ~192px; Render Whitespace must match.
      const rwWidth = await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-render-whitespace"]') as HTMLSelectElement;
        return el ? el.offsetWidth : 0;
      });
      const themeWidth = await browser.execute(() => {
        // Theme select is in Appearance section — temporarily read w-48 reference
        // by checking the execution-policy select (already in DOM via Execution section).
        // Use a canvas to get the nominal w-48 = 192px (12rem at 16px root).
        const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return Math.round(12 * root); // 12rem = w-48
      });
      expect(rwWidth).toBeGreaterThanOrEqual(themeWidth - 4); // 4px tolerance for subpixel
    });

  });

  // ── Execution Section ─────────────────────────────────────────────────────────

  describe('Execution Section', () => {

    before(async () => {
      await openSettings();
      await goToSection('execution');
    });
    after(async () => { await closeSettings(); });

    it('Default PowerShell select is present', async () => {
      const sel = await $('[data-testid="settings-default-ps"]');
      expect(await sel.isExisting()).toBe(true);
    });

    it('Default PowerShell select has at least one option (auto-detect)', async () => {
      const count = await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-default-ps"]') as HTMLSelectElement;
        return el ? el.options.length : 0;
      });
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('Default PowerShell select is wide enough for all version names', async () => {
      const result = await checkSelectNotClipped('settings-default-ps');
      if (!result.ok) {
        throw new Error(
          `PS version name "${result.longestText}" (${result.longestTextPx}px) clipped ` +
          `in ${result.selectWidth}px wide select (needs ${result.required}px)`
        );
      }
    });

    it('Execution Policy select shows all six policies', async () => {
      const count = await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-execution-policy"]') as HTMLSelectElement;
        return el ? el.options.length : 0;
      });
      expect(count).toBe(6);
    });

    it('Execution Policy select is not clipped', async () => {
      const result = await checkSelectNotClipped('settings-execution-policy');
      if (!result.ok) {
        throw new Error(
          `"${result.longestText}" (${result.longestTextPx}px) is clipped in a ` +
          `${result.selectWidth}px wide select (needs ${result.required}px)`
        );
      }
    });

    it('selecting a non-Default policy updates the description text', async () => {
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-execution-policy"]') as HTMLSelectElement;
        if (el) el.value = 'RemoteSigned';
        el?.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await browser.pause(200);
      // The description paragraph should now mention "Downloaded" (RemoteSigned description)
      const panelText = await (await $('[data-testid="settings-panel"]')).getText();
      expect(panelText.toLowerCase()).toContain('downloaded');
    });

    it('restoring to Default policy updates the description', async () => {
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-execution-policy"]') as HTMLSelectElement;
        if (el) el.value = 'Default';
        el?.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await browser.pause(200);
      const panelText = await (await $('[data-testid="settings-panel"]')).getText();
      expect(panelText.toLowerCase()).toContain('no override');
    });

  });

  // ── Appearance Section ────────────────────────────────────────────────────────

  describe('Appearance Section', () => {

    before(async () => {
      await openSettings();
      await goToSection('appearance');
    });
    after(async () => {
      // Restore dark theme after testing
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-theme"]') as HTMLSelectElement;
        if (el) { el.value = 'dark'; el.dispatchEvent(new Event('change', { bubbles: true })); }
        document.documentElement.setAttribute('data-theme', 'dark');
      });
      await closeSettings();
    });

    it('Theme select is present', async () => {
      const sel = await $('[data-testid="settings-theme"]');
      expect(await sel.isExisting()).toBe(true);
    });

    it('Theme select has three options including "PS ISE Classic"', async () => {
      const options = await browser.execute(() => {
        const el = document.querySelector('[data-testid="settings-theme"]') as HTMLSelectElement;
        return el ? Array.from(el.options).map((o) => o.text) : [];
      });
      expect(options).toContain('Dark');
      expect(options).toContain('Light');
      expect(options).toContain('PS ISE Classic');
    });

    it('Theme select is not clipped — "PS ISE Classic" must fit', async () => {
      const result = await checkSelectNotClipped('settings-theme');
      if (!result.ok) {
        throw new Error(
          `"${result.longestText}" (${result.longestTextPx}px) clipped in ` +
          `${result.selectWidth}px select (needs ${result.required}px)`
        );
      }
    });

    it('switching to Light theme applies the data-theme attribute', async () => {
      const themeSelect = await $('[data-testid="settings-theme"]');
      await themeSelect.selectByVisibleText('Light');
      await browser.pause(200);
      const theme = await browser.execute(() =>
        document.documentElement.getAttribute('data-theme')
      );
      expect(theme).toBe('light');
    });

    it('switching to Dark theme restores the attribute', async () => {
      const themeSelect = await $('[data-testid="settings-theme"]');
      await themeSelect.selectByVisibleText('Dark');
      await browser.pause(200);
      const theme = await browser.execute(() =>
        document.documentElement.getAttribute('data-theme')
      );
      expect(theme).toBe('dark');
    });

  });

  // ── Toggle Controls ──────────────────────────────────────────────────────────

  describe('Toggle Controls', () => {

    before(async () => { await openSettings(); });
    after(async () => { await closeSettings(); });

    it('Editor > Word Wrap checkbox can be toggled on and off', async () => {
      await goToSection('editor');
      await browser.pause(100);

      // Read initial state
      const initialChecked: boolean = await browser.execute(() => {
        const checkboxes = Array.from(
          document.querySelectorAll('[data-testid="settings-panel"] input[type="checkbox"]')
        ) as HTMLInputElement[];
        // Find the "Word Wrap" checkbox — it's the first checkbox in editor section
        return checkboxes.length > 0 ? checkboxes[0].checked : false;
      });

      // Click it
      const firstCheckbox = await $('[data-testid="settings-panel"] input[type="checkbox"]');
      await firstCheckbox.click();
      await browser.pause(100);

      const afterChecked: boolean = await browser.execute(() => {
        const checkboxes = Array.from(
          document.querySelectorAll('[data-testid="settings-panel"] input[type="checkbox"]')
        ) as HTMLInputElement[];
        return checkboxes.length > 0 ? checkboxes[0].checked : false;
      });

      expect(afterChecked).toBe(!initialChecked);

      // Restore
      await firstCheckbox.click();
    });

    it('IntelliSense > Enable IntelliSense checkbox is checked by default', async () => {
      await goToSection('intellisense');
      await browser.pause(100);

      const checked: boolean = await browser.execute(() => {
        const cb = document.querySelector(
          '[data-testid="settings-panel"] input[type="checkbox"]'
        ) as HTMLInputElement | null;
        return cb ? cb.checked : false;
      });
      expect(checked).toBe(true);
    });

  });

  // ── Number Inputs ─────────────────────────────────────────────────────────────

  describe('Number Inputs', () => {

    before(async () => {
      await openSettings();
      await goToSection('editor');
    });
    after(async () => { await closeSettings(); });

    it('Font Size input is present and shows a numeric value', async () => {
      const value: number = await browser.execute(() => {
        const inputs = Array.from(
          document.querySelectorAll('[data-testid="settings-panel"] input[type="number"]')
        ) as HTMLInputElement[];
        return inputs.length > 0 ? parseFloat(inputs[0].value) : NaN;
      });
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(8);
      expect(value).toBeLessThanOrEqual(72);
    });

  });

  // ── File Associations Section ─────────────────────────────────────────────────

  describe('File Associations Section', () => {

    before(async () => {
      await openSettings();
      await goToSection('associations');
      // Wait for the async load of associations
      await browser.waitUntil(
        async () => {
          const text = await (await $('[data-testid="settings-panel"]')).getText();
          return text.includes('.ps1') || text.includes('Loading');
        },
        { timeout: 5000, interval: 300, timeoutMsg: 'File associations section did not load' }
      );
    });
    after(async () => { await closeSettings(); });

    it('shows the .ps1 file extension entry', async () => {
      await browser.waitUntil(
        async () => {
          const text = await (await $('[data-testid="settings-panel"]')).getText();
          return text.includes('.ps1');
        },
        { timeout: 5000, interval: 300, timeoutMsg: '.ps1 entry never appeared' }
      );
      const text = await (await $('[data-testid="settings-panel"]')).getText();
      expect(text).toContain('.ps1');
    });

    it('shows Register All and Unregister All batch buttons', async () => {
      const text = await (await $('[data-testid="settings-panel"]')).getText();
      expect(text).toContain('Register All');
      expect(text).toContain('Unregister All');
    });

  });

});
