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

### Build frontend assets

```bash
npm run build
```

### Build desktop app

```bash
npm run tauri build
```

## Version

Current project version: **1.2.2**

