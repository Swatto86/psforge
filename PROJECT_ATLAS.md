# PSForge - Project Atlas

## System Purpose

PSForge is a modern, fast PowerShell ISE replacement for Windows, built with Tauri v2 (Rust backend + WebView2 frontend). It provides a professional script editing environment with Monaco Editor, terminal-first PowerShell execution, module browsing, variable inspection, snippet management, and theming.

## Domain Concepts

| Concept                | Description                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Editor Tab**         | An open file or untitled script buffer with dirty-tracking                                                                                 |
| **PowerShell Process** | A managed child process for script execution with stdin/stdout/stderr streaming                                                            |
| **Bottom Pane**        | Tabbed area hosting the integrated terminal plus Variables, Debugger, Show Command, and Help panes                                         |
| **Module Browser**     | Sidebar listing installed PowerShell modules and their exported commands                                                                   |
| **Snippet**            | Reusable code template (built-in or user-defined) insertable via Command Palette                                                           |
| **File Association**   | Per-user HKCU registry mapping of PS extensions to PSForge (no admin required)                                                             |
| **Theme**              | CSS variable-driven visual theme (dark, light, ise-classic) synced with Monaco                                                             |
| **Param Prompt**       | Pre-run modal that collects values for mandatory `param()` parameters before execution                                                     |
| **Updater Feed**       | Signed static `latest.json` manifest published on GitHub Releases and consumed by the Tauri updater plugin                                 |

## Architecture

### Architectural Boundaries

```
+------------------------------------------------------+
|  Frontend (React + TypeScript + Vite)                |
|  - UI Components, State Management, Monaco Editor    |
|  - Communicates via Tauri IPC invoke() calls         |
+------------------------------------------------------+
        |  Tauri IPC (invoke / emit / listen)          |
+------------------------------------------------------+
|  Backend (Rust + Tauri v2)                           |
|  - PowerShell process management (tokio async)       |
|  - Settings persistence (%APPDATA%)                  |
|  - File I/O with encoding detection                  |
|  - Windows Registry for file associations            |
|  - Snippet storage                                   |
+------------------------------------------------------+
        |  OS Layer                                    |
+------------------------------------------------------+
|  Windows: PowerShell 5.1/7+, Registry, FileSystem    |
+------------------------------------------------------+
```

### Key Design Decisions

- **No Redux/Zustand**: State managed via React Context + useReducer for simplicity
- **CSS Variables for theming**: Themes defined as CSS custom properties, not Monaco-only
- **Global ProcessManager**: Single `OnceLock<ProcessManager>` shared across Tauri commands
- **Terminal-first execution**: F5/F8 runs are prepared in Rust and executed inside the integrated terminal
- **Event-based debug streaming**: Rust emits `ps-output`, `ps-variables`, `ps-debug-break`, and `ps-complete` events for debugger-host runs; frontend mirrors that output into the terminal

## Repository Structure

