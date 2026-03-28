/**
 * E2E Tests: Editor and Tab Management
 *
 * Verifies tab creation, switching, closing, and basic Monaco editor interaction.
 *
 * Run: npm run test:e2e -- --spec e2e/editor.spec.ts
 */

describe('Editor and Tab Management', () => {
  async function typeInEditorWithRetry(text: string, attempts = 2): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await browser.execute(() => {
        const input = document.querySelector('.monaco-editor textarea.inputarea');
        if (input instanceof HTMLTextAreaElement) input.focus();
      });
      await browser.pause(120);
      await browser.keys(['Control', 'a']);
      await browser.pause(80);
      await browser.keys(['Delete']);
      await browser.pause(80);
      for (const ch of text) {
        await browser.keys([ch]);
        await browser.pause(20);
      }
      await browser.pause(220);

      const hasText = await browser.execute((expected: string) => {
        const fn = (window as any).__psforge_getRunText;
        const runText = typeof fn === 'function' ? String(fn()) : '';
        if (runText.includes(expected)) return true;
        const rendered =
          (document.querySelector('.monaco-editor .view-lines') as HTMLElement | null)
            ?.innerText ?? '';
        return rendered.includes(expected);
      }, text);
      if (hasText) return true;
    }
    return false;
  }

  describe('Initial State', () => {
    it('should have at least one tab open on startup', async () => {
      const tabBar = await $('[data-testid="tabbar-root"]');
      await expect(tabBar).toBeDisplayed();

      // Wait for tabs to render.
      await browser.waitUntil(async () => {
        const tabs = await $$('[data-testid^="tab-item-"]');
        return tabs.length >= 1;
      }, { timeout: 5000, timeoutMsg: 'No tabs found after 5s' });

      const tabs = await $$('[data-testid^="tab-item-"]');
      expect(tabs.length).toBeGreaterThanOrEqual(1);
    });

    it('should display the Monaco editor container', async () => {
      // Monaco renders a div with class "monaco-editor".
      // Wait for it to be initialised.
      await browser.waitUntil(async () => {
        const editors = await $$('.monaco-editor');
        return editors.length > 0;
      }, { timeout: 10000, timeoutMsg: 'Monaco editor did not initialise within 10s' });

      const editor = await $('.monaco-editor');
      await expect(editor).toBeDisplayed();
    });
  });

  describe('New Tab Creation', () => {
    it('should create a new tab when New File button is clicked', async () => {
      const initialTabs = await $$('[data-testid^="tab-item-"]');
      const initialCount = initialTabs.length;

      const newBtn = await $('[data-testid="toolbar-new"]');
      await newBtn.click();
      await browser.pause(400);

      await browser.waitUntil(async () => {
        const tabs = await $$('[data-testid^="tab-item-"]');
        return tabs.length > initialCount;
      }, { timeout: 5000, timeoutMsg: `Tab count did not increase from ${initialCount}` });

      const tabs = await $$('[data-testid^="tab-item-"]');
      expect(tabs.length).toBeGreaterThan(initialCount);
    });

    it('should create a new tab with Ctrl+N keyboard shortcut', async () => {
      const initialTabs = await $$('[data-testid^="tab-item-"]');
      const initialCount = initialTabs.length;

      await browser.keys(['Control', 'n']);
      await browser.pause(400);

      await browser.waitUntil(async () => {
        const tabs = await $$('[data-testid^="tab-item-"]');
        return tabs.length > initialCount;
      }, { timeout: 5000, timeoutMsg: `Tab count did not increase via Ctrl+N` });

      const tabs = await $$('[data-testid^="tab-item-"]');
      expect(tabs.length).toBeGreaterThan(initialCount);
    });

    it('new tab should have an Untitled- title', async () => {
      const tabs = await $$('[data-testid^="tab-item-"]');
      const lastTab = tabs[tabs.length - 1];
      const text = await lastTab.getText();
      expect(text).toContain('Untitled-');
    });
  });

  describe('Tab Closing', () => {
    it('should be able to close a non-last tab', async () => {
      // Ensure we have at least two tabs so the close button is active.
      const tabsBefore = await $$('[data-testid^="tab-item-"]');
      if (tabsBefore.length < 2) {
        // Create one more tab if needed.
        const newBtn = await $('[data-testid="toolbar-new"]');
        await newBtn.click();
        await browser.pause(300);
      }

      const tabsBeforeClose = await $$('[data-testid^="tab-item-"]');
      const countBefore = tabsBeforeClose.length;

      // Close the tab that is NOT the first (to avoid the confirmation dialog
      // that may appear for the welcome/first tab).
      const closeButtons = await $$('[data-testid^="tab-close-"]');
      expect(closeButtons.length).toBeGreaterThanOrEqual(1);

      // Close the last tab.
      const lastCloseBtn = closeButtons[closeButtons.length - 1];
      const isEnabled = await lastCloseBtn.isEnabled();
      if (isEnabled) {
        await lastCloseBtn.click();
        await browser.pause(400);

        const tabsAfterClose = await $$('[data-testid^="tab-item-"]');
        expect(tabsAfterClose.length).toBe(countBefore - 1);
      }
    });
  });

  describe('Monaco Editor Interaction', () => {
    before(async () => {
      // Ensure we are on the Output tab so the editor is not obscured.
      const outputTab = await $('[data-testid="output-tab-output"]');
      await outputTab.click();
      await browser.pause(200);
    });

    it('should focus the Monaco editor on click', async () => {
      const editorContainer = await $('.monaco-editor');
      await editorContainer.click();
      await browser.pause(300);

      const isFocused = await browser.execute(() => {
        const editors = document.querySelectorAll('.monaco-editor');
        for (const el of editors) {
          if (el.classList.contains('focused')) return true;
        }
        return false;
      });
      expect(isFocused).toBe(true);
    });

    it('should accept keyboard input typed into the editor', async () => {
      const testText = `e2e-input-${Date.now().toString().slice(-6)}`;
      const typed = await typeInEditorWithRetry(testText, 3);
      expect(typed).toBe(true);
    });

    it('should show the PS version in the status bar', async () => {
      const statusBar = await $('[data-testid="status-bar"]');
      const text = await statusBar.getText();
      // Status bar should mention PowerShell somewhere.
      expect(text.toLowerCase()).toMatch(/powershell|pwsh/i);
    });
  });
});
