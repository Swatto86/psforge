# PSForge Architecture

PSForge is a Tauri 2 desktop application. React owns the editor UI and session
state; Rust owns operating-system access, PowerShell processes, persistence,
and other trusted I/O.

## Runtime boundaries

1. `src/main.tsx` mounts the React application.
2. `src/App.tsx` composes user workflows and delegates state transitions to
   `src/store.tsx`.
3. Components under `src/components/` render the presentation layer and invoke
   application callbacks.
4. `src/commands.ts` is the typed frontend IPC boundary. It is the only normal
   route from frontend workflows to Tauri commands.
5. `src-tauri/src/lib.rs` is the backend composition root. It registers plugins,
   command handlers, startup cleanup, and window/tray lifecycle behavior. Closing
   the main window hides it. The tray's Exit action asks the frontend to flush
   pending settings and exit (with a backend force-exit timeout if the webview
   is unresponsive). On macOS, clicking the Dock icon reopens the hidden window;
   on Linux, appindicators emit no click events so the tray menu's Show item is
   the restore path.
6. Backend modules own their I/O concerns: `powershell.rs` and `terminal.rs`
   manage processes; `settings.rs` owns persisted settings; `commands.rs`
   handles file, analysis, signing, and association commands; `ai.rs`,
   `ai_opencode.rs`, and `ai_ollama.rs` own AI provider calls (OpenCode and
   local Ollama included). The AI tab (`AiProviderBar.tsx`) writes provider
   and model through the same settings save path as Settings. Each Ask / Write
   / Fix request attaches a frontend-built debug bundle (`debugBundle`) so the
   model sees the active script, last run, and PSSA findings without a copy step.

## Dependency direction

- Presentation components depend on frontend application state, callbacks, and
  pure utilities.
- Frontend application workflows depend on the typed IPC boundary, never on
  Rust implementation details.
- Backend commands depend on focused backend modules and shared error/util
  helpers.
- Pure utilities (`src/*-utils.ts`, `src-tauri/src/utils.rs`) do not depend on
  presentation code.

Cross-boundary contracts are camelCase TypeScript types mapped to snake_case
Rust fields through Serde. Event names and payloads are defined at their emit
and listen sites; changes must update both sides in one commit.

## State and persistence

- `src/store.tsx` is the authoritative in-memory frontend state reducer.
- User settings persist through `load_settings` / `save_settings`.
- Open-tab session metadata persists in local storage.
- Untitled scripts use scratch files until saved or explicitly discarded.
- Bookmarks and breakpoints are keyed by tab id in-session and mirrored by
  absolute file path for close/reopen recovery.

## Verification

- Frontend regression tests: `npm test`.
- Frontend production build: `npm run build`.
- Rust formatting, lint, and tests: `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, and `cargo test` from
  `src-tauri/`.
- `scripts/ci-local.sh` runs the repository's complete local gate.

`AI_CONTEXT.md` records detailed workflow history and recent architectural
decisions; this file describes the current stable boundaries.

## Clipboard execution

`use-clipboard-script.ts` owns Paste + Run. It serializes clipboard preparation,
creates a new buffer, and starts execution only after that buffer is committed
and active. It calls normal execution, never debugger continuation. Saved
scripts run through `direct-run.ts` in a fresh profile-free PowerShell child;
working-directory and policy setup affect that child. Prior script globals,
functions, modules and process environment therefore do not enter later runs.
Explicit filesystem changes and machine/user environment changes are persistent
external effects, not session state that PSForge rolls back.

Clipboard buttons use the native Tauri text clipboard capability, scoped to the
main window. Console readiness follows PowerShell's OSC prompt marker rather
than PTY creation; readiness polling never restarts a shell still booting.

The desktop regression harness uses disposable state and real PowerShell through
WebDriver on Linux and Windows. A normal app exit can delete the driver session;
persistence assertions and a second launch remain mandatory. Windows portable
artifacts wrap the native executable and a pinned fixed WebView2 runtime in a
non-elevated temporary-extraction launcher, also driven by the Windows CI gate.
