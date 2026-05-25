# PSForge — AI context

## System Overview

PSForge is a Tauri 2 + React desktop PowerShell IDE (ISE-style) for editing, running, and debugging `.ps1` scripts with an integrated terminal, PSScriptAnalyzer diagnostics, and TabExpansion2 IntelliSense. Default layout favors the terminal (~72% vertical space at `splitPosition: 28`).

## Tech Stack & Architecture

- **Frontend:** React 19, Vite, Monaco (`@monaco-editor/react`), Tailwind 4, xterm.js
- **Backend:** Rust (`src-tauri/`), Tauri commands for PowerShell host, settings, files
- **State:** `src/store.tsx` (React context + reducer), settings persisted via `load_settings` / `save_settings`

## Component Map

| Area | Path |
|------|------|
| Shell / shortcuts | `src/App.tsx` |
| Editor + paste sanitize | `src/components/EditorPane.tsx`, `src/sanitize-paste.ts` |
| Run helpers | `src/run-utils.ts`, `src/terminal-utils.ts` |
| Font presets / status bar | `src/font-presets.ts`, `src/components/FontQuickControls.tsx` |
| Terminal toolbar | `src/components/OutputPane.tsx` (`Restart Session`, `Copy Output`) |
| Welcome quick start | `src/components/WelcomePane.tsx` (paste, recent runs) |
| Status bar | `src/components/StatusBar.tsx` (run CWD pin, font, last run) |
| Settings | `src/components/SettingsPanel.tsx`, `src-tauri/src/settings.rs` |
| Types / defaults | `src/types.ts` |

## Data Flow — script runner

1. **Paste:** Ctrl+V sanitize; Ctrl+Shift+Alt+V or Welcome **Paste from clipboard** → clean → format → optional F5.
2. **Scratch:** Untitled tabs auto-save to `%APPDATA%/PSForge/scratch/{tabId}.ps1` when `autoSaveScratchScripts` (debounced + before F5).
3. **Run:** `resolveExecutionWorkDir()` supports `file` / `custom` / `pinned` modes; PSSA gate (`pssaRunGate`: off/warn/block); outcomes append to `settings.recentRuns`.
4. **Output:** `__psforge_copy_terminal_output` strips ANSI and copies xterm scrollback.
5. **Fonts:** `fontFamily` / `outputFontFamily` + sizes persist in Rust settings; `linkEditorOutputFonts` syncs family; status bar `FontQuickControls` + Settings presets.

## Recent Context & Decisions

- **2026-05-24:** Phase 2 script-runner: scratch folder, copy output, welcome paste, PSSA run gate, pinned run dir, recent runs log; editor/terminal font presets with persistence and status bar quick control. Version **1.2.13**.
