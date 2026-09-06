// Drives the shipped webview and real PowerShell with isolated application state.
import { remote } from 'webdriverio';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { launchWindowsApp } from './e2e-windows.mjs';
import { prepareConfig } from './e2e-config.mjs';

const state = realpathSync.native(mkdtempSync(join(tmpdir(), 'psforge-e2e-')));
const configState = prepareConfig(state);
const config = configState.config;
const settingsPath = join(config, 'PSForge', 'settings.json');
mkdirSync(join(config, 'PSForge'), { recursive: true });
writeFileSync(settingsPath, JSON.stringify({
  defaultPsVersion: process.env.PSFORGE_TEST_PWSH || 'pwsh',
  checkForUpdatesOnStartup: false, enablePssa: false, terminalLoadProfile: false,
  runAfterPasteCleanFormat: true, workingDirMode: 'custom', customWorkingDir: state,
}));
const executable = resolve(process.env.PSFORGE_TEST_BINARY || `src-tauri/target/debug/psforge${process.platform === 'win32' ? '.exe' : ''}`);
assert.ok(existsSync(executable), `Build the debug app first: ${executable}`);
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolvePort(port));
  });
});
const port = await freePort();
const nativePort = await freePort();
const args = ['--port', String(port), '--native-port', String(nativePort)];
if (process.env.WEBKIT_WEBDRIVER) args.push('--native-driver', process.env.WEBKIT_WEBDRIVER);
const appEnv = { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config,
  XDG_DATA_HOME: join(state, 'data'), XDG_CACHE_HOME: join(state, 'cache') };
