import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

// WebDriver's launch mode expects the launched process to own the webview.
// The portable launcher extracts and starts a child, so attach to that webview.
export async function launchWindowsApp(executable, env, port, waitFor) {
  const app = spawn(executable, [], {
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: 'ignore',
  });
  let launchError;
  app.on('error', error => { launchError = error; });
  try {
    await waitFor(async () => {
      if (launchError) throw launchError;
      if (app.exitCode !== null) throw new Error(`Portable launcher exited before webview startup: ${app.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; }
      catch { return false; }
    }, 'Portable application did not expose its webview', 60000);
  } catch (error) {
    try {
      console.error(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/diagnose-portable.ps1'],
        { encoding: 'utf8', timeout: 15000 }));
    } catch (diagnosticError) { console.error(`Portable diagnostics failed: ${diagnosticError.message}`); }
    app.kill();
    throw error;
  }
  return {
    capabilities: { browserName: 'webview2', 'ms:edgeChromium': true,
      'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${port}` } },
    async waitForExit() {
      await waitFor(() => app.exitCode !== null, 'Portable launcher did not exit', 30000);
      assert.equal(app.exitCode, 0, 'Portable application must exit successfully');
    },
    stop() { if (app.exitCode === null) app.kill(); },
  };
}