````
PSForge/
  index.html              # HTML shell with React mount point
  package.json            # Node dependencies and scripts
  tsconfig.json           # TypeScript config (jsx: react-jsx)
  vite.config.ts          # Vite + React + Tailwind plugins
  PROJECT_ATLAS.md        # This file

  src/                    # Frontend source (React + TypeScript)
    main.tsx              # React entry point (renders App into #root)
    App.tsx               # Main layout: toolbar, tabs, editor, bottom pane, sidebar
    types.ts              # Shared TypeScript interfaces and constants
    commands.ts           # Typed Tauri invoke() IPC wrappers
    store.tsx             # React Context + useReducer state management
    themes.ts             # Monaco theme definitions synced with CSS themes
    styles.css            # Tailwind import + CSS variable themes + global styles

    components/
      Toolbar.tsx         # Top bar: file ops, run/stop, PS version, theme
      TabBar.tsx          # Editor tabs with dirty indicators, context menu
      EditorPane.tsx      # Monaco Editor wrapper with settings sync
      OutputPane.tsx      # Bottom pane tabs for Terminal, Variables, Debugger, Show Command, and Help
      TerminalPane.tsx    # xterm.js integrated terminal (PS session via piped I/O)
      Sidebar.tsx         # Left/right sidebar with Modules browser and script Outline navigator
      StatusBar.tsx       # Bottom bar: encoding, path, running state, version, and GitHub-release updater state/actions
      SettingsPanel.tsx   # Modal settings dialog (6 sections: Editor, IntelliSense, Execution, Output/terminal, Appearance, File Associations) including startup update-check toggle
      CommandPalette.tsx  # Ctrl+Shift+P command palette with snippets
      KeyboardShortcutPanel.tsx  # F1 shortcut reference; searchable, grouped, kbd-tagged
      AboutDialog.tsx     # About modal: app name, version, description, author, GitHub link, tech stack
      ParamPromptDialog.tsx  # Pre-run modal: collects values for mandatory script params; checkbox for bool, number input for numeric, text for string
      ScriptSigningDialog.tsx  # Modal for signing the active script with an Authenticode certificate from CurrentUser\My; lists certs; Sign disabled when file unsaved or no cert

  src-tauri/              # Rust backend
    Cargo.toml            # Rust dependencies including desktop updater plugin
    tauri.conf.json       # Tauri v2 app config (window, bundle, CSP, updater endpoint/public key)
    build.rs              # Tauri build script
    capabilities/
      default.json        # Tauri v2 permissions (core, dialog, fs, events, updater)

    src/
      main.rs             # Rust entry point (calls lib::run)
      lib.rs              # Tauri app builder: plugins, commands, logger init, updater plugin registration
      errors.rs           # AppError type + BatchResult<T> / BatchError for batch ops (Rule 11)
      powershell.rs       # ProcessManager: execute, stop, stdin, discover versions
      settings.rs         # AppSettings: load/save %APPDATA%/PSForge/settings.json; load_from/save_to for test injection, including startup updater preference
      commands.rs         # Tauri command handlers for execution, debugging, settings, file ops, and analysis
      terminal.rs         # Integrated terminal: start_terminal, terminal_exec, stop_terminal
      utils.rs            # with_retry: transient-error retry helper (Rule 11)

    tests/
      settings_e2e.rs         # Settings load/save/corrupt JSON/roundtrip
      file_ops_e2e.rs         # File read/save/encoding detection/validation guards
      snippets_e2e.rs         # Builtin + user snippet management/corruption recovery
      batch_associations_e2e.rs  # Registry association register/unregister/batch
      failure_modes_e2e.rs    # Corrupt settings, empty paths, BatchResult caps
      execution_policy_e2e.rs # Execution policy validation and injection prevention
      encoding_edge_cases_e2e.rs  # Encoding boundary conditions and regression tests```

## Entry Points and APIs

### Frontend Entry
- `src/main.tsx` -> renders `<App />` inside `<AppProvider>` (state context)

### Backend Entry
- `src-tauri/src/main.rs` -> calls `psforge_lib::run()`
- `src-tauri/src/lib.rs` -> builds Tauri app with plugins + command handlers

### Tauri IPC Commands

