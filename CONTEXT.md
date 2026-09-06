# CONTEXT — psforge

## Operational notes

- Current version: **1.4.52**. Updates install automatically (launch + every 4 h, manual check too) once no script is running; see `src/use-app-updates.ts`. Paste + Run creates a new script tab and local console, waits for that tab's React state to commit, then runs it without resuming an unrelated debugger. Busy paste/run requests show a notice. F5 disk scripts now use a fresh `-NoProfile` child, preserving the real script path and applying working-directory/policy setup inside the child. Untitled buffers use the existing child-process `psrun` wrapper. The AI tab can pick provider/model, including OpenCode + local Ollama. Each AI question automatically includes the debug bundle (script, last run, PSSA). The status-bar **Run:** path sits on the left so the full directory is visible. Consoles no longer print a `PSForge Terminal` banner.
- Verification: `pwsh scripts/fastcheck.ps1` for iteration; `scripts/verify.sh` or `scripts/verify.ps1` for the full gate. Release via tag after CI green on the release commit.
- Local unsigned NSIS: `npx tauri build --bundles nsis --config src-tauri/tauri.local-nsis.json` (disables updater signing artifacts).

## Operational notes (migrated from mem0, 2026-07-23)

_Facts recovered from the decommissioned shared mem0 store. May overlap existing docs above; integrate/prune as you touch these areas._

### project-psforge

PSForge is a Tauri 2 + React desktop PowerShell IDE at C:\Users\Swatto\psforge (GitHub Swatto86/psforge). Stack: React 19/Vite/Monaco/xterm frontend, Rust Tauri backend (`src-tauri/`). State in `src/store.tsx`; run/debug/save in `src/use-execution-actions.ts`; terminal multi-tab in `TerminalPane.tsx`. Verification: `npm test`, `npm run build`, cargo fmt/clippy/test, `cargo test`. Release metadata must stay in sync: `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, README current-version link (`release-metadata.test.ts`). Audit log: `AUDIT-FIXES.md`. AI context: `AI_CONTEXT.md`.

- Paste cleanup preserves prompt text and typography inside existing string literals. Sanitizer options and string segmentation live in separate modules.

- Clipboard actions use Tauri's native text clipboard plugin (browser clipboard reads failed in the Linux webview). Console readiness waits for OSC 633 prompt completion; the waiter distinguishes a starting shell from a stopped shell.
- Full gate: `scripts/verify.sh` / `scripts/verify.ps1`, including `scripts/e2e.mjs`. The desktop journey covers native clipboard → two Paste + Run actions → F5 → flushed history → relaunch → exit. Intentional Exit can delete the WebDriver session; only that lifecycle path accepts the driver's closed-session response. Restart also handles the expected scratch-recovery dialog. CI runs the journey on Linux and Windows.
- Windows portable packaging uses `scripts/build-portable.ps1` and `portable.nsi` to extract the app and a SHA-256-pinned fixed WebView2 runtime to a temporary directory. CI diagnostics observed PSForge and its included runtime running despite a deliberately invalid inherited runtime path. Full Windows workflow and cleanup verification remain blocked: WebDriver launch timed out, and the attach approach could not reach the remote-debugging endpoint. See CI run 34058513479 and `scripts/diagnose-portable.ps1`; investigate browser debugging arguments and endpoint discovery before another fix attempt. The release workflow is configured to publish SHA256SUMS alongside assets, but v1.4.52 has not been tagged or published. Last published version remains v1.4.51.
