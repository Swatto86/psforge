# PSForge Audit — Findings & Fix Log

Running record of issues identified during the codebase audit and the fixes applied.

Severity buckets: **CRITICAL** (data-loss / crash), **HIGH** (stability / cross-platform), **MEDIUM** (UX / correctness), **LOW** (polish).

Status legend: `[ ]` pending · `[~]` in progress · `[x]` fixed · `[-]` won't fix (with reason).

---

## Sweep 2 (v1.3.0) — multi-agent bug sweep, 21 findings, all fixed

### CRITICAL

- [x] **S2-1** — `extractEmbeddedMarkdownFences` discarded an entire valid script when it contained an embedded ``` fence anywhere in its body (e.g. building Markdown in a here-string). Extraction now only fires when everything outside the fences is blank or recognizable prose (`PROSE_LINE_RE`); otherwise the paste passes through untouched. Regression tests added.
- [x] **S2-2** — IntelliSense completion provider was never registered: the owning effect depended only on `enableIntelliSense` (true from first render), and `monacoRef` is invisible to React, so the effect's early-return pass was also its last. Added a `monacoReady` state flag set in `handleEditorMount` and included in the dependency array.

### HIGH

- [x] **S2-3** — Session-restore merge could silently drop a previous session's tab: tab ids came from a counter that resets each launch, so a live `tab-2` collided with the persisted `tab-2`. `newTabId()` now returns `tab-<uuid>`; the id half of `syncTabCounters` is gone.
- [x] **S2-4** — CLI-launch (`getLaunchPath`) effect captured the first-render `openFile` closure, whose `state.settings` was still `DEFAULT_SETTINGS`; opening via file association could overwrite freshly-loaded settings with defaults (then persist them). Effect now gates on `settingsLoaded` with a run-once ref latch.
- [x] **S2-5** — Copy Last Run Output / Copy Debug Bundle silently failed with `clearOutputOnRun` (the default): the line-count baseline was snapshotted before the clear. `runCommandInTerminal` now reports the post-clear baseline via an `onStartLine` callback.
- [x] **S2-6** — PTY backend session leaked when a console tab was closed while `startTerminal` was still in flight: the cancelled path now calls `stopTerminal(sid)` on the just-created session.
- [x] **S2-7** — Trailing stderr output (e.g. a final `Write-Error`) could be silently dropped: the run completed on the stdout `<<PSFORGE_DONE>>` marker while the independent stderr reader task still held undelivered lines, which the next run then drained. The host now emits `<<PSFORGE_DONE_ERR|id>>` on stderr as well, and `execute()` waits for both markers.
- [x] **S2-8** — Variable/Command breakpoints emitted line 0, which the frontend guard discarded entirely, so the debugger never showed the pause. The `ps-debug-break` handler now always flips into paused state and only gates line highlight/navigation on a valid line.
- [x] **S2-9** — Every timed-out PowerShell helper subprocess (PSSA, completions, module listing, formatter, signing…) was orphaned: tokio defaults to `kill_on_drop(false)`. Added `ps_command()` helper with `kill_on_drop(true)` and switched all 14 ad hoc spawn sites.
- [x] **S2-10** — `save_file_content` silently replaced unencodable characters with `?` when saving as `windows1252`. It now returns `Option<String>` (warning), surfaced via terminal notice at the save/auto-save call sites — mirroring the read path's `FileContent.warning`.
- [x] **S2-11** — "Use file's directory" run mode could resolve to a *different tab's* directory after switching tabs (`stateWorkingDir` won the OR-chain). The active tab's own directory now takes priority.
- [x] **S2-12** — `stripSimpleHtml` deleted literal HTML tags out of valid PowerShell string content (HTML report/email builders). The sanitizer now tracks PowerShell string literals (quotes + here-strings) via `splitPsStringSegments` and only strips outside them.
- [x] **S2-13** — "Open Folder" always failed silently: `fs:default` only scopes app-data dirs, so `readDir` on any user-picked folder was ACL-denied and the catch only logged. Added a scoped `fs:allow-read-dir` capability and a user-visible error notice.

### MEDIUM

- [x] **S2-14** — `buildScriptArgs` emitted `-Name:$true` for the literal text "true" on *any* parameter type, silently rewriting e.g. a `[string]` value to "True". Colon-form boolean emission is now gated on the parameter's declared boolean type.
- [x] **S2-15** — `LINE_NUMBER_GUTTER_RE` stripped valid pipelines like Pester's `1 | Should -Be 1`. Gutter stripping now requires ≥2 strictly-increasing matches covering most non-blank lines.
- [x] **S2-16** — Post-commit suggestion re-trigger read `state.settings.enableIntelliSense` captured at editor mount; now reads `settingsRef.current` like the sibling paste handler.
- [x] **S2-17** — Backend default `autoSaveOnRun: false` contradicted the frontend default `true` and won on first launch (unsaved edits didn't run). Backend now defaults `true` with `#[serde(default = "default_true")]`.
- [x] **S2-18** — CI ran only on ubuntu, so `#[cfg(windows)]` code (registry, PS discovery, ConPTY) was never compiled before a release tag. Added a `check-windows` job (clippy + tests on `windows-latest`).

