# PSForge

**A modern, fast PowerShell ISE replacement for Windows.**

PSForge is a native desktop application built with [Tauri v2](https://tauri.app/) (Rust backend + WebView2 frontend). It provides Monaco Editor, streamed script execution, an integrated terminal, module browsing, variable inspection, snippet management, and full theming — without requiring the legacy Windows PowerShell ISE or VS Code.

---

## Features

| Feature                 | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| **Monaco Editor**       | Syntax highlighting, IntelliSense, find/replace, multi-cursor                 |
| **Script Execution**    | Run full scripts (F5) or selection/current line (F8); streamed stdout/stderr  |
| **Integrated Terminal** | xterm.js-based persistent PowerShell session                                  |
| **Module Browser**      | Sidebar listing installed modules with expandable command lists               |
| **Outline Navigator**   | Sidebar outline of functions/classes/regions with click-to-jump               |
| **Variables Inspector** | View all variables after a script run                                         |
| **Problems Panel**      | Parse and navigate stderr errors with line/column references                  |
| **Snippet Library**     | 20 built-in PowerShell templates + user-defined snippets via Command Palette  |
| **File Associations**   | Register PSForge as the default .ps1/.psm1/.psd1 handler (per-user, no admin) |
| **Themes**              | Dark, Light, and ISE-Classic themes synced across editor and UI               |
| **Multiple Tabs**       | Drag-and-drop tab reorder, dirty indicators, recent files                     |
| **Encoding Support**    | Detect and preserve UTF-8, UTF-8 BOM, and UTF-16 LE/BE                        |

---

## Requirements

| Requirement      | Minimum Version          | Notes                                                 |
| ---------------- | ------------------------ | ----------------------------------------------------- |
| Windows          | 10 (64-bit)              | WebView2 is pre-installed on Win 10/11                |
| PowerShell       | 5.1 (Windows PowerShell) | 7.x also supported and preferred                      |
| WebView2 Runtime | Any                      | Included with Windows 10/11; auto-installed if absent |

PSForge does **not** require the .NET SDK, Node.js, or any other runtime at deploy time. All dependencies are bundled in the installer.

---

## Installation

### From GitHub Releases (recommended)

1. Download the latest `PSForge_1.0.6_x64-setup.exe` from the [Releases page](../../releases).
2. Run the installer -- no administrator rights required for per-user install.
3. Launch **PSForge** from the Start Menu or by double-clicking any `.ps1` file (after registering associations in Settings).

### From the MSI (enterprise / silent install)

```powershell
msiexec /i PSForge_1.0.6_x64_en-US.msi /quiet
```

---

## Quick Start

| Action          | Keyboard Shortcut |
| --------------- | ----------------- |
| New file        | Ctrl+N            |
| Open file       | Ctrl+O            |
| Save file       | Ctrl+S            |
| Save all files  | Ctrl+Shift+S      |
| Close tab       | Ctrl+W            |
| Next / Previous tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Run script      | F5                |
| Run selection/current line | F8           |
| Stop execution  | Ctrl+Break        |
| Command Palette | Ctrl+Shift+P      |
| Toggle Sidebar  | Ctrl+B            |
| Find & Replace  | Ctrl+H            |
| Settings        | Ctrl+,            |
| Zoom in / out   | Ctrl+= / Ctrl+-   |

---

## Building from Source

### Prerequisites

```powershell
# 1. Install Rust (https://rustup.rs/)
winget install Rustlang.Rustup

# 2. Install Node.js 18+
winget install OpenJS.NodeJS.LTS

# 3. Install dependencies
cd psforge
npm install
```

### Clone and Build

```powershell
git clone https://github.com/YOUR_ORG/psforge
cd psforge
npm install
npx tauri build
```

The installer and MSI are placed in `src-tauri/target/release/bundle/`.

### Development Mode

```powershell
npx tauri dev
```

This starts Vite with HMR and a live-reload Tauri window.

---

## Architecture

```
+------------------------------------------------------+
|  Frontend  (React + TypeScript + Vite + Tailwind)    |
|  Monaco Editor, xterm.js, React Context + useReducer |
+------------------------------------------------------+
         Tauri IPC  (invoke / emit / listen)
+------------------------------------------------------+
|  Backend  (Rust + Tauri v2 + tokio)                  |
|  Process management, file I/O, settings, registry    |
+------------------------------------------------------+
         OS Layer
+------------------------------------------------------+
|  Windows: PowerShell 5.1/7+, HKCU registry, FS      |
+------------------------------------------------------+
```

Key design decisions and the full repository map are documented in [PROJECT_ATLAS.md](PROJECT_ATLAS.md).

---

## Testing

### Rust Backend (68 tests)

```powershell
cd src-tauri
cargo test
```

Integration tests cover:

- Settings load/save + corruption recovery
- File I/O round-trips for UTF-8, UTF-8 BOM, UTF-16 LE
- File size (10 MiB) and path length (1 024 char) validation guards
- Snippet management -- builtins, user snippets, corruption recovery
- File association register/unregister round-trip (Windows registry)
- Batch operation error accumulation (`BatchResult`)
- Failure modes: corrupt JSON, missing files, oversized payloads

### Frontend TypeScript Check

```powershell
npx tsc --noEmit
```

---

## Debug / Verbose Logging

Set the `RUST_LOG` environment variable before launching PSForge to enable verbose backend diagnostic output:

```powershell
# Show all debug-level messages from the PSForge backend
$env:RUST_LOG = "psforge=debug"
.\PSForge.exe
```

Log levels: `error`, `warn`, `info` (default), `debug`, `trace`.

Output is written to **stderr** / the Windows Debug Console. It is also visible when launching from a terminal. Secrets, tokens, and PII are never written to diagnostic output at any log level.

---

## Release Process

The release pipeline is automated by `update-application.ps1` in the repo root. The script bumps version numbers, runs quality gates (build, format, lint, test), creates a signed git tag, and pushes to origin. GitHub Actions then builds the installer and attaches it to the release.

```powershell
# Release version 1.0.6
.\update-application.ps1 -Version 1.0.6

# Preview what would happen (no changes made)
.\update-application.ps1 -Version 1.0.6 -DryRun
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full release and contribution guidelines.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT -- see [LICENSE](LICENSE).
