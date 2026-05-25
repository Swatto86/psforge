# PSForge — AI context

## System Overview

PSForge is a Tauri 2 + React desktop PowerShell IDE (ISE-style) for editing, running, and debugging `.ps1` scripts with an integrated terminal, PSScriptAnalyzer diagnostics, and TabExpansion2 IntelliSense. Default layout favors the terminal (~72% of vertical space at `splitPosition: 28`).

## Tech Stack & Architecture

- **Frontend:** React 19, Vite, Monaco (`@monaco-editor/react`), Tailwind 4, xterm.js
- **Backend:** Rust (`src-tauri/`), Tauri commands for PowerShell host, settings, files
- **State:** `src/store.tsx` (React context + reducer), settings persisted via `load_settings` / `save_settings`

## Component Map

| Area | Path |
|------|------|
| Shell / shortcuts | `src/App.tsx` |
| Editor + paste sanitize | `src/components/EditorPane.tsx`, `src/sanitize-paste.ts` |
| Terminal toolbar | `src/components/OutputPane.tsx` (`Restart Session` only) |
| Multi-console tabs | `src/components/TerminalPane.tsx` (no duplicate restart) |
| Status bar run metrics | `src/components/StatusBar.tsx` (`lastRunResult`) |
| Toolbar (compact + overflow) | `src/components/Toolbar.tsx` |
| Settings | `src/components/SettingsPanel.tsx`, `src-tauri/src/settings.rs` |
| Types / defaults | `src/types.ts` |
| Format script | `src/commands.ts` → `format_script` in `src-tauri/src/commands.rs` |

## Data Flow — paste cleanup

1. **Ctrl+V:** Monaco `onDidPaste` in `EditorPane`; if `sanitizePasteOnPaste`, `sanitizePastedText()` with `pasteSanitizeOptionsFromSettings()`. Optional `runAfterSanitizedPaste` → `__psforge_afterPasteSanitized` → F5.
2. **Ctrl+Shift+Alt+V:** `pasteCleanAndFormat` in `App.tsx` — clipboard → full sanitize → insert → `formatScript` → optional run when `runAfterPasteCleanFormat` (default **true**).
3. **sanitize-paste.ts v2:** embedded ```powershell fences, prose wrappers, simple HTML, extended lang tags, plus typography/gutters/prompts.

## Recent Context & Decisions

- **2026-05-24:** Script-runner polish: default split 28/72 editor/terminal; single **Restart Session** in `OutputPane`; status bar shows last exit code + duration; paste-and-run settings; sanitize v2. Version **1.2.12**. Run `./scripts/ci-local.sh` before release tag.