### LOW

- [x] **S2-19** — `dirname("/script.ps1")` returned `""` instead of `"/"`.
- [x] **S2-20** — Settings `NumberInput` snapped a cleared field back to the previous value on every keystroke; now keeps local text state, commits in-range values live, clamps on blur.
- [x] **S2-21** — Backend default `sidebarVisible: true` contradicted the frontend `false` and auto-opened the sidebar on first launch; backend now defaults `false`.

---

## CRITICAL

- [x] **#1** — Settings & file saves are not atomic. Added `atomic_write()` in `utils.rs` (sibling temp file + fsync + rename, with parent fsync on Unix). Wired into `save_file_content`, `settings::save_to`, and `save_user_snippets_to`.
- [x] **#2** — `read_file_content` lossy-decodes non-UTF-8 bytes. Replaced `String::from_utf8_lossy` with strict UTF-8 detection; invalid UTF-8 now falls back to Windows-1252 via `encoding_rs` so saving round-trips faithfully (or surfaces a warning to the frontend). Added `"windows1252"` save path that re-encodes as the original bytes.
- [x] **#3** — Corrupt `settings.json` resets to defaults silently. Added `backup_path_for()` helper; corrupt files are now copied to `settings.json.bak` before defaults are written. Log truthfully states the backup path.
- [x] **#4** — Corrupt user snippets file silently swallowed. Same backup pattern via `settings::backup_path_for(snippets.json)` plus a `warn!`/`error!` instead of a quiet `if let Ok(...)`.
- [x] **#5** — Session-restore overwrote user typing. Added `tabsRef` snapshot of live tab list; restore now merges restored file-backed tabs with any user-touched tabs created during the async restore window instead of replacing the tab list wholesale.
- [x] **#6** — localStorage session writes silently dropped on quota exceeded. Added a three-stage progressive trim: keep everything → drop content for clean (file-backed) tabs → keep only the active tab's content → finally clear the snapshot. Each fallback logs once.
- [x] **#7** — Signing left in-memory tab state stale. `ScriptSigningDialog` now re-reads the file via `cmd.readFileContent` after a successful sign and dispatches `UPDATE_TAB` to refresh `content`/`savedContent`/`encoding`/`isDirty`. If the re-read fails, a non-blocking warning is shown.

## HIGH (Stability / Cross-platform)

- [x] **#8** — Stale terminal-run temp scripts accumulated. Added `psforge_terminal_run_` to the cleanup PREFIXES in `utils.rs`.
- [x] **#9** — `stopExecution` swallowed backend failures. Now writes `[PSForge] Stop request failed: …` into the integrated terminal on backend error and waits for the actual `ps-complete` event before clearing `isRunning`. Inspector clears immediately for responsiveness.
- [x] **#10** — PTY UTF-8 decode at chunk boundaries replaced multi-byte chars with U+FFFD. Reader thread now buffers trailing partial UTF-8 between reads and only emits the longest valid prefix; tail held over for next read. Defensive flush at >16 buffered bytes prevents unbounded growth on garbage streams.
- [x] **#11** — `discover_ps_versions` was Windows-only. Added `#[cfg(unix)]` branch that scans every `$PATH` entry for `pwsh`/`powershell`, plus common Homebrew/snap/system paths, so Linux/macOS builds find PowerShell.
- [x] **#12** — `validate_ps_path` called `where.exe` unconditionally. Replaced with a pure-Rust `find_on_path()` that walks `$PATH` (with Windows extension fallback) — no shell dependency, no platform branching.
- [x] **#13** — Frontend hard-coded `\\` as path separator. Added `src/path-utils.ts` exposing `basename()` / `dirname()` that handle both separators. Wired into `App.tsx` (`openFile`, `saveTab`) and `Toolbar.tsx` (recent files dropdown). Replaced the old `"C:\\"` fallback with a `platformHomeFallback()` helper that returns `/` on non-Windows.
- [x] **#14** — `xdg-open` hard-coded for non-Windows reveal. Split into `#[cfg(target_os = "macos")]` (`open -R`) and `#[cfg(all(unix, not(target_os = "macos")))]` (`xdg-open`).
- [x] **#15** — `SettingsPanel` rejected valid Unix paths. Renamed `isLikelyAbsoluteWindowsPath` → `isLikelyAbsolutePath` and added the `/`-prefix branch.

