# PSForge — AI Context

## System Overview

PSForge is a Tauri 2 desktop IDE for PowerShell: Monaco editor, integrated terminal, PSScriptAnalyzer diagnostics, and optional debugger tooling. Primary use case: run scripts with F5 and read terminal output.

## Tech Stack & Architecture

- **Frontend:** React 19, TypeScript, Vite, Tailwind, Monaco, xterm (`@xterm/xterm`)
- **Backend:** Rust (`src-tauri/`), PowerShell session host, settings in `%APPDATA%/PSForge/settings.json`
- **State:** `src/store.tsx` (React context + reducer), settings synced via Tauri commands

## Component Map

| Area | Path |
|------|------|
| App shell, run/debug | `src/App.tsx` |
| Bottom pane tabs | `src/components/OutputPane.tsx` |
| Reference (Problems / Show Command / Help) | `src/components/ReferencePane.tsx` |
| Toolbar | `src/components/Toolbar.tsx` |
| Welcome | `src/components/WelcomePane.tsx` |
| Status bar | `src/components/StatusBar.tsx` |
| Settings (Rust) | `src-tauri/src/settings.rs` |
| CI workflow | `.github/workflows/ci.yml` |

## Data Flow

- F5 → `runScript` → terminal command → `SET_LAST_RUN_RESULT` with exit code and duration
- PSSA debounce → `SET_PROBLEMS` → Reference tab auto-switch on new **errors** only
- Settings load/save: `AppSettings` in `src/types.ts` ↔ `src-tauri/src/settings.rs` (camelCase JSON)

## Pre-commit / CI

Before committing, run **`./scripts/ci-local.sh`** (mirrors GitHub Actions `ci` job):

1. `npm ci` + `npm run build`
2. `cargo fmt --all -- --check` in `src-tauri`
3. `cargo clippy --all-targets -- -D warnings`
4. `cargo test`

## Recent Context & Decisions

- **2026-05-25:** Script-runner UI — 40/60 split default, Reference tab, compact toolbar, debugger tools off by default (`showDebuggerTools` / `show_debugger_tools`).
- **2026-05-25:** Added `scripts/ci-local.sh` so agents run CI parity before push.
