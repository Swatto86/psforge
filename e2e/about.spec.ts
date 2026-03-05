/**
 * E2E Tests: About Dialog
 *
 * Verifies the About modal end-to-end:
 *  - Toolbar "About PS Forge" button is present
 *  - Dialog opens when the button is clicked
 *  - All expected content elements are visible (title, version, description,
 *    developer credit, GitHub link, tech stack)
 *  - Close button dismisses the dialog
 *  - Escape key dismisses the dialog
 *  - Clicking the backdrop dismisses the dialog
 *  - Dialog is not visible until the button is clicked
 *
 * Run: npm run test:e2e:about
 */

// ── Timeout constants ─────────────────────────────────────────────────────────
const DIALOG_OPEN_TIMEOUT  = 5000;
const DIALOG_CLOSE_TIMEOUT = 5000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Open the About dialog via the toolbar button. */
async function openAbout(): Promise<void> {
  const btn = await $('[data-testid="toolbar-about"]');
  await btn.click();
  await browser.waitUntil(
    async () => (await $('[data-testid="about-dialog"]')).isDisplayed(),
    {
      timeout: DIALOG_OPEN_TIMEOUT,
      interval: 100,
      timeoutMsg: 'About dialog did not appear after clicking toolbar-about button',
    }
  );
}

/** Close the About dialog via the Close button. */
async function closeAboutViaButton(): Promise<void> {
  const btn = await $('[data-testid="about-dialog-close"]');
  await btn.click();
  await browser.waitUntil(
    async () => !(await (await $('[data-testid="about-dialog"]')).isExisting()),
    {
      timeout: DIALOG_CLOSE_TIMEOUT,
      interval: 100,
      timeoutMsg: 'About dialog did not close after clicking close button',
    }
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('About Dialog', () => {

  describe('Toolbar button', () => {
    it('should display the About button in the toolbar', async () => {
      const btn = await $('[data-testid="toolbar-about"]');
      await expect(btn).toBeDisplayed();
    });

    it('should have the correct tooltip text on the About button', async () => {
      const btn = await $('[data-testid="toolbar-about"]');
      const title = await btn.getAttribute('title');
      expect(title).toBe('About PS Forge');
    });
  });

  describe('Opening', () => {
    it('should not show the About dialog before the button is clicked', async () => {
      const dialog = await $('[data-testid="about-dialog"]');
      const exists = await dialog.isExisting();
      expect(exists).toBe(false);
    });

    it('should show the About dialog when the toolbar button is clicked', async () => {
      await openAbout();
      const dialog = await $('[data-testid="about-dialog"]');
      await expect(dialog).toBeDisplayed();
      await closeAboutViaButton();
    });
  });

  describe('Content', () => {
    before(async () => {
      await openAbout();
    });
    after(async () => {
      await closeAboutViaButton();
    });

    it('should display the app title containing "PS Forge"', async () => {
      const title = await $('[data-testid="about-dialog-title"]');
      await expect(title).toBeDisplayed();
      const text = await title.getText();
      expect(text).toContain('PS Forge');
    });

    it('should display a version number', async () => {
      const ver = await $('[data-testid="about-dialog-version"]');
      await expect(ver).toBeDisplayed();
      const text = await ver.getText();
      // Version should start with "v" followed by semver digits.
      expect(text).toMatch(/^v\d+\.\d+\.\d+/);
    });

    it('should display the description text', async () => {
      const desc = await $('[data-testid="about-dialog-description"]');
      await expect(desc).toBeDisplayed();
      const text = await desc.getText();
      expect(text.toLowerCase()).toContain('powershell');
    });

    it('should display the developer credit containing "Swatto"', async () => {
      const dev = await $('[data-testid="about-dialog-developer"]');
      await expect(dev).toBeDisplayed();
      const text = await dev.getText();
      expect(text).toContain('Swatto');
    });

    it('should display the GitHub link', async () => {
      const link = await $('[data-testid="about-dialog-github-link"]');
      await expect(link).toBeDisplayed();
      const text = await link.getText();
      expect(text.toLowerCase()).toContain('github');
    });

    it('should display the tech stack info containing "Tauri"', async () => {
      const tech = await $('[data-testid="about-dialog-tech"]');
      await expect(tech).toBeDisplayed();
      const text = await tech.getText();
      expect(text).toContain('Tauri');
    });

    it('should display the Close button', async () => {
      const closeBtn = await $('[data-testid="about-dialog-close"]');
      await expect(closeBtn).toBeDisplayed();
      await expect(closeBtn).toBeClickable();
    });

    it('should have a backdrop element', async () => {
      const backdrop = await $('[data-testid="about-dialog-backdrop"]');
      await expect(backdrop).toBeDisplayed();
    });
  });

  describe('Closing', () => {
    it('should close the dialog when the Close button is clicked', async () => {
      await openAbout();
      await closeAboutViaButton();
      const dialog = await $('[data-testid="about-dialog"]');
      const exists = await dialog.isExisting();
      expect(exists).toBe(false);
    });

    it('should close the dialog when the Escape key is pressed', async () => {
      await openAbout();
      await browser.keys('Escape');
      await browser.waitUntil(
        async () => !(await (await $('[data-testid="about-dialog"]')).isExisting()),
        {
          timeout: DIALOG_CLOSE_TIMEOUT,
          interval: 100,
          timeoutMsg: 'About dialog did not close after pressing Escape',
        }
      );
      const dialog = await $('[data-testid="about-dialog"]');
      expect(await dialog.isExisting()).toBe(false);
    });

    it('should close the dialog when clicking the backdrop', async () => {
      await openAbout();
      // Click a region outside the card but inside the backdrop.
      // Use execute to click at the very edge of the backdrop where no card is.
      await browser.execute(() => {
        const backdrop = document.querySelector('[data-testid="about-dialog-backdrop"]') as HTMLElement | null;
        if (!backdrop) return;
        // Simulate a click event directly on the backdrop element itself.
        const rect = backdrop.getBoundingClientRect();
        // Top-left corner of the backdrop is outside the centred card.
        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 10,
          clientY: rect.top + 10,
        });
        backdrop.dispatchEvent(clickEvent);
      });
      await browser.waitUntil(
        async () => !(await (await $('[data-testid="about-dialog"]')).isExisting()),
        {
          timeout: DIALOG_CLOSE_TIMEOUT,
          interval: 100,
          timeoutMsg: 'About dialog did not close after clicking backdrop',
        }
      );
      expect(await (await $('[data-testid="about-dialog"]')).isExisting()).toBe(false);
    });

    it('should be openable again after being closed', async () => {
      await openAbout();
      await closeAboutViaButton();
      await openAbout();
      const dialog = await $('[data-testid="about-dialog"]');
      await expect(dialog).toBeDisplayed();
      await closeAboutViaButton();
    });
  });
});