| Command | Module | Description |
|---------|--------|-------------|
| `prepare_terminal_script_command` | commands | Build a terminal-safe PowerShell command string for F5/F8 runs; writes the user script to a secure temp `.ps1` wrapper and cleans it up afterwards |
| `execute_script_debug` | commands | Run a script under the debugger host with optional breakpoints; output/events are mirrored into the integrated terminal |
| `stop_script` | commands | Kill the running PS process |
| `send_stdin` | commands | Write to running process stdin |
| `get_ps_versions` | commands | Discover installed PowerShell versions |
| `get_installed_modules` | commands | List PS modules via Get-Module |
| `get_module_commands` | commands | List commands in a specific module |
| `get_variables_after_run` | commands | Retrieve the cached variable snapshot captured from the last completed execution without re-running the script |
| `read_file_content` | commands | Read file with encoding detection |
| `save_file_content` | commands | Write file with specified encoding |
| `load_settings` | commands | Load settings from %APPDATA% |
| `save_settings` | commands | Persist settings to %APPDATA% |
| `register_file_association` | commands | Register extension in HKCU registry |
| `unregister_file_association` | commands | Remove extension from HKCU registry |
| `get_file_association_status` | commands | Check if extension is associated |
| `get_snippets` | commands | Get built-in + user snippets |
| `save_user_snippets` | commands | Save user snippet collection |
| `reveal_in_explorer` | commands | Open file in Windows Explorer (select it) |
| `batch_register_file_associations` | commands | Register multiple extensions; accumulates errors (Rule 11) |
| `batch_unregister_file_associations` | commands | Unregister multiple extensions; accumulates errors (Rule 11) |
| `analyze_script` | commands | Run PSScriptAnalyzer on script content; returns `PssaDiagnostic[]`; returns `[]` when module absent or on timeout |
| `get_completions` | commands | TabExpansion2 completions at cursor offset; returns `PsCompletion[]`; returns `[]` on timeout or error |
| `get_launch_path` | commands | Return file path passed as CLI arg when launched via file-type association; returns `null` for normal launches |
| `get_script_parameters` | commands | Inspect a script's `param()` block via the PS AST; returns `ScriptParameter[]`; env-var transport avoids all escaping hazards; gracefully returns `[]` on timeout or large scripts (>32 KB) |
| `get_execution_policy` | commands | Query the current PowerShell execution policy (via `Get-ExecutionPolicy`) |
| `set_execution_policy` | commands | Set execution policy in the current user scope; validated against allow-list (Rule 11) |
| `format_script` | commands | Format script content with `Invoke-Formatter` (PSScriptAnalyzer); returns original if module absent or on timeout (`FORMAT_TIMEOUT_SECS=10`); env-var transport avoids escaping hazards |
| `get_ps_profile_path` | commands | Return `$PROFILE.CurrentUserCurrentHost` path for the selected PS version; creates parent directory if absent (`PROFILE_TIMEOUT_SECS=10`) |
| `get_signing_certificates` | commands | Enumerate `Cert:\CurrentUser\My` for code-signing certificates; returns empty vec (not error) when none found (`CERT_ENUM_TIMEOUT_SECS=10`) |
| `sign_script` | commands | Sign a saved `.ps1` file with `Set-AuthenticodeSignature`; validates thumbprint (40-char hex) and file path before invoking PS (`SIGN_TIMEOUT_SECS=30`) |
| `start_terminal` | terminal | Start interactive PS session with piped I/O |
| `terminal_write` | terminal | Send raw keystroke/input data to the active terminal session |
| `terminal_exec` | terminal | Execute a command in the active terminal session |
| `stop_terminal` | terminal | Stop and clean up the terminal session |

### Tauri Events (emitted from Rust)

| Event | Payload | Description |
|-------|---------|-------------|
| `ps-output` | `OutputLine` | Stdout/stderr line emitted by the debugger host; frontend mirrors it into the integrated terminal |
| `ps-variables` | `VariableInfo[]` | Variable snapshot captured from the completed debugger-host session |
| `ps-debug-break` | `number` | 1-based source line where the debugger host paused |
| `ps-complete` | `{ exit_code }` | Debugger-host execution completed |
| `terminal-output` | `string` | A stdout line from the interactive terminal session |
| `terminal-stderr` | `string` | A stderr line from the interactive terminal session, including terminal-first F5/F8 runs |
| `terminal-done` | `null` | The REPL sentinel was seen; the active terminal command completed |
| `terminal-exit` | `null` | The terminal child process has exited |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New tab |
| Ctrl+O | Open file |
| Ctrl+S | Save current file |
| Ctrl+Shift+S | Save all open files |
| Ctrl+W | Close active tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next/previous tab |
| F5 | Run entire script |
| F8 | Run selected text (or current line) |
| Ctrl+Break | Stop execution |
| Ctrl+Shift+P | Command Palette |
| Ctrl+, | Settings |
| Ctrl+B | Toggle sidebar |
| Shift+Alt+F | Format document (requires PSScriptAnalyzer) |
| Ctrl+H | Find & Replace (Monaco built-in) |
| Drag & Drop | Drop .ps1/.psm1 file onto window to open it |

## Build / Test / CI / Release

### Build Commands

