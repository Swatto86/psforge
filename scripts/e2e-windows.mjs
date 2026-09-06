import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';

// WebDriver's launch mode expects the launched process to own the webview.
// The portable launcher extracts and starts a child, so attach to that webview.
export async function launchWindowsApp(executable, env, port, waitFor) {
  // Runtime 150+ ignores environment debugging switches in elevated CI processes.
  // https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645
  const policyState = join(env.APPDATA, 'webview-test-policy.json');
  const policy = mode => execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/webview-test-policy.ps1',
    '-Mode', mode, '-StateFile', policyState, '-Port', String(port)], { stdio: 'pipe' });
  policy('Enable');
  const app = spawn(executable, [], {
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: 'ignore',
  });
  let launchError;
  let endpointError;
  const stop = () => {
    try {
      if (app.pid && app.exitCode === null) {
        execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'pipe' });
      }
    } finally { policy('Restore'); }
  };
  app.on('error', error => { launchError = error; });
  try {
    await waitFor(async () => {
      if (launchError) throw launchError;
      if (app.exitCode !== null) throw new Error(`Portable launcher exited before webview startup: ${app.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        endpointError = `HTTP ${response.status}`;
        return response.ok;
      } catch (error) { endpointError = `${error.message}: ${error.cause?.code}`; return false; }
    }, 'Portable application did not expose its webview', 60000);
  } catch (error) {
    console.error(`Webview endpoint 127.0.0.1:${port}: ${endpointError}`);
    try {
      console.error(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/diagnose-portable.ps1'],
        { encoding: 'utf8', timeout: 15000 }));
    } catch (diagnosticError) { console.error(`Portable diagnostics failed: ${diagnosticError.message}`); }
    stop();
    throw error;
  }
  return {
    capabilities: { browserName: 'webview2', 'ms:edgeChromium': true,
      'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${port}` } },
    async waitForExit() {
      await waitFor(() => app.exitCode !== null, 'Portable launcher did not exit', 30000);
      assert.equal(app.exitCode, 0, 'Portable application must exit successfully');
      policy('Restore');
    },
    stop,
  };
}
