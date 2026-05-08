# PSForge Audit — Findings & Fix Log

Running record of issues identified during the codebase audit and the fixes applied.

Severity buckets: **CRITICAL** (data-loss / crash), **HIGH** (stability / cross-platform), **MEDIUM** (UX / correctness), **LOW** (polish).

Status legend: `[ ]` pending · `[~]` in progress · `[x]` fixed · `[-]` won't fix (with reason).

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
