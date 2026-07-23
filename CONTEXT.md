# CONTEXT — psforge

## Operational notes (migrated from mem0, 2026-07-23)

_Facts recovered from the decommissioned shared mem0 store. May overlap existing docs above; integrate/prune as you touch these areas._

### project-psforge

PSForge is a Tauri 2 + React desktop PowerShell IDE at C:\Users\Swatto\psforge (GitHub Swatto86/psforge). Current version: 1.4.6 (tag v1.4.6, commit 27d59ab, 2026-07-09). Stack: React 19/Vite/Monaco/xterm frontend, Rust Tauri backend (src-tauri/). State in src/store.tsx; run/debug/save in src/use-execution-actions.ts; terminal multi-tab in TerminalPane.tsx. Verification: npm test, npm run build, cargo fmt/clippy/test, cargo build --release. Release metadata must stay in sync: package.json, package-lock.json, src-tauri/Cargo.toml, Cargo.lock, tauri.conf.json, README current-version link (release-metadata.test.ts). Audit log: AUDIT-FIXES.md. AI context: AI_CONTEXT.md. Known issue: v1.4.13-v1.4.16 (July 2026) had JS WebviewWindow.onCloseRequested bug; implements hide-to-tray, debounced settings flushing, explicit quit paths through flush-then-exit flow, removes core:window:allow-destroy and core:window:allow-close capabilities for security, handles macOS RunEvent::Reopen for Dock icon click to re-show hidden window, addresses Linux appindicator tray limitations with Show item in tray menu. Verification includes PowerShell Get-Process CloseMainWindow() testing and live verification testing preference over compile-time checks.

