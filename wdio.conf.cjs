/**
 * WebdriverIO Configuration for PSForge E2E Testing
 *
 * Strategy:
 *   1. Start the Vite dev server (npm run dev, port 1420) so the debug binary
 *      loads current frontend code including all data-testid attributes.
 *   2. Launch the PSForge debug binary with WebView2 remote debugging enabled.
 *      The debug binary is pre-configured at compile time to load from
 *      http://localhost:1420 (tauri.conf.json devUrl).
 *   3. Start msedgedriver matching the installed WebView2 runtime version.
 *   4. Connect WebdriverIO to the WebView2 instance via debuggerAddress.
 *
 * This avoids the need to run `tauri build` after every frontend change.
 *
 * Prerequisites:
 *   npm run tauri dev   (once, to produce src-tauri/target/debug/psforge.exe)
 *   npm install
 *
 * Run: npm run test:e2e
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

// WebView2 remote debugging port.
const DEBUG_PORT = 9222;

// msedgedriver listening port.
const DRIVER_PORT = 4444;

// Vite dev server port (matches tauri.conf.json devUrl).
const VITE_PORT = 1420;

/**
 * Returns the path to the PSForge debug binary.
 * The debug binary connects to the Vite dev server (localhost:1420) at runtime,
 * so it always serves the latest frontend code without a release rebuild.
 */
function getAppBinaryPath() {
  const debugPath = path.resolve(__dirname, 'src-tauri', 'target', 'debug', 'psforge.exe');
  if (fs.existsSync(debugPath)) {
    console.log('[wdio] Using debug binary:', debugPath);
    return debugPath;
  }
  throw new Error(
    'PSForge debug binary not found at ' + debugPath + '.\n' +
    'Run `npx tauri dev` once (then Ctrl+C) to produce the binary, or run\n' +
    '`cd src-tauri && cargo build` directly.'
  );
}

/**
 * Returns true if something is already listening on the given TCP port.
 * Tries both 127.0.0.1 and ::1 to handle Vite listening on IPv6.
 */
function isPortInUse(port) {
  const tryConnect = (host) => new Promise((resolve) => {
    const client = net.createConnection({ port, host });
    client.on('connect', () => { client.destroy(); resolve(true); });
    client.on('error', () => resolve(false));
    client.setTimeout(500, () => { client.destroy(); resolve(false); });
  });
  return Promise.any([
    tryConnect('127.0.0.1'),
    tryConnect('::1'),
  ]).catch(() => false);
}

/**
 * Waits up to timeoutMs for a TCP port to start accepting connections.
 */
async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Detects the installed WebView2 runtime version by scanning its install directory.
 * Returns a version string like '145.0.3800.82', or null if not found.
 */
function detectWebView2Version() {
  const webView2Dir = 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application';
  if (!fs.existsSync(webView2Dir)) {
    console.warn('[wdio] WebView2 Application directory not found:', webView2Dir);
    return null;
  }
  const entries = fs.readdirSync(webView2Dir)
    .filter(e => /^\d+\.\d+\.\d+\.\d+$/.test(e))
    .sort((a, b) => {
      const va = a.split('.').map(Number);
      const vb = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) { if (va[i] !== vb[i]) return vb[i] - va[i]; }
      return 0;
    });
  if (entries.length === 0) {
    console.warn('[wdio] No versioned directories found in', webView2Dir);
    return null;
  }
  const version = entries[0];
  console.log('[wdio] Detected WebView2 runtime version:', version);
  return version;
}

/**
 * Downloads the msedgedriver binary matching the given WebView2 version.
 * Uses a versioned cache directory so multiple versions can coexist.
 * Returns the path to the downloaded binary.
 */
async function downloadMatchingEdgedriver(webView2Version) {
  const { download } = require('edgedriver');
  const cacheDir = path.join(os.tmpdir(), `edgedriver-v${webView2Version}`);
  console.log(`[wdio] Downloading msedgedriver ${webView2Version} to ${cacheDir}...`);
  const binaryPath = await download(webView2Version, cacheDir);
  console.log('[wdio] msedgedriver ready at:', binaryPath);
  return binaryPath;
}

// Process handles kept alive for the duration of the test run.
let edgeDriverProc = null;
let psforgeProc = null;
let viteProc = null;

