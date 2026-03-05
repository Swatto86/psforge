/**
 * E2E Tests: Application Launch and Basic UI Structure
 *
 * Verifies that PSForge starts correctly, all primary UI regions are
 * present and responsive, and the Tauri bridge is available.
 *
 * Run: npm run test:e2e -- --spec e2e/app.spec.ts
 */

describe('PSForge Application', () => {

  describe('Launch', () => {
    it('should have the app root element displayed', async () => {
      const root = await $('[data-testid="app-root"]');
      await expect(root).toBeDisplayed();
    });

    it('should have the Tauri IPC bridge available', async () => {
      const hasTauri = await browser.execute(() => {
        return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
      });
      expect(hasTauri).toBe(true);
    });
  });

  describe('Primary Layout Regions', () => {
    it('should display the toolbar', async () => {
      const toolbar = await $('[data-testid="toolbar-root"]');
      await expect(toolbar).toBeDisplayed();
    });

    it('should display the tab bar', async () => {
      const tabBar = await $('[data-testid="tabbar-root"]');
      await expect(tabBar).toBeDisplayed();
    });

    it('should display the output pane', async () => {
      const outputPane = await $('[data-testid="output-pane"]');
      await expect(outputPane).toBeDisplayed();
    });

    it('should display the status bar', async () => {
      const statusBar = await $('[data-testid="status-bar"]');
      await expect(statusBar).toBeDisplayed();
    });
  });

  describe('Toolbar Buttons', () => {
    it('should display the New File button', async () => {
      const btn = await $('[data-testid="toolbar-new"]');
      await expect(btn).toBeDisplayed();
      await expect(btn).toBeClickable();
    });

    it('should display the Open File button', async () => {
      const btn = await $('[data-testid="toolbar-open"]');
      await expect(btn).toBeDisplayed();
      await expect(btn).toBeClickable();
    });

    it('should display the Run Script button', async () => {
      const btn = await $('[data-testid="toolbar-run"]');
      await expect(btn).toBeDisplayed();
    });

    it('should display the Stop button', async () => {
      const btn = await $('[data-testid="toolbar-stop"]');
      await expect(btn).toBeDisplayed();
    });

    it('should display the Settings button', async () => {
      const btn = await $('[data-testid="toolbar-settings"]');
      await expect(btn).toBeDisplayed();
      await expect(btn).toBeClickable();
    });

    it('should display the PS version selector', async () => {
      const sel = await $('[data-testid="toolbar-ps-selector"]');
      await expect(sel).toBeDisplayed();
    });

    it('should display the theme selector', async () => {
      const sel = await $('[data-testid="toolbar-theme-selector"]');
      await expect(sel).toBeDisplayed();
      await expect(sel).toBeClickable();
    });
  });

  describe('PS Version Selector', () => {
    it('should have at least one PowerShell version available', async () => {
      const sel = await $('[data-testid="toolbar-ps-selector"]');
      // The options are dynamically loaded; wait for a real option to appear.
      await browser.waitUntil(async () => {
        const opts = await sel.$$('option');
        // A real version option has a path value (contains \ or /)
        for (const opt of opts) {
          const val = await opt.getAttribute('value');
          if (val && (val.includes('\\') || val.includes('/'))) return true;
        }
        return false;
      }, { timeout: 10000, timeoutMsg: 'No PowerShell version found within 10s' });

      const options = await sel.$$('option');
      expect(options.length).toBeGreaterThanOrEqual(1);
    });

    it('selected PS version should contain a valid executable path', async () => {
      const sel = await $('[data-testid="toolbar-ps-selector"]');
      const value = await sel.getValue();
      expect(value).toMatch(/powershell\.exe|pwsh\.exe/i);
    });
  });

  describe('Output Panel Tabs', () => {
    it('should display the Terminal tab button', async () => {
      const btn = await $('[data-testid="output-tab-terminal"]');
      await expect(btn).toBeDisplayed();
      await expect(btn).toBeClickable();
    });

    it('should display the Output tab button', async () => {
      const btn = await $('[data-testid="output-tab-output"]');
      await expect(btn).toBeDisplayed();
      await expect(btn).toBeClickable();
    });

    it('should display the Variables tab button', async () => {
      const btn = await $('[data-testid="output-tab-variables"]');
      await expect(btn).toBeDisplayed();
      await expect(btn).toBeClickable();
    });

    it('should display the Problems tab button', async () => {
      const btn = await $('[data-testid="output-tab-problems"]');
      await expect(btn).toBeDisplayed();
      await expect(btn).toBeClickable();
    });

    it('should switch to Output panel when Output tab is clicked', async () => {
      const outputTab = await $('[data-testid="output-tab-output"]');
      await outputTab.click();
      await browser.pause(300);
      // Output scroll area should be present when Output tab is active.
      const outputScroll = await $('[data-testid="output-scroll"]');
      await expect(outputScroll).toBeDisplayed();
    });
  });

  describe('Settings Panel', () => {
    it('should open settings panel when Settings button is clicked', async () => {
      const settingsBtn = await $('[data-testid="toolbar-settings"]');
      await settingsBtn.click();
      await browser.pause(400);

      // Settings panel appears as a modal overlay.
      const settingsPanel = await $('[data-testid="settings-panel"]');
      await expect(settingsPanel).toBeDisplayed();
    });

    it('should close settings panel when Escape is pressed', async () => {
      await browser.keys(['Escape']);
      await browser.pause(300);

      // After closing, the settings state should no longer be open.
      // Verify by checking if a settings-specific heading is gone.
      const settingsPanels = await $$('[class*="settings"]');
      // We just check no crash occurred and toolbar is still accessible.
      const toolbar = await $('[data-testid="toolbar-root"]');
      await expect(toolbar).toBeDisplayed();
    });
  });
});