```bash
# Frontend only
npm run build          # tsc + vite build

# Full Tauri build (frontend + Rust + installers)
npx tauri build        # Produces .exe, .msi, .nsis

# Development mode with hot reload
npx tauri dev
````

### Rust Quality Gates

```bash
cd src-tauri
cargo fmt              # Format
cargo clippy -- -D warnings  # Lint (zero warnings)
cargo test             # 86 tests (23 unit + 63 integration)
```

### Release Publishing

- `update-application.ps1` is the authoritative release entrypoint.
- It updates versioned manifests, refreshes `package-lock.json`, runs frontend and Rust quality gates, then runs `npm run tauri build` with `bundle.createUpdaterArtifacts = true`.
- The script uploads the NSIS installer, MSI installer, both `.sig` files, and a generated `latest.json` manifest to the GitHub Release for `vX.Y.Z`.
- The in-app updater is configured against `https://github.com/Swatto86/psforge/releases/latest/download/latest.json` and currently consumes the signed NSIS installer for `windows-x86_64` updates.
- The updater signing key must remain stable across releases. The script defaults to `~/.tauri/psforge-updater.key` when the signing env vars are unset, loads that key for Tauri bundling, and uses `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key is password-protected.

### Integration Tests

| Test File                          | Coverage                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `tests/settings_e2e.rs`            | Settings load/save/corrupt JSON/roundtrip (8 tests)                                   |
| `tests/file_ops_e2e.rs`            | File read/save/encoding detection/validation guards (12 tests)                        |
| `tests/snippets_e2e.rs`            | Builtin + user snippet management/corruption recovery (9 tests)                       |
| `tests/batch_associations_e2e.rs`  | Registry association register/unregister/batch (6 tests)                              |
| `tests/failure_modes_e2e.rs`       | Corrupt settings, empty paths, BatchResult caps, edge cases (13 tests)                |
| `tests/execution_policy_e2e.rs`    | Execution policy validation: invalid/empty/injection/case-insensitive (6 tests)       |
| `tests/encoding_edge_cases_e2e.rs` | Encoding boundaries: zero-byte, BOM-only, UTF-16LE/BE, large file, fallback (9 tests) |

### Frontend WebDriver E2E Tests

Runs the app binary under WebView2 remote-debugging via WebdriverIO v7 + msedgedriver.

```bash
npm run test:e2e                     # All 11 specs
npm run test:e2e:params              # Mandatory parameter prompt (7 tests)
npm run test:e2e:app                 # App layout / navigation (22 tests)
npm run test:e2e:about               # About dialog (16 tests)
npm run test:e2e:editor              # Monaco editor integration (9 tests)
npm run test:e2e:script-run          # Script execution / output streaming (8 tests)
npm run test:e2e:intellisense        # PS completions / suggest widget (14 tests)
npm run test:e2e:settings            # Settings modal (32 tests)
npm run test:e2e:syntax-highlighting # Syntax highlighting in editor + terminal (33 tests)
npm run test:e2e:terminal            # Integrated terminal (19 tests)
npm run test:e2e:variables           # Variables tab (23 tests)
npm run test:e2e:features            # New ISE-parity features: format, find/replace, drag-drop, profile, signing, print
npm run test:e2e:session-restore     # Session restore: disk reload + dirty-buffer recovery
```

| Spec                              | Tests | Coverage                                                                                                                                                                                                       |
| --------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/app.spec.ts`                 | 22    | Layout, sidebar, settings panel, theme switch, keyboard shortcuts                                                                                                                                              |
| `e2e/about.spec.ts`               | 16    | About dialog open/close/content/Escape/backdrop                                                                                                                                                                |
| `e2e/editor.spec.ts`              | 9     | Monaco editor: open file, edit, save, tab management                                                                                                                                                           |
| `e2e/script-run.spec.ts`          | 9     | F5/F8 run (including current-line F8), stdin, stop, error output                                                                                                                                               |
| `e2e/intellisense.spec.ts`        | 14    | PS completion triggers, parameter/cmdlet/variable/multiline completions                                                                                                                                        |
| `e2e/settings.spec.ts`            | 32    | Settings modal sections, select widths, toggles, theme switch                                                                                                                                                  |
| `e2e/syntax-highlighting.spec.ts` | 33    | Monaco + terminal ANSI highlighting for keywords/cmdlets/params/types                                                                                                                                          |
| `e2e/terminal.spec.ts`            | 19    | Tab nav, session startup, keyboard input, commands, history, CWD bar                                                                                                                                           |
| `e2e/variables.spec.ts`           | 23    | Variable population, filter, type/value/name columns, built-ins                                                                                                                                                |
| `e2e/session-restore.spec.ts`     | 2     | Clean file-backed tab restore from disk and dirty-buffer recovery when the backing file is gone                                                                                                                |
| `e2e/params.spec.ts`              | 7     | Mandatory param dialog appear/cancel/run, multi-param, types, default bypass, disabled Run btn                                                                                                                 |
| `e2e/features.spec.ts`            | ~23   | Format toolbar button states, Find/Replace shortcut, drag-drop event handlers, profile button, signing dialog open/close/cert-list, print button states, bottom-pane text-mode undo, pane-local clear behavior |

