/**
 * PSForge startup preload script.
 *
 * Purpose: prevent the flash of unstyled/white content (FOUC) that occurs
 * while the React bundle is being parsed and the first render completes.
 *
 * Mechanism:
 *   1. This script is loaded synchronously in <head> BEFORE the React module,
 *      so it runs the moment the HTML parser reaches it.
 *   2. It adds the `psforge-loading` class to <html>, which the accompanying
 *      <style> rule uses to set `body { opacity: 0 }`.
 *   3. React removes the class from App.tsx after the first mount, producing
 *      a clean reveal with no visible blank/white frame.
 *   4. A 800 ms safety timer ensures the class is always removed even if the
 *      React bundle fails or is very slow to initialise.
 *
 * This file is served from the Vite `public/` directory so its origin is
 * `'self'`, satisfying the `script-src 'self'` CSP directive without
 * requiring `'unsafe-inline'`.
 */
(function () {
  var TIMEOUT_MS = 800;

  document.documentElement.classList.add("psforge-loading");

  var timer = setTimeout(function () {
    document.documentElement.classList.remove("psforge-loading");
  }, TIMEOUT_MS);

  /**
   * Called by React (App.tsx) after the first successful mount.
   * Cancels the safety timer and immediately removes the loading class.
   */
  window.__psforgeReveal = function () {
    clearTimeout(timer);
    document.documentElement.classList.remove("psforge-loading");
  };
})();
