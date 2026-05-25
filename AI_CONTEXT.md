# PSForge — AI context

## System Overview

PSForge is a Tauri 2 + React desktop PowerShell IDE (ISE-style) for editing, running, and debugging `.ps1` scripts with an integrated terminal, PSScriptAnalyzer diagnostics, and TabExpansion2 IntelliSense.

## Tech Stack & Architecture

- **Frontend:** React 19, Vite, Monaco (`@monaco-editor/react`), Tailwind 4, xterm.js
- **Backend:** Rust (`src-tauri/`), Tauri commands for PowerShell host, settings, files
- **State:** `src/store.tsx` (React context + reducer), settings persisted via `load_settings` / `save_settings`

## Component Map

| Area | Path |
|------|------|
| Shell / shortcuts | `src/App.tsx` |
| Editor + paste sanitize | `src/components/EditorPane.tsx`, `src/sanitize-paste.ts` |
| Toolbar (compact + overflow) | `src/components/Toolbar.tsx` |
| Settings | `src/components/SettingsPanel.tsx`, `src-tauri/src/settings.rs` |
| Types / defaults | `src/types.ts` |
| Format script | `src/commands.ts` → `format_script` in `src-tauri/src/commands.rs` |

## Data Flow — paste cleanup

1. **Ctrl+V:** Monaco `onDidPaste` in `EditorPane` reads pasted range; if `settings.sanitizePasteOnPaste` (default **true**), `sanitizePastedText()` rewrites only that range.
2. **Ctrl+Shift+Alt+V:** `pasteCleanAndFormat` in `App.tsx` reads clipboard → full sanitize → `__psforge_insertTextAtSelection` → `formatScript` on full buffer → `UPDATE_TAB`.
3. Options built in `pasteSanitizeOptionsFromSettings()`; rules in `src/sanitize-paste.ts` (typography, markdown fences, line gutters, `PS>`/`>>` prefixes, newlines, control chars).

## Recent Context & Decisions

- **2026-05-24:** Paste from web: `sanitizePasteOnPaste` setting (default on); **Paste Clean + Format** command (overflow menu, context menu, palette, Ctrl+Shift+Alt+V). Run `./scripts/ci-local.sh` before commit.
