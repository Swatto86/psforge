# CONTEXT — psforge

## Operational notes

- Current version: **1.4.50**. Updates install automatically (launch + every 4 h, manual check too) once no script is running; see `src/use-app-updates.ts`. Open a `.ps1` and press F5 to run it in the integrated console (same session as typing `& '.\script.ps1'` in VS Code / Windows Terminal). Untitled buffers still use the temp `psrun` wrapper. The AI tab can pick provider/model, including OpenCode + local Ollama. Each AI question automatically includes the debug bundle (script, last run, PSSA). The status-bar **Run:** path sits on the left so the full directory is visible. Consoles no longer print a `PSForge Terminal` banner.
- Verification: `pwsh scripts/fastcheck.ps1`, `npm test`, `npm run build`, `cargo fmt/clippy/test` in `src-tauri`, release via tag after CI green on the release commit.
- Local unsigned NSIS: `npx tauri build --bundles nsis --config src-tauri/tauri.local-nsis.json` (disables updater signing artifacts).

## Operational notes (migrated from mem0, 2026-07-23)

_Facts recovered from the decommissioned shared mem0 store. May overlap existing docs above; integrate/prune as you touch these areas._

### project-psforge

PSForge is a Tauri 2 + React desktop PowerShell IDE at C:\Users\Swatto\psforge (GitHub Swatto86/psforge). Stack: React 19/Vite/Monaco/xterm frontend, Rust Tauri backend (`src-tauri/`). State in `src/store.tsx`; run/debug/save in `src/use-execution-actions.ts`; terminal multi-tab in `TerminalPane.tsx`. Verification: `npm test`, `npm run build`, cargo fmt/clippy/test, `cargo build --release`. Release metadata must stay in sync: `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, README current-version link (`release-metadata.test.ts`). Audit log: `AUDIT-FIXES.md`. AI context: `AI_CONTEXT.md`.
