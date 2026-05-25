# PSForge

PSForge is a modern desktop PowerShell editor/IDE built with **Tauri**, **React**, and **Monaco Editor**.

It is designed to make scripting faster and safer with an integrated editing, execution, and debugging workflow.

## What the utility does

PSForge helps you:

- Write PowerShell scripts with syntax-aware editing
- Run scripts directly from the app
- Debug scripts with break/step controls
- View output and interactive terminal streams in one workspace
- Inspect variables and command/help metadata while you work
- Manage editor settings, snippets, and recent files

## Script runner (Phase 2–3)

Focused workflow for day-to-day scripting:

- **Paste & run** — Clean clipboard junk on paste; optional run after Paste Clean + Format (`Ctrl+Shift+Alt+V`) or sanitized `Ctrl+V`
- **Scratch auto-save** — Untitled scripts save under `%APPDATA%/PSForge/scratch`; **recovery on startup** for orphan scratch files
- **Close untitled tabs** — Save as, keep in scratch, or discard the scratch copy
- **PSSA run gate** — Warn or block F5 when PSScriptAnalyzer reports errors (in-app dialog in warn mode)
- **Run directory** — File / custom / pinned CWD; **named presets** in Settings; optional **`.psforge.json`** beside project scripts
- **Recent runs** — Welcome pane history with re-run, open run folder, clear list, and failed-run highlighting
- **Terminal output** — Copy full scrollback or **copy last F5 run** only
- **Fonts** — Editor/terminal presets with status-bar quick controls

Example `.psforge.json` in a repo:

```json
{
  "workingDirMode": "custom",
  "customWorkingDir": "C:\\Repo\\scripts",
  "pssaRunGate": "warn"
}
```

## Key features

- Multi-tab script editor
- Integrated terminal and output panes
- PowerShell version detection and selection
- Script parameter inspection/prompting
- Command palette and keyboard shortcuts
- Command/module/help discovery tools
- File association support for PowerShell-related extensions

## Tech stack

- Frontend: React + TypeScript + Vite + Monaco Editor
- Desktop runtime/backend: Tauri (Rust)

## Getting started

### Prerequisites

- Node.js 18+ (recommended)
- Rust toolchain (required by Tauri)
- PowerShell (Windows PowerShell and/or PowerShell 7)

### Install dependencies

```bash
npm ci
```

### Run in development

```bash
npm run tauri dev
```

### Run frontend unit tests

```bash
npm test
```

### Build frontend assets

```bash
npm run build
```

### Build desktop app

```bash
npm run tauri build
```

### Local CI (matches GitHub Actions)

```bash
./scripts/ci-local.sh
```

## Version

Current project version: **1.2.14**