## MEDIUM (UX / Correctness)

- [x] **#16** — SecureString params couldn't be filled via `ParamPromptDialog`. Frontend now base64-encodes the value and emits `-Name:__psforge_securestring__<b64>`. The backend `__psforge_coerce_arg_value` recognises the sentinel and converts to a real `[SecureString]` via `ConvertTo-SecureString` before splatting.
- [x] **#17** — Numeric param validation rejected scientific notation. Regex extended to `^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$`.
- [x] **#18** — HelpPane rendered unvalidated `onlineUri` in `<a href>`. Added `safeExternalLink()` that requires `https?://`. Conditional render skips entirely for unsafe URIs. Switched to `rel="noopener noreferrer"`.
- [x] **#19** — Backend/frontend setting ranges disagreed. Narrowed backend `MAX_UI_FONT_SIZE` / `MAX_SIDEBAR_FONT_SIZE` to 24 (matching the frontend slider). Widened frontend `maxRecentFiles` cap to 100 (matching backend).
- [x] **#20** — Recent-files dedup was case-insensitive everywhere. Now `cfg!(windows)` decides; case-sensitive on Linux/macOS.
- [x] **#21** — Caps Lock broke alphabetic shortcuts. Introduced `keyLower` normalisation at the top of the keydown handler and switched every alphabetic shortcut comparison to use it.
- [x] **#22** — Save-As cancel aborted entire batch save. Loop now `continue`s on cancel instead of `break`.
- [x] **#23** — `register_file_association` didn't validate the extension argument. Added `validate_extension()` accepting `^\.[A-Za-z0-9]{1,15}$`; both register/unregister commands call it before touching the registry.
- [x] **#24** — `add_recent_file` ignored `max_recent_files`. Truncates to the user's clamped setting now.
- [x] **#25** — Settings save failures were silently swallowed. The debounced auto-save in `store.tsx` now routes failures into the integrated terminal via `__psforge_terminal_write_notice`, deduped so a recurring failure doesn't spam.
- [x] **#26** — `find_powershell` accepted any PS that simply spawned. Switched to `-Command '$PSVersionTable.PSVersion.Major'` with `status.success()` requirement; also added `pwsh` as the non-Windows fallback.
- [x] **#27** — `is_windows_powershell` mis-identified user-named binaries. Now compares the file-name component case-insensitively, not the suffix.
- [x] **#28** — Window flash 200 ms timer was fragile. Frontend emits `psforge-ready` on first React mount; Rust `setup` listens and shows the window in response. 3 s safety-net timer reveals anyway if the WebView never signals.
- [x] **#29** — `ResizeObserver` resize loop guard insufficient. Added a `lastObservedHeight` delta gate so the observer ignores reports where height hasn't changed by ≥0.5 px (which is the most common cause of jitter when our own setSplitPercent re-renders panes).
- [x] **#30** — Two completion-provider registrations overlapped on first mount. Removed the in-mount registration; the `enableIntelliSense` effect now exclusively owns the lifecycle.
- [x] **#31** — Variable inspector serialised potentially huge values. PS-side `__psforge_emit_variables` now truncates each value to 4 KiB with a "(truncated, N more chars)" suffix.
- [x] **#32** — Output line budget exhaustion was invisible. The reader emits a one-shot `[PSForge] Output truncated after N lines; …` line on the stderr stream when the budget runs out.
- [x] **#33** — `BatchResult::push_error` silently dropped past 100 errors. Added `truncated: bool` field; set when the cap is hit, mirrored to the TypeScript type.

## LOW (Polish)

