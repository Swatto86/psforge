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
| Welcome quick start | `src/components/WelcomePane.tsx` (paste, recent runs, re-run) |
| Scratch / project runner | `src/scratch-utils.ts`, `src/project-config.ts`, `src/run-dir-presets.ts` |
| Phase 3 dialogs | `src/components/ScratchRecoveryDialog.tsx`, `CloseScratchDialog.tsx`, `PssaRunGateDialog.tsx` |
| Assistant / debug | `src/assistant-mode.ts`, `src/debug-bundle.ts`, `src/paste-summary.ts`, `src/components/ToastStack.tsx` |
| Status bar | `src/components/StatusBar.tsx` (run CWD pin, font, last run) |
| Settings | `src/components/SettingsPanel.tsx`, `src-tauri/src/settings.rs` |
| Types / defaults | `src/types.ts` |

## Data Flow — script runner

1. **Paste:** Ctrl+V sanitize; Ctrl+Shift+Alt+V or Welcome **Paste from clipboard** → clean → format → optional F5.
2. **Scratch:** Untitled tabs auto-save to `%APPDATA%/PSForge/scratch/{tabId}.ps1`; orphans offered via `list_scratch_files` + `ScratchRecoveryDialog`; close via `CloseScratchDialog`.
3. **Run:** `resolveExecutionWorkDir()` + optional override; `.psforge.json` via `findProjectConfig`; presets in `settings.runDirPresets`; PSSA gate uses `PssaRunGateDialog` when warn.
4. **Output:** `__psforge_copy_terminal_output` (full scrollback); `__psforge_copy_last_run_output` (from `lastRunOutputStartLineRef` + line count).
5. **Fonts:** `fontFamily` / `outputFontFamily` + sizes persist in Rust settings; `linkEditorOutputFonts` syncs family; status bar `FontQuickControls` + Settings presets.

## Primary user workflow

Human + AI loop: script generated externally → **Paste Clean + Format** (`Ctrl+Shift+Alt+V`) or Welcome paste → **F5** → **Copy Debug Bundle** / Problems → feedback to AI. **Assistant mode** (`assistant-mode.ts`), **paste summary** toasts (`ToastStack`, `sanitizePastedTextWithSummary`), **debug bundle** (`debug-bundle.ts`, `__psforge_copy_debug_bundle`).

## Recent Context & Decisions

- **2026-06-01:** Optional "Open with PSForge" right-click menu (`register_context_menu`/`unregister_context_menu`/`get_context_menu_status`, Settings → File Associations toggle); status-bar run-dir link now toggles pin/unpin; file-association registration writes a proper `Applications\<exe>` Open With entry (FriendlyAppName + icon + command + SupportedTypes) and a ProgID FriendlyAppName to fix the broken/iconless Open With entry. Version **1.2.16**.
- **2026-05-25:** Phase 4 assistant workflow: `assistantMode` setting, paste summary toasts, Copy Debug Bundle, `ToastStack`. Version **1.2.15**.
- **2026-05-25:** README rewritten for AI paste-and-run workflow, releases link, shortcut table.
- **2026-05-25:** Phase 3 script-runner: scratch recovery dialog, untitled close (save/keep/discard), recent-run re-run/open folder/clear, `.psforge.json` + run-dir presets, in-app PSSA warn dialog, copy last run output, Vitest for `sanitize-paste`/`run-utils`. Version **1.2.14**.
- **2026-05-24:** Phase 2 script-runner: scratch folder, copy output, welcome paste, PSSA run gate, pinned run dir, recent runs log; editor/terminal font presets with persistence and status bar quick control. Version **1.2.13**.
- **2026-05-24:** `src-tauri/rust-toolchain.toml` pins **stable** + rustfmt/clippy (matches CI; fixes edition2024/zbus_names on older default Rust). Local `./scripts/ci-local.sh` uses it automatically.
