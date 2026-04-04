import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export {};

const SESSION_KEY = "psforge.session.v1";
const APP_READY_TIMEOUT = 15_000;
const EDITOR_READY_TIMEOUT = 20_000;

type PersistedTab = {
  id: string;
  title: string;
  filePath: string;
  content: string;
  savedContent: string;
  encoding: string;
  language: string;
  isDirty: boolean;
  tabType: "code";
};

type PersistedSession = {
  tabs: PersistedTab[];
  activeTabId: string;
  bottomPanelTab:
    | "output"
    | "variables"
    | "problems"
    | "terminal"
    | "debugger"
    | "show-command"
    | "help";
  workingDir: string;
  selectedPsPath: string;
  breakpoints: Record<string, unknown[]>;
  bookmarks: Record<string, number[]>;
};

async function waitForAppRoot(): Promise<void> {
  await browser.waitUntil(
    async () => (await $('[data-testid="app-root"]')).isDisplayed(),
    {
      timeout: APP_READY_TIMEOUT,
      interval: 250,
      timeoutMsg: "App root never became visible after reload",
    },
  );
}

async function waitForEditor(): Promise<void> {
  await browser.waitUntil(async () => (await $$(".monaco-editor")).length > 0, {
    timeout: EDITOR_READY_TIMEOUT,
    interval: 250,
    timeoutMsg: "Monaco editor never became available after restore",
  });
}

async function reloadApp(expectEditor: boolean): Promise<void> {
  await browser.refresh();
  await waitForAppRoot();
  if (expectEditor) {
    await waitForEditor();
  }
  await browser.pause(500);
}

async function setPersistedSession(
  snapshot: PersistedSession | null,
): Promise<void> {
  await browser.execute(
    (sessionKey: string, payload: PersistedSession | null) => {
      window.localStorage.setItem("psforge.welcomed", "1");
      if (payload === null) {
        window.localStorage.removeItem(sessionKey);
        return;
      }
      window.localStorage.setItem(sessionKey, JSON.stringify(payload));
    },
    SESSION_KEY,
    snapshot,
  );
}

async function getRenderedEditorText(): Promise<string> {
  return browser.execute(() => {
    const viewLines = document.querySelector(
      ".monaco-editor .view-lines",
    ) as HTMLElement | null;
    return viewLines?.innerText ?? viewLines?.textContent ?? "";
  });
}

async function waitForEditorText(fragment: string): Promise<void> {
  await browser.waitUntil(
    async () => (await getRenderedEditorText()).includes(fragment),
    {
      timeout: EDITOR_READY_TIMEOUT,
      interval: 250,
      timeoutMsg: `Editor never rendered expected text: ${fragment}`,
    },
  );
}

describe("Session Restore", () => {
  afterEach(async () => {
    await setPersistedSession(null);
    await reloadApp(false);
  });

  it("reloads clean file-backed tabs from disk instead of stale persisted content", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "psforge-restore-"));
    const filePath = path.join(tempDir, "restore-from-disk.ps1");
    const diskContent = "Write-Host 'DISK_RESTORE_CONTENT'\n";
    const staleContent = "Write-Host 'STALE_PERSISTED_CONTENT'\n";

    try {
      fs.writeFileSync(filePath, diskContent, "utf8");

      const snapshot: PersistedSession = {
        tabs: [
          {
            id: "tab-restore-disk",
            title: "restore-from-disk.ps1",
            filePath,
            content: staleContent,
            savedContent: staleContent,
            encoding: "utf8",
            language: "powershell",
            isDirty: false,
            tabType: "code",
          },
        ],
        activeTabId: "tab-restore-disk",
        bottomPanelTab: "output",
        workingDir: tempDir,
        selectedPsPath: "",
        breakpoints: {},
        bookmarks: {},
      };

      await setPersistedSession(snapshot);
      await reloadApp(true);
      await waitForEditorText("DISK_RESTORE_CONTENT");

      const text = await getRenderedEditorText();
      expect(text).toContain("DISK_RESTORE_CONTENT");
      expect(text).not.toContain("STALE_PERSISTED_CONTENT");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers dirty file-backed tabs even when the backing file is missing", async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `psforge-missing-${Date.now().toString(36)}.ps1`,
    );
    fs.rmSync(missingPath, { force: true });

    const snapshot: PersistedSession = {
      tabs: [
        {
          id: "tab-dirty-recovery",
          title: "dirty-recovery.ps1",
          filePath: missingPath,
          content: "Write-Host 'RECOVERED_UNSAVED_CONTENT'\n",
          savedContent: "Write-Host 'OLD_SAVED_CONTENT'\n",
          encoding: "utf8",
          language: "powershell",
          isDirty: true,
          tabType: "code",
        },
      ],
      activeTabId: "tab-dirty-recovery",
      bottomPanelTab: "output",
      workingDir: path.dirname(missingPath),
      selectedPsPath: "",
      breakpoints: {},
      bookmarks: {},
    };

    await setPersistedSession(snapshot);
    await reloadApp(true);
    await waitForEditorText("RECOVERED_UNSAVED_CONTENT");

    const text = await getRenderedEditorText();
    expect(text).toContain("RECOVERED_UNSAVED_CONTENT");
  });
});