- [x] **L1** — Modal focus traps missing. Added `useFocusTrap` hook (small, dependency-free) and wired it into `ScriptSigningDialog`, `ParamPromptDialog`, `SettingsPanel`. Restores focus to the previously focused element on close; Tab/Shift+Tab cycle within the modal.
- [x] **L2** — `set_execution_policy` interpolated the user-supplied case. Now resolves the canonical-cased entry from `ALLOWED_POLICIES` and emits that.
- [x] **L3** — `detect_and_decode` warned for odd-byte UTF-16 but only logged. `FileContent` gained a `warning?: string` field; UTF-16 odd-byte and Windows-1252 fallback both surface warnings; `App.tsx` writes the warning to the integrated terminal on file open.
- [x] **L4** — Drag-drop opened only the first file. Now opens every dropped file sequentially.
- [x] **L5** — Print fallback was silent when popup was blocked. Surfaces a terminal notice now.
- [x] **L6** — Window globals exposed in production. E2E-only helpers (`__psforge_dispatch`, `__psforge_reset_variables`, `__psforge_setEditorText`) gated behind `import.meta.env.DEV`.
- [x] **L7** — `onlyPathLikeCandidates` retry could do up to 3 sequential PS calls. Added a latency budget (`COMPLETION_RETRY_LATENCY_BUDGET_MS = 800`); slow shells skip the retries and accept the first result.
- [x] **L8** — Startup cleanup ran synchronously. Moved `cleanup_psforge_temp_files()` into `tauri::async_runtime::spawn_blocking` inside the `setup` hook so launch is never blocked by a slow tmpfs.
- [x] **L9** — `get_script_parameters` >32 KB silently fell through. Frontend detects an empty parameter list combined with a literal `param(` block and surfaces an explanation via terminal notice.
- [x] **L10** — Bookmarks/breakpoints lost on close-and-reopen of file-backed tabs. New `src/path-state-store.ts` mirrors markers into a localStorage map keyed by absolute file path (case-insensitive on Windows). `App.tsx` restores them on `openFile` after `ADD_TAB`, and a pair of mirror effects keep the path store in sync with tab-keyed state. A first-sighting guard in each effect protects existing path entries from being clobbered by transient empty state during the open-file flow, while still letting Save-As (untitled → file-backed) propagate non-empty markers to the new path on the very first render.

---

## Verification

- `cd src-tauri && cargo check` — clean (zero warnings; the pre-existing `unreachable_code` warning was also fixed).
- `cd src-tauri && cargo test` — 36/36 pass (added 4 new tests covering Windows-1252 round-trip, lossy detection, odd-byte UTF-16 warning, and explicit BOM behaviour).
- `npm run build` — clean (`tsc && vite build`, zero warnings, 1102 modules transformed).

## Files touched

Backend:
- `src-tauri/src/commands.rs` — atomic save, encoding rewrite, snippets backup, xdg-open/macOS, extension validation, `is_windows_powershell` exact match, canonical exec policy, `FileContent.warning`, new tests.
- `src-tauri/src/settings.rs` — atomic save, corrupt-settings backup, case-aware recent-file dedup, `add_recent_file` honours user cap, narrowed UI/sidebar font ranges, exposed `backup_path_for`.
- `src-tauri/src/utils.rs` — new `atomic_write()` helper, `psforge_terminal_run_` cleanup prefix.
- `src-tauri/src/powershell.rs` — cross-platform PS discovery, pure-Rust PATH search in `validate_ps_path`, variable-value truncation, output-truncation notice, SecureString sentinel decoder.
- `src-tauri/src/terminal.rs` — UTF-8 boundary buffering in PTY reader thread, `find_powershell` exit-status check, non-Windows fallback.
- `src-tauri/src/lib.rs` — `psforge-ready` listener + safety-net timer + async startup cleanup.
- `src-tauri/src/errors.rs` — `BatchResult.truncated`.

Frontend:
- `src/path-utils.ts` — new (cross-platform `basename`/`dirname`).
- `src/path-state-store.ts` — new (path-keyed bookmark/breakpoint persistence in localStorage, case-insensitive on Windows).
- `src/components/use-focus-trap.ts` — new (modal focus trap hook).
- `src/types.ts` — `BatchResult.truncated`, `FileContent.warning`.
- `src/App.tsx` — path-helper wiring, Caps Lock-safe shortcuts, batch-save no-abort, stop-execution feedback, SecureString arg builder, ResizeObserver loop guard, drag-drop multi-file, print popup feedback, `psforge-ready` emit, dev-only globals gating, encoding-warning notice, param-too-large notice, **path-keyed marker restore on file open + mirror effects**.
- `src/store.tsx` — session-restore race fix, localStorage quota fallback, settings-save error notice.
- `src/components/EditorPane.tsx` — single completion-provider registration, completion retry latency budget, dev-only `__psforge_setEditorText`.
- `src/components/SettingsPanel.tsx` — Unix path acceptance, range alignment, focus trap.
- `src/components/ScriptSigningDialog.tsx` — re-read after sign, focus trap.
- `src/components/ParamPromptDialog.tsx` — scientific-notation regex, focus trap.
- `src/components/HelpPane.tsx` — safe `href` validator.
- `src/components/Toolbar.tsx` — `basename` for recent-files names.