const driver = spawn(process.env.TAURI_DRIVER || 'tauri-driver', args, {
  env: appEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let driverError;
let driverLog = '';
driver.on('error', (error) => { driverError = error; });
for (const stream of [driver.stdout, driver.stderr]) {
  stream.on('data', (data) => { driverLog = (driverLog + data).slice(-12000); });
}
const waitFor = async (check, message, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(message);
};
let browser;
let windowsApp;
let previousClipboard;
const invoke = (command, args = {}) => browser.executeAsync((command, args, done) => {
  window.__TAURI__.core.invoke(command, args).then(
    value => done({ ok: true, value }), error => done({ ok: false, message: String(error) }),
  );
}, command, args);
const connect = async () => {
  if (process.platform === 'win32') {
    windowsApp = await launchWindowsApp(executable, appEnv, await freePort(), waitFor);
  }
  browser = await remote({ hostname: '127.0.0.1', port, logLevel: 'silent',
    connectionRetryCount: 0, connectionRetryTimeout: 60000,
    capabilities: { ...(windowsApp?.capabilities ?? { 'tauri:options': { application: executable } }),
      'wdio:enforceWebDriverClassic': true },
  });
  await browser.$('[data-testid="toolbar-paste-run"]').waitForEnabled({ timeout: 30000 });
};
// WebKit deletes the WebDriver session when a desktop app exits normally.
// Only the intentional Exit/teardown paths accept these responses.
const sessionClosed = error => /invalid session id|session deleted because of page crash or hang/i.test(error.message ?? '');
const deleteSession = async () => {
  if (!browser) return;
  try { await browser.deleteSession(); }
  catch (error) { if (!sessionClosed(error)) throw error; }
  browser = undefined;
};
const exitApp = async () => {
  await browser.$('[data-testid="menubar-file"]').click();
  await browser.$('button=Exit').click();
  if (windowsApp) {
    await windowsApp.waitForExit();
    await deleteSession();
    windowsApp = undefined;
    return;
  }
  await waitFor(async () => {
    try { return (await browser.getWindowHandles()).length === 0; }
    catch (error) {
      if (sessionClosed(error)) return true;
      // Older WebKit briefly loses the page before declaring the session closed.
      if (/WebDriverError: unknown error/.test(error.message ?? '')) return false;
      throw error;
    }
  }, 'App did not exit');
  await deleteSession();
};
try {
  await waitFor(async () => {
    if (driverError) throw driverError;
    if (driver.exitCode !== null) throw new Error(`Driver exited: ${driverLog}`);
    try { return (await fetch(`http://127.0.0.1:${port}/status`)).ok; }
    catch { return false; } // Startup only: the listener has not bound yet.
  }, 'WebDriver did not start');
  await connect();
  const clipboard = await invoke('plugin:clipboard-manager|read_text');
  if (clipboard.ok) previousClipboard = clipboard.value;
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const pasteRun = async (script, result) => {
    const written = await invoke('plugin:clipboard-manager|write_text', { text: script });
    assert.equal(written.ok, true, written.message);
    await browser.$('[data-testid="toolbar-paste-run"]').click();
    await waitFor(() => existsSync(result), `Script did not write ${result}`);
    await waitFor(async () => !(await browser.$('[data-testid="toolbar-stop"]').isEnabled()), 'Run never completed');
    assert.ok((await browser.execute(() => window.__psforge_getEditorText())).includes(result));
  };
  const first = join(state, 'first.txt');
  await pasteRun(`$global:PsforgeLeak=42; $env:PSFORGE_E2E_LEAK='dirty'; function global:PsforgeLeakFn { 1 }; 'first' | Set-Content ${quote(first)}`, first);
  assert.equal(readFileSync(first, 'utf8').trim(), 'first');
  const second = join(state, 'second.json');
  const cleanScript = `[pscustomobject]@{ variable=$null -ne (Get-Variable PsforgeLeak -ErrorAction SilentlyContinue); environment=$env:PSFORGE_E2E_LEAK; fn=$null -ne (Get-Command PsforgeLeakFn -ErrorAction SilentlyContinue); cwd=$PWD.Path } | ConvertTo-Json -Compress | Set-Content ${quote(second)}`;
  await pasteRun(cleanScript, second);
  const expected = { variable: false, environment: null, fn: false, cwd: state };
  assert.deepEqual(JSON.parse(readFileSync(second, 'utf8').replace(/^\uFEFF/, '')), expected);
  // F5 reruns the now scratch-backed file through the disk runner.
  rmSync(second);
  await browser.$('[data-testid="toolbar-run"]').click();
  await waitFor(() => existsSync(second), 'Saved-script rerun did not finish');
  await waitFor(async () => !(await browser.$('[data-testid="toolbar-stop"]').isEnabled()), 'Rerun never completed');
  assert.deepEqual(JSON.parse(readFileSync(second, 'utf8').replace(/^\uFEFF/, '')), expected);
  if (previousClipboard !== undefined) {
    assert.equal((await invoke('plugin:clipboard-manager|write_text', { text: previousClipboard })).ok, true);
    previousClipboard = undefined;
  }
  await exitApp();
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(settings.recentRuns.length >= 3, 'Exit must flush run history');
  // Seed a genuine orphan: ordinary open tabs may already restore automatically.
  const scratch = join(config, 'PSForge', 'scratch');
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'tab-e2e-orphan.ps1'), "'recover me'");
  await connect();
  const recovery = await browser.$('[data-testid="scratch-recovery-dismiss"]');
  await recovery.waitForDisplayed({ timeout: 10000 });
  // Loaded previews resize the dialog; wait before WebDriver chooses click coordinates.
  await waitFor(async () => !(await browser.$('[data-testid="scratch-recovery-dialog"]').getText()).includes('Loading…'),
    'Scratch previews did not finish loading');
  await recovery.click();
  await browser.$('[data-testid="scratch-recovery-dialog"]').waitForDisplayed({ reverse: true, timeout: 10000 });
  const loaded = await invoke('load_settings');
  assert.equal(loaded.ok, true, loaded.message);
  assert.equal(loaded.value.recentRuns.length, settings.recentRuns.length);
  await exitApp();
  console.log('PASS: native clipboard, repeated Paste + Run, F5 isolation, working directory, persistence and exit');
} catch (error) {
  if (browser) {
    try { console.error(await browser.execute(() => document.body.innerText.slice(-4000))); }
    catch (diagnosticError) { console.error(`Webview diagnostics unavailable: ${diagnosticError.message}`); }
  }
  console.error(driverLog);
  throw error;
} finally {
  try {
    if (browser) {
      if (previousClipboard !== undefined) await invoke('plugin:clipboard-manager|write_text', { text: previousClipboard });
      await deleteSession();
    }
  } finally {
    driver.kill();
    try { windowsApp?.stop(); }
    finally {
      configState.restore();
      rmSync(state, { recursive: true, force: true });
    }
  }
}
