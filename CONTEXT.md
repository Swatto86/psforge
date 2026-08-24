# CONTEXT — psforge

## Operational notes

- Current version: **1.4.23**. Consoles sync colour scheme + font from Windows Terminal `settings.json` when present; enable Settings → Terminal Profile Loading for Oh My Posh prompt scripts.
- Verification: `pwsh scripts/fastcheck.ps1`, `npm test`, `npm run build`, `cargo fmt/clippy/test` in `src-tauri`, release via tag after CI green on the release commit.
- Local unsigned NSIS: `npx tauri build --bundles nsis --config src-tauri/tauri.local-nsis.json` (disables updater signing artifacts).

## Operational notes (migrated from mem0, 2026-07-23)

_Facts recovered from the decommissioned shared mem0 store. May overlap existing docs above; integrate/prune as you touch these areas._

### project-psforge

PSForge is a Tauri 2 + React desktop PowerShell IDE at C:\Users\Swatto\psforge (GitHub Swatto86/psforge). Stack: React 19/Vite/Monaco/xterm frontend, Rust Tauri backend (`src-tauri/`). State in `src/store.tsx`; run/debug/save in `src/use-execution-actions.ts`; terminal multi-tab in `TerminalPane.tsx`. Verification: `npm test`, `npm run build`, cargo fmt/clippy/test, `cargo build --release`. Release metadata must stay in sync: `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, README current-version link (`release-metadata.test.ts`). Audit log: `AUDIT-FIXES.md`. AI context: `AI_CONTEXT.md`.