**Test infrastructure:** `wdio.conf.cjs` — starts Vite dev server → launches debug binary with `--enable-remote-debugging=9222` → starts msedgedriver matching WebView2 runtime version → connects WebdriverIO. Teardown kills all three in reverse order.

### Frontend Quality Gates

```bash
npx tsc --noEmit       # Type check
npx prettier --write "src/**/*.{ts,tsx,css}"  # Format
```

### Build Outputs

| Artifact       | Path                                                               |
| -------------- | ------------------------------------------------------------------ |
| Executable     | `src-tauri/target/release/psforge.exe`                             |
| MSI Installer  | `src-tauri/target/release/bundle/msi/PSForge_X.Y.Z_x64_en-US.msi`  |
| NSIS Installer | `src-tauri/target/release/bundle/nsis/PSForge_X.Y.Z_x64-setup.exe` |

## Configuration

### Settings File

- **Location**: `%APPDATA%/PSForge/settings.json`
- **Format**: JSON with camelCase keys
- **Fields**:
  - _Core_: `defaultPsVersion`, `theme`, `fontSize`, `fontFamily`, `wordWrap`, `showTimestamps`, `splitPosition`, `recentFiles`, `fileAssociations`
  - _Editor_: `tabSize`, `insertSpaces`, `showMinimap`, `lineNumbers`, `renderWhitespace`, `showIndentGuides`, `stickyScroll`, `enablePssa`, `enableIntelliSense`
  - _Execution_: `autoSaveOnRun`, `clearOutputOnRun`, `executionPolicy`, `workingDirMode` (`"file"` | `"custom"`), `customWorkingDir`
  - _Output/terminal_: `terminalLoadProfile`, `outputFontSize`, `outputFontFamily`, `outputWordWrap`, `maxRecentFiles`
- **Defaults**: Auto PS version, dark theme, 14px, Cascadia Code, no wrap, no timestamps, 65% split, tab size 4, spaces, PSSA on, IntelliSense on, clear output on run, max 20 recent files
- **Font note**: `fontSize`/`fontFamily` apply to the entire UI via `--ui-font-size` / `--ui-font-family` CSS custom properties; `outputFontSize`/`outputFontFamily` apply to the terminal and the auxiliary bottom-pane views

### User Snippets

- **Location**: `%APPDATA%/PSForge/snippets.json`
- **Format**: JSON array of `{ prefix, label, body, description, category }` objects

### Tauri Permissions

- `core:default` - Basic Tauri functionality
- `opener:default` - URL/file opening
- `dialog:default` - Native file dialogs
- `fs:default` - Filesystem access
- `core:event:default` - Event system

## Dependencies

### Rust (src-tauri/Cargo.toml)

| Crate               | Version    | Purpose                                |
| ------------------- | ---------- | -------------------------------------- |
| tauri               | 2          | Application framework                  |
| tauri-plugin-dialog | 2          | Native file dialogs                    |
| tauri-plugin-fs     | 2          | Filesystem access                      |
| tauri-plugin-opener | 2          | URL/file opening                       |
| serde / serde_json  | 1          | Serialization                          |
| tokio               | 1 (full)   | Async runtime for process management   |
| winreg              | 0.55       | Windows registry for file associations |
| log / env_logger    | 0.4 / 0.11 | Structured logging                     |
| dirs                | 6          | Platform directory resolution          |
| uuid                | 1 (v4)     | Unique ID generation                   |
| encoding_rs         | 0.8        | Character encoding detection           |

**Dev Dependencies:**

| Crate    | Version | Purpose                                                                        |
| -------- | ------- | ------------------------------------------------------------------------------ |
| tempfile | 3       | OS-managed temp directories for integration tests (never touches real AppData) |

