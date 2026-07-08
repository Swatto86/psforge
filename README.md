# PSForge

PSForge is a desktop PowerShell editor built with **Tauri**, **React**, and **Monaco Editor**. It is tuned for a fast loop: **paste script from an AI or the web → clean → format → F5 → read output → paste results back for debugging**.

The default layout keeps the integrated terminal large (~72% of the vertical space) so run output is easy to read without resizing panes.

## Download

Pre-built installers are published on [GitHub Releases](https://github.com/Swatto86/psforge/releases). The in-app updater checks the same feed on startup (Settings → can disable).

| Platform | Artifacts |
|----------|-----------|
| Windows | `.msi`, setup `.exe` |
| macOS | Universal `.dmg` |
| Linux | `.deb`, `.rpm`, AppImage |

**Current version:** [1.4.1](https://github.com/Swatto86/psforge/releases/tag/v1.4.1)

## AI-assisted workflow (paste → run → debug)

Typical use with an assistant writing PowerShell for you:

1. **Get script** — Copy a fenced `powershell` block (or plain script) from chat, docs, or Teams.
2. **Paste into PSForge** — Use one of:
   - **Welcome → Paste from clipboard** — New untitled tab, clean, format, optional run.
   - **`Ctrl+Shift+Alt+V`** — Paste Clean + Format on the active tab (best default for AI output).
   - **`Ctrl+V`** — Normal paste with light cleanup when **Clean Paste** is enabled (Settings → Editor).
3. **Run** — **`F5`** (auto-save + scratch for untitled tabs when enabled).
4. **Inspect** — Terminal output below the editor; **Reference → Problems** for PSScriptAnalyzer errors.
5. **Share back** — **Copy Debug Bundle** (markdown: output + exit code + PSSA + script), **Copy Last Run**, or full **Copy Output**; paste into the AI thread.
6. **Iterate** — Edit, F5 again, or **Re-run** from Welcome **Recent runs** (restores working directory).

### Recommended settings for paste-and-run

In **Settings → Editor / Execution**:

| Setting | Suggested | Why |
|---------|-----------|-----|
| **Assistant mode** (Settings → Execution) | On | Applies all rows below in one toggle |
| Clean Paste (`Ctrl+V`) | On | Fixes smart quotes, markdown fences, `PS>` prompts from copied terminals |
| Run after Paste Clean + Format | On | One gesture after `Ctrl+Shift+Alt+V` |
| Run when Ctrl+V was cleaned | Off | Avoid accidental F5 on small edits |
| Save before F5 | On | Untitled scripts land in scratch before run |
| Auto-save untitled → scratch | On | Recovery if the app closes mid-session |
| Clear terminal before run | On | Last run output is unambiguous |
| PSSA run gate | Warn | Block bad runs only when you want strictness |
| Working directory | File or pinned preset | Module paths and `.\` relatives behave predictably |

Optional repo file **`.psforge.json`** next to your scripts (walks up from opened file):

```json
{
  "workingDirMode": "custom",
  "customWorkingDir": "C:\\Repo\\scripts",
  "pssaRunGate": "warn"
}
```

### Keyboard shortcuts (script runner)

| Keys | Action |
|------|--------|
| `Ctrl+Shift+Alt+V` | Paste Clean + Format (then optional F5 if enabled) |
| `Ctrl+V` | Paste with cleanup when Clean Paste is on |
| `F5` | Run script (or debug if breakpoints exist) |
| `F8` | Run selection or current line |
| `Shift+F5` | Stop |
| `Ctrl+Shift+P` | Command palette (copy debug bundle, output, …) |
| `Ctrl+F1` | Full shortcut list |

After paste, a **toast** summarizes cleanup (fences removed, smart quotes fixed, etc.).

More shortcuts: **Help → Keyboard Shortcuts** (`Ctrl+F1`).

## Script runner features (v1.2.15)

- **Scratch auto-save** — Untitled scripts under `%APPDATA%\PSForge\scratch\{tabId}.ps1` (Windows); orphan files offered on startup.
- **Close untitled tabs** — Save as, keep in scratch, or discard.
- **PSSA run gate** — In-app dialog on warn; block mode stops F5 until Problems are fixed.
- **Run directory** — Per-file folder, custom path, pinned folder, named **presets** in Settings.
- **Recent runs** — Welcome history: re-run, open run folder, clear, failed-run highlight.
- **Assistant mode** — One setting applies paste/run/scratch/PSSA defaults for AI workflows.
- **Paste summary** — Toast after cleanup (`Ctrl+V` or Paste Clean + Format).
- **Copy Debug Bundle** — Markdown for AI chat (terminal output, exit code, analyzer errors, script).
- **Terminal** — Copy full scrollback or **last F5 run only**; restart session from toolbar.
- **Fonts** — Editor/terminal presets + status bar quick control.

## Other capabilities

- Classic **File / Edit / View / Help** menu bar — every action is discoverable with its shortcut listed
- In-app **AI assistant** (Ask / Write / Fix) using Anthropic API, Claude CLI, OpenRouter, or Kilo CLI — or turn it off entirely with one switch in **Settings → AI** ("Copy for AI" keeps working; it's clipboard-only, for external AI chats)
- Multi-tab editor with session restore
- PowerShell 5.1 / 7 detection and selection
- Mandatory `param()` prompt before run
- Integrated debugger (breakpoints, step, watch) — enable in Settings if needed
- Module browser, Show Command, context help (`F1`)
- Snippets (`Ctrl+J`), command palette, file associations
- Script signing, print, open `$PROFILE`

## Tech stack

- **Frontend:** React 19, TypeScript, Vite, Monaco, xterm.js, Tailwind 4
- **Desktop:** Tauri 2 (Rust), PowerShell host for run/debug/PSSA/IntelliSense

## Development

### Prerequisites

- Node.js 18+ (22 in CI)
- Rust stable ([`src-tauri/rust-toolchain.toml`](src-tauri/rust-toolchain.toml))
- PowerShell (Windows PowerShell and/or PowerShell 7)
- Linux builds: WebKit/GTK dev packages (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml))

### Commands

```bash
npm ci
npm run tauri dev      # dev app
npm test               # Vitest (sanitize-paste, run-utils)
npm run build          # frontend production build
npm run tauri build    # desktop installers
./scripts/ci-local.sh  # fmt, clippy, tests, build (matches CI)
```

Machine-readable architecture notes for agents: [`AI_CONTEXT.md`](AI_CONTEXT.md).

## Possible next steps

| Idea | Benefit |
|------|---------|
| **Problems → Copy all errors** | One-click analyzer text for chat |
| **Run markers in terminal** | Visible `--- Run ---` / `--- Exit N ---` boundaries |
| **CLI launch** — `psforge script.ps1` | Open a run-ready window from tooling |
| **Per-project scratch folders** | Isolate untitled AI snippets by repo |