exports.config = {
  // Connect directly to msedgedriver on DRIVER_PORT.
  hostname: '127.0.0.1',
  port: DRIVER_PORT,

  // Test spec files.
  specs: ['./e2e/**/*.spec.ts'],
  exclude: [],

  // Only one WebView2 session is permitted at a time.
  maxInstances: 1,

  // WebView2 capability: connect to the already-running PSForge WebView2.
  capabilities: [{
    maxInstances: 1,
    browserName: 'webview2',
    'ms:edgeOptions': {
      debuggerAddress: `localhost:${DEBUG_PORT}`,
    },
  }],

  // TypeScript transpilation for spec files.
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      project: './tsconfig.json',
      transpileOnly: true,
    },
  },

  // Mocha as the test framework.
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  // Human-readable console output.
  reporters: ['spec'],

  // Reduce wdio log noise; errors still appear.
  logLevel: 'warn',

  // How long to wait for an element to appear.
  waitforTimeout: 15000,

  // Driver connection retry settings.
  connectionRetryTimeout: 90000,
  connectionRetryCount: 5,

  runner: 'local',

  /**
   * Ensure the attached WebView context is on the app URL.
   * Some WebView2 sessions start on about:blank after attach, which makes all
   * UI selectors appear missing even though the app process is running.
   */
  before: async function () {
    // Use localhost (not 127.0.0.1) to match tauri.conf devUrl and avoid
    // cross-origin remounts that can break Tauri event listeners.
    await browser.url(`http://localhost:${VITE_PORT}/`);
    await browser.waitUntil(async () => {
      const state = await browser.execute(() => document.readyState);
      return state === 'complete' || state === 'interactive';
    }, {
      timeout: 10000,
      interval: 200,
      timeoutMsg: 'WebView did not finish loading the app URL',
    });
  },

  /**
   * Lifecycle: Start PSForge and msedgedriver before any tests run.
   */
  onPrepare: async function () {
    console.log('');
    console.log('=== PSForge E2E Setup ===');

    // ------------------------------------------------------------------
    // 1. Kill any stale processes from a previous interrupted run.
    // ------------------------------------------------------------------
    if (process.platform === 'win32') {
      try {
        spawnSync('cmd', ['/c', `for /f "tokens=5" %a in ("netstat -ano | findstr :${DRIVER_PORT}") do taskkill /F /PID %a`], { shell: true, stdio: 'ignore' });
        spawnSync('cmd', ['/c', `for /f "tokens=5" %a in ("netstat -ano | findstr :${DEBUG_PORT}") do taskkill /F /PID %a`], { shell: true, stdio: 'ignore' });
      } catch { /* best-effort */ }
    }

    // ------------------------------------------------------------------
    // 2. Start the Vite dev server if not already running.
    //    The debug binary is compiled to load from http://localhost:1420
    //    (tauri.conf.json devUrl), so Vite must be up before the app starts.
    // ------------------------------------------------------------------
    const viteAlreadyRunning = await isPortInUse(VITE_PORT);
    if (viteAlreadyRunning) {
      console.log(`[wdio] Vite dev server already running on port ${VITE_PORT}.`);
    } else {
      console.log(`[wdio] Starting Vite dev server on port ${VITE_PORT}...`);
      // Spawn Vite directly (not via npm/cmd) for faster startup and a direct PID.
      const viteBin = path.resolve(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
      // --host 127.0.0.1 forces IPv4 binding so the port check is reliable.
      const viteArgs = ['--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'];
      viteProc = spawn(process.execPath, [viteBin, ...viteArgs], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        detached: false,
      });
      viteProc.stdout.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('ready') || msg.includes('Local') || msg.includes('error')) {
          process.stdout.write(`[vite] ${msg}`);
        }
      });
      viteProc.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('error') || msg.includes('Error')) {
          process.stderr.write(`[vite] ${msg}`);
        }
      });
      viteProc.on('exit', (code) => {
        if (code !== null && code !== 0) {
          console.error(`[vite] exited with code ${code}`);
        }
      });
      const viteReady = await waitForPort(VITE_PORT, 60000);
      if (!viteReady) throw new Error('Vite dev server did not start within 60s');
      console.log('[wdio] Vite dev server ready.');
      // Extra settle time for Vite's initial transform pass.
      await new Promise(r => setTimeout(r, 1000));
    }

    // ------------------------------------------------------------------
    // 3. Launch PSForge debug binary with WebView2 remote debugging.
    //    Debug binary connects to Vite on port 1420 (baked in at compile time).
    // ------------------------------------------------------------------
    const appPath = getAppBinaryPath();
    console.log('[wdio] Starting PSForge...');
    psforgeProc = spawn(appPath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
        RUST_LOG: process.env.RUST_LOG || 'warn',
      },
      detached: false,
    });

    psforgeProc.stdout.on('data', (d) => process.stdout.write(`[psforge] ${d}`));
    psforgeProc.stderr.on('data', (d) => process.stderr.write(`[psforge] ${d}`));
    psforgeProc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.error(`[psforge] exited with code ${code}`);
      }
    });

    // Wait for the WebView2 debug port to open (up to 20s).
    console.log(`[wdio] Waiting for WebView2 debug port ${DEBUG_PORT}...`);
    const appReady = await waitForPort(DEBUG_PORT, 20000);
    if (!appReady) throw new Error(`PSForge did not open debug port ${DEBUG_PORT} within 20s`);
    // Extra settle time for the React app to mount.
    console.log('[wdio] PSForge ready. Settling (3s)...');
    await new Promise(r => setTimeout(r, 3000));

    // ------------------------------------------------------------------
    // 4. Start msedgedriver matching the WebView2 runtime version.
    //    We detect the installed WebView2 version and download the exact
    //    matching driver to avoid the "version X only supports Edge Y" error.
    // ------------------------------------------------------------------
    console.log('[wdio] Starting msedgedriver...');

    const webView2Version = detectWebView2Version();
    let edgedriverBin;
    if (webView2Version) {
      try {
        edgedriverBin = await downloadMatchingEdgedriver(webView2Version);
      } catch (err) {
        console.warn(`[wdio] Could not download msedgedriver ${webView2Version}: ${err.message}`);
        console.warn('[wdio] Falling back to edgedriver CLI wrapper...');
        edgedriverBin = null;
      }
    }

    if (edgedriverBin && fs.existsSync(edgedriverBin)) {
      // Spawn the versioned binary directly.
      edgeDriverProc = spawn(
        edgedriverBin,
        [`--port=${DRIVER_PORT}`, '--verbose'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } else {
      // Fallback: use the edgedriver node CLI wrapper.
      const edgedriverCli = path.resolve(
        __dirname, 'node_modules', 'edgedriver', 'bin', 'edgedriver.js'
      );
      edgeDriverProc = spawn(
        process.execPath,
        [edgedriverCli, `--port=${DRIVER_PORT}`, '--verbose'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
    edgeDriverProc.stdout.on('data', (d) => {
      const msg = d.toString();
      // Only log meaningful lines to avoid noise.
      if (msg.includes('Started') || msg.includes('port') || msg.includes('ERROR')) {
        process.stdout.write(`[edgedriver] ${msg}`);
      }
    });
    edgeDriverProc.stderr.on('data', (d) => process.stderr.write(`[edgedriver] ${d}`));

    // Wait for msedgedriver to start listening on DRIVER_PORT.
    const driverReady = await waitForPort(DRIVER_PORT, 15000);
    if (!driverReady) throw new Error(`msedgedriver did not start listening on port ${DRIVER_PORT} within 15s`);
    console.log('[wdio] Setup complete. Running tests...');
    console.log('');
  },

  /**
   * Lifecycle: Stop msedgedriver, PSForge, and Vite after all tests complete.
   */
  onComplete: async function () {
    console.log('');
    console.log('=== PSForge E2E Teardown ===');

    if (edgeDriverProc) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(edgeDriverProc.pid)], { stdio: 'ignore' });
      } else {
        edgeDriverProc.kill();
      }
      edgeDriverProc = null;
      console.log('[wdio] msedgedriver stopped.');
    }

    if (psforgeProc) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(psforgeProc.pid)], { stdio: 'ignore' });
      } else {
        psforgeProc.kill();
      }
      psforgeProc = null;
      console.log('[wdio] PSForge stopped.');
    }

    if (viteProc) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(viteProc.pid)], { stdio: 'ignore' });
      } else {
        viteProc.kill();
      }
      viteProc = null;
      console.log('[wdio] Vite dev server stopped.');
    }
  },

  /**
   * Lifecycle: Print suite header before each suite.
   */
  beforeSuite: async function (suite) {
    console.log('');
    console.log('='.repeat(50));
    console.log('SUITE:', suite.title);
    console.log('='.repeat(50));
    // Give WebView2 a moment to stabilise between suites.
    await new Promise(r => setTimeout(r, 500));
  },

  /**
   * Lifecycle: Short pause before each test.
   */
  beforeTest: async function () {
    await new Promise(r => setTimeout(r, 100));
  },
};