### Frontend (package.json)

| Package                   | Purpose                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| react / react-dom         | UI framework                                                       |
| @monaco-editor/react      | Code editor component                                              |
| @tauri-apps/api           | Tauri IPC bridge                                                   |
| @tauri-apps/plugin-dialog | Dialog API                                                         |
| @tauri-apps/plugin-fs     | FS API                                                             |
| xterm + xterm-addon-fit   | Integrated terminal renderer                                       |
| xterm-addon-web-links     | Auto-link URLs and file-like paths inside terminal output          |
| @tailwindcss/vite         | Tailwind CSS v4                                                    |
| @vitejs/plugin-react      | Vite React support                                                 |
| typescript ~5.6           | Type system                                                        |

## Types Reference

### Rust (errors.rs)

| Type                                 | Description                                    |
| ------------------------------------ | ---------------------------------------------- |
| `AppError { code, message }`         | All Tauri command errors; serialized for IPC   |
| `BatchError { item, code, message }` | Per-item error in a batch operation            |
| `BatchResult<T> { items, errors }`   | Batch op result: successes + capped error list |
| `MAX_BATCH_ERRORS: usize`            | Cap on per-batch error accumulation (100)      |

### Testability Helpers

| Function                                             | Description                                      |
| ---------------------------------------------------- | ------------------------------------------------ |
| `settings::load_from(&path)`                         | Load settings from explicit path (used in tests) |
| `settings::save_to(&path, &settings)`                | Save settings to explicit path (used in tests)   |
| `commands::get_snippets_from(path)`                  | Load snippets from explicit path (used in tests) |
| `commands::save_user_snippets_to(&path, &[Snippet])` | Save snippets to explicit path (used in tests)   |

### Frontend Types (types.ts)

| Type                                                     | Description                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `CertInfo { thumbprint, subject, expiry, friendlyName }` | Code-signing certificate from `Cert:\CurrentUser\My`; returned by `get_signing_certificates` |

### Terminal E2E Window Globals

Registered by `TerminalPane.tsx`'s mount effect and cleaned up on unmount. Exposed on `window` so WebDriver E2E tests can inspect/drive the terminal without going through OS keyboard events (which xterm and WebView2 can intercept or drop):

| Global                                           | Signature                        | Description                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window.__psforge_terminal_get_content`          | `(lineCount?: number) => string` | Read the last N lines from xterm's active buffer as plain text. Used because canvas rendering makes DOM text inaccessible to WebDriver.                             |
| `window.__psforge_terminal_is_ready`             | `() => boolean`                  | Returns `isReadyRef.current` — true when the PS REPL is running and accepting input.                                                                                |
| `window.__psforge_terminal_submit_current_input` | `() => void`                     | Mirrors the onData `'\r'` branch: submits `inputBufferRef.current` as a command. Used in tests to verify command execution independently of keyboard Enter routing. |
| `window.__psforge_terminal_reset_input`          | `() => void`                     | Clears `inputBufferRef`, repositions cursor to 0, writes `\r\n` + fresh prompt. Used in `beforeEach` for isolation without relying on Ctrl+C.                       |
| `window.__psforge_terminal_clear`                | `() => void`                     | Calls `term.clear()` + fresh prompt.                                                                                                                                |
| `window.__psforge_terminal_focus`                | `() => void`                     | Calls `term.focus()` + `fitAddon.fit()`.                                                                                                                            |
| `window.__psforge_terminal_restart`              | `() => void`                     | Resets restart counter and calls `startSession(false)`.                                                                                                             |
| `window.__psforge_dispatch`                      | `(action: Action) => void`       | Exposes the store reducer dispatch for E2E tests (e.g. `TOGGLE_SIGNING_DIALOG`). Registered by `App.tsx` alongside other test globals.                              |

## Critical Invariants

1. **Single PowerShell process**: Only one script can execute at a time (enforced by `ProcessManager` mutex)
2. **Settings auto-persist**: Settings changes are debounced (1s) and auto-saved to disk
3. **Theme sync**: CSS variable theme and Monaco theme must always match (both set on theme change)
4. **No admin required**: File associations use HKCU only, never HKLM
5. **Hidden-host output bounded**: Max 100,000 lines retained per backend PowerShell process (`MAX_OUTPUT_LINES`)
6. **Encoding preservation**: Files are read with encoding detection and saved with the same encoding
7. **Event-based streaming**: Script output is never polled; Rust pushes events as lines arrive
8. **TerminalPane always mounted**: The integrated terminal is rendered unconditionally with CSS `display: none`/`"flex"` to prevent the PS session from being killed on tab switch
9. **Content Security Policy**: CSP is enforced in `tauri.conf.json` restricting scripts/styles/connections to self-origin, blob workers (Monaco), inline styles (Tailwind), and IPC protocols
10. **Monaco loader must use local package**: `src/main.tsx` calls `loader.config({ monaco })` to force `@monaco-editor/react` to use the locally installed `monaco-editor` npm package instead of the CDN default (`cdn.jsdelivr.net`). The CDN is blocked by Tauri's CSP; without this call the editor silently hangs on "Loading editor...". The editor worker is configured via `self.MonacoEnvironment.getWorker` using Vite's `?worker` import suffix (`import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"`). The `new URL(…, import.meta.url)` pattern must NOT be used for bare npm specifiers — Rollup resolves them relative to the HTML root and the build fails. Vite type support for `?worker` requires `src/vite-env.d.ts` with `/// <reference types="vite/client" />`.
11. **Terminal `onData` must parse VT escape sequences**: xterm.js delivers raw VT byte sequences (e.g. `\x1b[D` for left-arrow) to the `onData` callback. Only the `\x1b` byte is below the printable threshold; the remainder (`[D`) passes the `ch >= " "` check and would be silently appended to the input buffer as literal text, corrupting commands. `TerminalPane.tsx` handles this via `escapeSeqRef` which accumulates CSI (`\x1b[`) and SS3 (`\x1bO`) sequences across characters until a recognised terminator, then dispatches to `handleEscapeSequence()`. Arrow keys, Home/End, and Delete are mapped to proper line-editing operations; all other sequences are discarded.
12. **Monaco completion item range must replace the partial token**: TabExpansion2 returns the _full_ completion text (e.g. `Get-ChildItem` when the editor contains `Get-C`). The Monaco `CompletionItem.range` must span from the start of the incomplete token back to the cursor; a zero-width range at the cursor causes Monaco to _insert_ rather than _replace_, producing doubled text. `EditorPane.tsx` calculates `tokenStart` by scanning backwards from the cursor offset over characters that are not PS word boundaries (`\s,;|(){}[]` etc.) and passes the resulting range to both registered completion providers.
13. **`settlingRef` and `isReadyRef` ordering in terminal-exit handler**: `start_terminal` in Rust internally calls `kill_session()` before spawning a new process. The killed session's stdout reader fires `terminal-exit` asynchronously. By the time this event arrives at the JS terminal-exit handler, the new React effect run has already reset `isStoppingRef` to `false`, so the handler would mistakenly schedule a restart — which would kill the just-started session, fire another `terminal-exit`, and loop until all 5 restart attempts were exhausted. Fix: `startSession()` sets `settlingRef.current = true` before calling `startTerminal()` and keeps it true for `SETTLE_MS` (3000 ms) after the promise resolves. The terminal-exit handler **checks `settlingRef`/`isStoppingRef` BEFORE setting `isReadyRef.current = false`** — the fast-return must come first; otherwise stale exits from React StrictMode's first-run cleanup (which arrive during the second run's settle window) permanently corrupt `isReadyRef.current`, leaving the live session unable to accept input even though the PS REPL process is healthy. `settlingRef` is cleared in effect cleanup (where `isStoppingRef` takes over), and reset to `false` at the start of each new effect run. This same guard pattern applies in React StrictMode: effects run twice; the first run's cleanup fires `stopTerminal()`; the resulting `terminal-exit` arrives during the second run's settle window — must be discarded without touching `isReadyRef`.

## Debug Mode

- **Rust logging**: Set `RUST_LOG=debug` environment variable before launching
- **Output**: Written to stderr (visible in terminal when running `npx tauri dev`)
- **Activation**: `$env:RUST_LOG="debug"; npx tauri dev`
- **Default**: `info` level in dev, disabled in release
