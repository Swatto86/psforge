# PLAN.md — Bug Sweep 3: fixes, regression sweep, release v1.3.1

Implementer handover. Fix the 32 verified findings below, run the regression sweep
(Phase 2), then release v1.3.1 (Phase 3). Work directly on `main`.

**Provenance:** findings come from a 116-agent audit of this repo (15 scoped finders
across the Rust backend, React frontend, IPC contract, embedded PowerShell, and
CI/release pipeline; every finding then survived a 3-lens adversarial vote —
refute / reproduce / impact — plus a completeness-critic second round). Three were
additionally hand-verified against source (S3-2, S3-4, S3-7). Zero findings were
rejected in verification, so treat the list as high-confidence — but still re-verify
each against current code before editing (line numbers drift).

Severity mix: 8 HIGH, 20 MEDIUM, 4 LOW, no CRITICAL.

---

## Environment gotchas (read before running anything)

- **Local Rust toolchain:** bare `cargo` on this PC resolves to a standalone GNU-host
  Rust (`C:\Program Files\Rust stable GNU 1.96\bin` precedes `~/.cargo/bin` on PATH)
  and fails linking the Tauri cdylib (`export ordinal too large`). Run all Rust checks
  in Git Bash with the rustup MSVC toolchain:
  `PATH="/c/Users/Swatto/.cargo/bin:$PATH" rustup run stable cargo <fmt|clippy|test> ...`
  from `src-tauri/`. Clippy happens to pass on the GNU toolchain too (no link step) —
  don't rely on it.
- **Full local gate:** `PATH="/c/Users/Swatto/.cargo/bin:$PATH" ./scripts/ci-local.sh`
  (the PATH prefix makes the script's bare `cargo` resolve through rustup).
- **Frontend tests:** `npm test` (vitest). Frontend build: `npm run build` (tsc + vite).
- The Vite dev server previews the frontend in a browser (Tauri `invoke` errors are
  expected noise there); `preview_eval` / `preview_inspect` work for UI verification,
  `preview_screenshot` times out on the WebGL xterm canvas.

## Ground rules

1. **Refute-then-fix.** For each finding, first confirm it against current code. If a
   finding turns out to be wrong or already-moot, do NOT force a change — record it as
   `[-]` won't-fix in AUDIT-FIXES.md with the reason.
2. **Root cause, smallest correct diff.** Fix in the shared function all callers route
   through, not per call site. Match each module's existing conventions.
3. **Regression tests.** Any fix in a module with an existing harness gets a test:
   vitest for `sanitize-paste`, `run-utils`, `terminal-utils`, `path-utils`,
   `debug-bundle`, `paste-summary`, `assistant-mode` (new `src/__tests__/*.test.ts`
   files are fine, e.g. for `path-utils` / `path-state-store`); Rust `#[cfg(test)]`
   unit tests where practical (e.g. marker handling under output-budget exhaustion,
   settings defaults parity, `quotePsArgument`-equivalent logic). UI-only fixes
   (focus traps, dialogs) don't need tests.
4. **Documentation in the same unit of work.** Add a `## Sweep 3 (v1.3.1)` section at
   the top of AUDIT-FIXES.md in the same style as Sweep 2 (one `[x]` line per finding,
   keep the S3-N ids). Add a dated entry to AI_CONTEXT.md "Recent Context & Decisions"
   summarizing the sweep and any behavior changes.
5. **Commits:** one or a few logical `fix:` commits (e.g.
   `fix: bug sweep 3 (32 verified findings)`), then a separate
   `chore: bump version to 1.3.1`. No AI-attribution trailers or co-author lines
   anywhere.
6. **Marker protocol changes need extra care.** S3-1 and S3-29 touch the
   `<<PSFORGE_DONE|...>>` protocol that Sweep 2 (S2-7) already reworked — read the
   whole `execute()` wait loop and both reader tasks in `powershell.rs` before editing,
   and re-check S2-7's guarantee (trailing stderr is not dropped) still holds after
   your change.

---

## Findings

## HIGH (8)

### S3-1 — Output-line budget silently drops the <<PSFORGE_DONE|...>>/<<PSFORGE_DONE_ERR|...>> completion markers once a run exceeds MAX_OUTPUT_LINES, hanging execute() forever and permanently blocking every subsequent run

**Severity:** HIGH · **Where:** `src-tauri/src/powershell.rs:435`

spawn_output_reader() shares a single Arc<AtomicUsize> output_budget (100,000) across both the stdout and stderr readers of a session. Once exhausted, the reader emits a one-shot truncation notice (AUDIT-FIXES #32 added this visibility) and then silently discards every subsequent line — with no special-casing for the PSFORGE_DONE/PSFORGE_DONE_ERR marker lines, which Invoke-PSForgeCommand's `finally` block always writes LAST, after all of the script's own output. If a run produces more than 100,000 combined stdout+stderr lines before finishing, the completion markers themselves get read off the pipe and dropped along with the rest. execute()'s wait loop has no fallback timeout for the case where the stdout marker never arrives (STDERR_DRAIN_TIMEOUT_MS only applies AFTER stdout_done is observed), so it blocks on session_events.recv() indefinitely. The underlying PowerShell host process is unaffected — it finished the script and is idly waiting for the next command — so spawn_process_monitor never reports it exited either. Because execute() holds `self.execution_lock` for its entire duration, this hang blocks every future Run/Debug app-wide until the user manually clicks Stop or restarts the app. Note: AUDIT-FIXES #32 only fixed the *visibility* of truncation (a one-shot warning line), not this deeper marker-loss/hang defect.

**Failure scenario:** Debug/run a script that writes more than 100,000 lines to stdout/stderr combined before returning, e.g. `1..150000 | ForEach-Object { Write-Output $_ }`. Once the budget is hit, the reader shows one truncation notice and then discards everything else including the final `<<PSFORGE_DONE|id|code>>` marker. No ps-complete event ever fires; the Run/Debug UI stays running forever; every later attempt to Run/Debug ANY script (even trivial ones) also hangs because execute() never releases execution_lock.

**Evidence:**

````
if Self::try_consume_output_budget(&output_budget) { ... send Output ... } else if !output_budget_warned.swap(true, Ordering::Relaxed) { warn!(...); send truncation notice; /* line discarded, no marker special-casing */ }
// execute()'s wait loop has no bound while stdout_done is still None: tokio::select! { _ = &mut kill_rx => {...}, event = session_events.recv() => {...} }
````

**Suggested fix:** Special-case marker lines (parse_run_complete_marker/parse_run_complete_stderr_marker) so they're always forwarded even when the output budget is exhausted — check for the marker prefix before consulting try_consume_output_budget in spawn_output_reader.

**Verifier corrections/notes:**
- Downgrade CRITICAL to HIGH per the given rubric (CRITICAL=data-loss/crash, HIGH=stability). This bug causes an indefinite hang blocking all future Run/Debug operations app-wide, but it is a stability/availability defect, not data loss or a crash — the underlying PowerShell process and its real output are unaffected, and the finding itself documents a working recovery path (manual Stop, via kill_sender, which is independent of execution_lock and does successfully unblock execute()). "Permanently blocking" in the description overstates it since Stop is a working escape hatch already wired in the code; it is a hang requiring manual intervention, which is squarely a HIGH stability issue rather than CRITICAL data-loss/crash.

### S3-2 — AppSettings backend struct is missing the showDebuggerTools field entirely — the setting can never persist, permanently hiding the Debugger pane on real breakpoint hits

**Severity:** HIGH · **Where:** `src-tauri/src/settings.rs:55`

src/types.ts declares `AppSettings.showDebuggerTools: boolean` (DEFAULT_SETTINGS.showDebuggerTools = false) and src/assistant-mode.ts treats it as real/persisted. The Rust `AppSettings` struct in settings.rs has no `show_debugger_tools` field at all — confirmed absent via direct grep of settings.rs — the one field present on the frontend with no backend counterpart (all other ~48 fields match). Since serde silently drops unknown JSON keys on deserialize (no deny_unknown_fields) and the Rust struct has nothing to serialize back out, showDebuggerTools never survives a save/load round-trip; `load_settings()` never returns it, so `state.settings.showDebuggerTools` is always undefined/false. Compounding this, no control in SettingsPanel.tsx can ever set it true (grep confirms zero `updateSetting("showDebuggerTools", ...)` call sites). OutputPane.tsx has a guard effect that actively kicks the bottom panel OUT of the Debugger tab whenever this flag is false — including while a real debug session is genuinely paused at a breakpoint.

**Failure scenario:** User sets a gutter breakpoint (not gated by showDebuggerTools) and presses F5; startDebugSession() runs, the script hits the breakpoint, App.tsx dispatches SET_DEBUG_STATE{isDebugging:true, debugPaused:true} and SET_BOTTOM_TAB{tab:"debugger"}. On the very next render, OutputPane.tsx's effect (`if (!showDebuggerTools && state.bottomPanelTab === "debugger") dispatch(SET_BOTTOM_TAB, tab:"terminal")`) fires immediately since showDebuggerTools can never be true, flipping the bottom panel back to Terminal. The user is left staring at Terminal with no Locals/Call Stack/Watch/debugger toolbar while the PowerShell host sits blocked at the [DBG]> prompt with no UI way to continue/step.

**Evidence:**

````
src-tauri/src/settings.rs: fields jump straight from auto_save_scratch_scripts to execution_policy, no show_debugger_tools field anywhere (confirmed via grep, no matches). src/types.ts:235 `showDebuggerTools: boolean;` (non-optional). src/components/OutputPane.tsx: `const showDebuggerTools = state.settings.showDebuggerTools === true; useEffect(() => { if (!showDebuggerTools && state.bottomPanelTab === "debugger") dispatch({type:"SET_BOTTOM_TAB", tab:"terminal"}); }, ...)`. Grep confirms SettingsPanel.tsx has zero updateSetting("showDebuggerTools", ...) call sites.
````

**Suggested fix:** Add `pub show_debugger_tools: bool` (with #[serde(default)]) to the Rust AppSettings struct so it round-trips through save/load, and add a Settings-panel toggle that can actually set it true.

### S3-3 — "Paste from clipboard + run" never auto-runs the new script (stale closure over setTimeout)

**Severity:** HIGH · **Where:** `src/App.tsx:2452`

pasteFromClipboardAsNewScript() creates a new code tab via ADD_TAB (which the reducer makes active) and schedules the auto-run via `window.setTimeout(() => runOrDebugScript(), 50)`. The `runOrDebugScript` referenced in that callback is the specific memoized function instance closed over when THIS invocation of pasteFromClipboardAsNewScript was created via useCallback — i.e. from the render where the previously-active tab (typically the Welcome tab) was still `activeTab`. runOrDebugScript guards on the raw `activeTab` state variable (`if (!activeTab || activeTab.tabType === "welcome") return;`), not on `activeTabRef.current` the way runScript/rerunFromRecord do elsewhere in the same file. Because the new tab is created strictly AFTER runOrDebugScript's closure was fixed, the timer's call sees the OLD activeTab and returns immediately without running anything. Both real call sites of pasteFromClipboardAsNewScript (Ctrl+Shift+Alt+V, and the Toolbar/WelcomePane onPasteScript handler) only invoke it precisely when `!activeTab || activeTab.tabType === "welcome"` is true, so the captured closure is guaranteed stale on every real invocation — not a rare race.

**Failure scenario:** App launches on the Welcome tab (default state). User clicks "Paste from clipboard + run" (Toolbar or WelcomePane, or Ctrl+Shift+Alt+V) with the default setting `runAfterPasteCleanFormat: true`. The clipboard script is pasted into a new tab and formatted correctly, but the scheduled auto-run silently no-ops every time — not probabilistically, guaranteed — because runOrDebugScript's `activeTab.tabType === "welcome"` check evaluates against the old, closed-over Welcome tab rather than the just-created code tab. The user sees their script pasted and formatted but never executed, defeating the app's headline paste-and-run workflow from its default entry point, with no error or notice shown.

**Evidence:**

````
const pasteFromClipboardAsNewScript = useCallback(async () => {
  ...
  dispatch({ type: "ADD_TAB", tab });
  ...
  if (state.settings.runAfterPasteCleanFormat !== false) {
    window.setTimeout(() => runOrDebugScript(), 50);   // stale closure
  }
}, [..., runOrDebugScript]);

const runOrDebugScript = useCallback(() => {
  if (state.isDebugging && state.debugPaused) { void debugContinue(); return; }
  if (!activeTab || activeTab.tabType === "welcome") return;   // reads state var, not activeTabRef.current
  ...
}, [activeTab, ...]);

// WelcomePane.tsx: label={pasteRuns ? "Paste from clipboard + run" : "Paste from clipboard"}, hint="...formats, then runs"
// Both real call sites gate on activeTab being welcome/none, guaranteeing the captured closure is always the welcome-bound one.
````

**Suggested fix:** Make runOrDebugScript's guard read activeTabRef.current instead of the closed-over activeTab (matching runScript/startDebugSession/rerunFromRecord), or replace the setTimeout with the requestAnimationFrame + ref-driven pattern rerunFromRecord already uses, or simplest: after ADD_TAB, directly call runScript() (already ref-based) instead of runOrDebugScript().

### S3-4 — "Copy Output" / Copy Terminal Output silently truncates to the last 80 lines instead of the full scrollback

**Severity:** HIGH · **Where:** `src/App.tsx:2539`

The `__psforge_copy_terminal_output` window bridge (wired to OutputPane's "Copy Output" button and the Command Palette's "Copy Terminal Output" entry, both labelled as copying the full scrollback) calls copyTerminalOutputToClipboard() with no line-count argument. That forwards undefined straight through to TerminalSession's contentFnRef, whose default (`const count = lineCount ?? 80`) was written for an E2E-test helper (__psforge_terminal_get_content), not a user-facing "copy everything" action. Only the last 80 buffer lines are ever copied, with no truncation notice, even though the terminal is configured for 25,000 lines of scrollback.

**Failure scenario:** Run any script producing more than 80 lines of output (e.g. `Get-ChildItem -Recurse`), then click "Copy Output" intending to paste the whole run into an AI chat per the app's documented paste-and-run/debug workflow. Only the last 80 lines land on the clipboard; everything earlier — often including the actual error near the top of a long run — is silently dropped with zero indication anything was cut.

**Evidence:**

````
w.__psforge_copy_terminal_output = async () => { const copied = await copyTerminalOutputToClipboard(); ... };
export async function copyTerminalOutputToClipboard(lineCount?: number) { const text = getTerminalPlainContent(lineCount); ... }
contentFnRef.current = (lineCount?: number) => { const count = lineCount ?? 80; ... };
````

**Suggested fix:** Have copyTerminalOutputToClipboard() pass the current buffer length (or a dedicated no-arg full-buffer getContent() mode) instead of relying on the 80-line default meant for the E2E helper.

### S3-5 — latest.json updater manifest only ever gets a Windows platform entry — macOS/Linux auto-update is permanently broken

**Severity:** HIGH · **Where:** `.github/workflows/release.yml:158`

The release build matrix publishes installers for windows-latest, ubuntu-22.04, and macos-latest, but includeUpdaterJson is gated to matrix.platform == 'windows-latest' only, with a comment about avoiding parallel delete/upload races. tauri-action's uploadVersionJSON is only invoked on jobs where includeUpdaterJson is true, and merges IN only the current job's own built artifacts into whatever latest.json already exists in the release. Since this is the only job that ever calls it, against a brand-new draft release with no pre-existing latest.json, the file it writes contains solely the windows-x86_64 platform key. uploadReleaseAssets still uploads the macOS/Linux installers as ordinary release assets, but they are never added to latest.json. The upstream default is includeUpdaterJson: 'true' for every matrix leg; tauri-action's own retry() wrapper around the read-merge-delete-upload cycle is what upstream examples rely on to handle the concurrent-write race, not restricting the write to one leg.

**Failure scenario:** A user on macOS or Linux runs PSForge and the in-app updater (@tauri-apps/plugin-updater) fires. It GETs latest.json from the GitHub release, looks up platforms['darwin-aarch64']/['darwin-x86_64']/['linux-x86_64'], finds no such key (only windows-x86_64 is ever present), and check() resolves with no available update — even though a newer version was just published and its installer is sitting right there as a release asset. The user gets no update prompt, ever, on any future release, with no error surfaced.

**Evidence:**

````
retryAttempts: 5
# Only one matrix leg updates latest.json to avoid parallel delete/upload races.
includeUpdaterJson: ${{ matrix.platform == 'windows-latest' }}
// tauri-action action.yml (v0): includeUpdaterJson default 'true'
// tauri-action src/upload-version-json.ts: fetches existing latest.json as merge baseline, writes entries only for the artifacts passed into this call (i.e. only this job's own platform)
````

**Suggested fix:** Set includeUpdaterJson: true for every matrix leg (drop the windows-only gate) and rely on tauri-action's built-in retry()/merge logic to handle the concurrent-write race, matching the upstream multi-platform example workflow.

### S3-6 — Script temp files written UTF-8 without BOM corrupt non-ASCII source under Windows PowerShell 5.1

**Severity:** HIGH · **Where:** `src-tauri/src/utils.rs:77`

write_secure_temp_file() writes raw bytes with no BOM. It's used for the temp .ps1 files actually parsed/executed by PowerShell: the user's script body in powershell.rs execute() (user_script_path), the terminal one-shot run script in commands.rs prepare_terminal_script_command, and the PSSA-analysis/IntelliSense temp file in commands.rs write_temp_ps_file (used by analyze_script and get_completions). Windows PowerShell 5.1 (powershell.exe) — a first-class, user-selectable PS version in PSForge — parses a BOM-less script file using the system ANSI code page, not UTF-8, so any multi-byte UTF-8 character in the script source is silently mis-decoded into 2 (or 3) wrong characters before the script ever runs. PowerShell 7 (pwsh.exe) has no such issue since it defaults to UTF-8 for BOM-less files.

**Failure scenario:** A user pastes AI-generated PowerShell containing a curly quote, em dash, accented name, or any non-ASCII character (very common for the AI paste-and-run workflow this app is built around), selects "Windows PowerShell 5.1" as the interpreter, and presses F5. PSForge writes the script to a no-BOM UTF-8 temp file; Windows PowerShell 5.1 parses it as ANSI, so string literals/comparisons built from the non-ASCII text are silently corrupted (e.g. `if ($x -eq "café")` never matches, or output/log text is mojibake) with no error or warning at all. Same corruption applies to PSSA diagnostics and IntelliSense against such scripts.

**Evidence:**

````
pub(crate) fn write_secure_temp_file(prefix: &str, suffix: &str, content: &[u8]) -> std::io::Result<PathBuf> { ... f.write_all(content)?; // raw bytes, no BOM }
// powershell.rs: let user_script_path = write_secure_temp_file("psforge_script", ".ps1", script.as_bytes())...
// Empirical repro: no-BOM UTF-8 file `$s = "café"; Write-Output ($s.Length)`.
// pwsh.exe -> 4 (correct); powershell.exe -> 5 (the 2-byte UTF-8 'é' split into two mis-decoded Windows-1252 characters)
````

**Suggested fix:** Prepend the UTF-8 BOM (EF BB BF) to the bytes written for .ps1 temp files (or unconditionally in write_secure_temp_file, since a BOM is harmless for pure-ASCII bootstrap/wrapper scripts too) so both Windows PowerShell 5.1 and pwsh parse the source consistently as UTF-8.

**Verifier corrections/notes:**
- The get_completions/TabExpansion2 path (commands.rs ~2337, `[IO.File]::ReadAllText`) is likely not actually affected since .NET's ReadAllText defaults to UTF-8 without a BOM — the evidence list's claim that IntelliSense is corrupted the same way is probably overstated. The genuinely-affected consumers are: powershell.rs execute() dot-sourcing user_script_path (line 868), commands.rs prepare_terminal_script_command's `-File` invocation (line 154), and commands.rs analyze_script's `Invoke-ScriptAnalyzer -Path` (line 2239), all of which go through the PowerShell/PSSA AST parser subject to the ANSI fallback on Windows PowerShell 5.1 Desktop edition.
- Same file/line (utils.rs:77, write_secure_temp_file). Severity should be HIGH, not CRITICAL — reachable via powershell.rs:739 (F5 run, dot-sourced through the persistent host), commands.rs:118+146-155 (terminal Run, direct `-File` invocation), and commands.rs:2529-2531 (PSSA analyze_script / get_completions), all confirmed reachable when the user selects the "Windows PowerShell 5.1" interpreter that discover_ps_versions() (powershell.rs:1347-1355) surfaces as a normal option.

### S3-7 — dirname() strips the trailing backslash off a Windows drive root, turning an absolute path into a drive-relative one

**Severity:** HIGH · **Where:** `src/path-utils.ts:28`

dirname() special-cases index 0 (Unix root '/script.ps1' -> '/', fixed by S2-19) but not the equivalent Windows case: for a file directly at a drive root, e.g. 'C:\\script.ps1', the last separator is at index 2, so the function returns path.slice(0,2) = 'C:' instead of 'C:\\'. 'C:' is not the drive root in Windows path semantics — it's a drive-relative reference that resolves to the process's/shell's remembered current directory on that drive, which can be anywhere. This value flows unnormalized into resolveExecutionWorkDir, resolveFallbackWorkDir, and the working-dir dispatch on file open, then straight to the backend's resolve_terminal_working_dir/resolve_working_dir, both of which only check candidate.is_dir() before accepting the string verbatim.

**Failure scenario:** A user opens/saves a script directly at a drive root (plausible for a portable/USB drive, e.g. 'D:\\script.ps1'), then runs it with the default "file" working-dir mode. dirname('D:\\script.ps1') returns 'D:' instead of 'D:\\'. Empirically confirmed in Node (dirname returns "D:") and in Rust (Path::new("D:").is_dir() returns true but canonicalize() resolves it to the process's current working directory, not the drive root). Because PSForge persists the PowerShell runspace across runs, if any earlier command in that session changed location to a different folder on that drive, Set-Location -LiteralPath 'D:' silently lands the new run in that leftover directory instead of the drive root — the script's relative-path file reads/writes go to the wrong folder with no error surfaced.

**Evidence:**

````
export function dirname(path: string): string {
  const idx = lastSeparatorIndex(path);
  if (idx === -1) return "";
  return idx === 0 ? path[0] : path.slice(0, idx);
}
// Node repro: dirname("C:\\script.ps1") === "C:"   // should be "C:\\"
// Rust repro (Path::new("C:")): is_dir = true; canonicalize = Ok("\\\\?\\C:\\Users\\...\\scratchpad")  // NOT C:\\
````

**Suggested fix:** In dirname(), also treat the case where idx is exactly 2 and path[idx-1] === ':' with a single leading drive letter as a root: return path.slice(0, idx + 1) (i.e. 'C:\\') rather than path.slice(0, idx).

**Verifier corrections/notes:**
- Severity as rated (HIGH) is justified, not CRITICAL and not MEDIUM. Not CRITICAL: the bug does not itself crash or delete data — it silently mis-resolves a working directory; actual data loss requires the user's own script to additionally do a destructive relative-path operation (Remove-Item, Out-File overwrite, etc.) while under this wrong cwd. Not MEDIUM: unlike ordinary correctness/UX bugs, this fails with zero error surfaced (is_dir() reports true, so the app's existing INVALID_WORKING_DIR guard never fires) and is triggered under fully default settings (workingDirMode="file", persistRunspaceBetweenRuns=true) with a plausible real-world file layout (script saved at a drive/USB root) — a silent wrong-execution-context bug with realistic data-loss downside and no diagnostic signal warrants HIGH over MEDIUM. Fix hint given (special-case idx===2 with path[idx-1]===':' to return path.slice(0, idx+1)) is correct and mirrors the existing idx===0 Unix-root fix.

### S3-8 — Show Command pane module-load effect infinite-loops on empty/failed module list

**Severity:** HIGH · **Where:** `src/components/ShowCommandPane.tsx:70`

ShowCommandPane's load-effect reimplements Sidebar's 'load modules when empty and not loading' pattern but omits both fixes Sidebar's own comment (Sidebar.tsx:185-188) documents as required: (1) state.modulesLoading is included in the effect's dependency array, and (2) loadModules() has no error/empty-result latch — its catch block only sets a local moduleError string that the effect's guard never reads, and modules stays [] on both an empty successful result and a thrown error.

**Failure scenario:** User opens 'Show Command' (Sidebar never opened, so Sidebar's own reset/guard logic never runs) while state.modules is empty. get_installed_modules either times out/errors or legitimately returns an empty array (e.g. a PS install with zero user modules). Trace: effect fires (modules.length===0, modulesLoading===false) -> loadModules() dispatches SET_MODULES_LOADING:true (guard now blocks re-entry) -> promise settles -> on success-empty, SET_MODULES:[] leaves modules.length at 0; on error, modules is untouched and stays 0 -> finally dispatches SET_MODULES_LOADING:false. Because modulesLoading is a dependency, this state change re-runs the effect; the guard `state.modules.length > 0 || state.modulesLoading` is now false/false, so it is satisfied again and loadModules() fires again -- a tight loop with no backoff, spawning a fresh PowerShell subprocess (get_installed_modules) on every iteration for as long as the pane stays mounted and the result stays empty/erroring.

**Evidence:**

````
const loadModules = useCallback(async () => {
    if (!state.selectedPsPath) return;
    setModuleError("");
    dispatch({ type: "SET_MODULES_LOADING", loading: true });
    try {
      const modules = await cmd.getInstalledModules(state.selectedPsPath);
      dispatch({ type: "SET_MODULES", modules });
    } catch (err) {
      ... setModuleError(message); // not read by the guard below
    } finally {
      dispatch({ type: "SET_MODULES_LOADING", loading: false });
    }
  }, [state.selectedPsPath, dispatch]);

  useEffect(() => {
    if (!state.selectedPsPath) return;
    if (state.modules.length > 0 || state.modulesLoading) return;
    void loadModules();
  }, [
    loadModules,
    state.selectedPsPath,
    state.modules.length,
    state.modulesLoading, // <- present here, unlike Sidebar.tsx which explicitly excludes it
  ]);
````

**Suggested fix:** Match Sidebar.tsx's pattern: drop state.modulesLoading from the dependency array (or add a latched 'attempted' flag) so a settled load — success-empty or error — doesn't immediately re-trigger itself.

## MEDIUM (20)

### S3-9 — get_script_parameters silently loses all mandatory-parameter info when HelpMessage isn't a plain string literal

**Severity:** MEDIUM · **Where:** `src-tauri/src/commands.rs:313`

PARAM_INSPECT_SCRIPT extracts a parameter's HelpMessage via `$__n.Argument.Value` (line 313). `.Value` only exists on `ConstantExpressionAst`. For any other syntactically-valid attribute-argument AST node — e.g. `VariableExpressionAst` for `$true`/`$false`, which PowerShell explicitly permits as attribute arguments — non-strict member access returns `$null` rather than throwing, so the `try{}catch{}` never fires and `$__help` becomes `$null` (or an `Int32` for `HelpMessage=5`) instead of a string. `ConvertTo-Json` emits `"helpMessage":null` (or `5`), but the Rust struct `ScriptParameterInfo` declares `pub help_message: String` (not `Option<String>`), so `serde_json::from_str` fails to deserialize that array element. Deserialization of `Vec<ScriptParameterInfo>` is atomic, so ONE bad element poisons the whole array and `get_script_parameters` falls through `unwrap_or_default()`, discarding every other correctly-parsed parameter in the same script.

**Failure scenario:** Script: `param([Parameter(Mandatory)][string]$RequiredNoHelp,[Parameter(Mandatory, HelpMessage=$true)][string]$RequiredWithBadHelp)`. Verified empirically via PARAM_INSPECT_SCRIPT against powershell.exe: produces `[{...,"helpMessage":""},{...,"helpMessage":null}]`, which `serde_json::from_str::<Vec<ScriptParameterInfo>>` rejects outright. The frontend then believes the script has no parameters and runs it directly without prompting for either required value.

**Evidence:**

````
pub struct ScriptParameterInfo { pub name: String, pub type_name: String, pub is_mandatory: bool, pub has_default: bool, pub position: Option<i32>, pub help_message: String }
if ($__n.ArgumentName -eq 'HelpMessage') { try { $__help = $__n.Argument.Value } catch {} }
Empirical: `param([Parameter(Mandatory, HelpMessage=$true)][string]$Name)` -> `"helpMessage":null`; `HelpMessage=5` -> `"helpMessage":5`. Both are valid, runnable PowerShell.
````

**Suggested fix:** Make help_message an Option<String> on the Rust side, or coerce $__help to string ($__help = [string]$__n.Argument.Value) in the PS extraction script so it always serializes as a string.

### S3-10 — get_snippets_from discards ALL snippets (including built-ins) on a transient/permission read failure of snippets.json

**Severity:** MEDIUM · **Where:** `src-tauri/src/commands.rs:1871`

get_snippets_from() starts from `builtin_snippets()` and, if snippets.json exists, tries to read+merge user snippets. The JSON-parse-failure branch correctly falls back to `Ok(snippets)` after backing up the corrupt file, but the read itself uses `with_retry(...)?`, which propagates any unretryable I/O error (e.g. PermissionDenied, which `is_transient()` explicitly excludes from retry) straight out via `?` — discarding the already-populated built-in snippets and returning Err instead of Ok(snippets).

**Failure scenario:** User has a snippets.json. While opening the Command Palette, the file is momentarily locked (AV scan, OneDrive sync, restrictive ACL) producing PermissionDenied. get_snippets_from returns Err; CommandPalette.tsx's `.then(...).catch(() => {})` silently swallows it and never calls setSnippets. The palette shows zero snippets — not even the ~20 built-ins — with no error message, until the lock clears and the panel is reopened.

**Evidence:**

````
let content = with_retry("read_user_snippets", || std::fs::read_to_string(&user_path))?;
// is_transient() explicitly does NOT retry PermissionDenied
// frontend: cmd.getSnippets().then((s)=>{...}).catch(() => {});
````

**Suggested fix:** On a read failure, log a warning and fall through to Ok(snippets) (built-ins) instead of propagating via `?`, matching the parse-error branch's graceful degradation.

### S3-11 — Debug breakpoints from prior debug runs are never removed in a persisted runspace, causing stale/duplicate ps-debug-break events on unrelated later runs

**Severity:** MEDIUM · **Where:** `src-tauri/src/powershell.rs:875`

Each debug run's wrapper script resets only the PSForge-owned hit/condition/command hashtables before calling Set-PSBreakpoint for the CURRENT run's list — it never calls Remove-PSBreakpoint/Get-PSBreakpoint to clear breakpoints from a PRIOR run. Line breakpoints are scoped with `-Script $__psforge_script_path`, but Variable and Command breakpoints are registered with no `-Script` filter, so they stay live runspace-wide. Because `persist_runspace` defaults to true (persistRunspaceBetweenRuns !== false), the same PowerShell process/runspace is reused across consecutive debug runs, so a Variable/Command breakpoint set in run N is still live and firing in run N+1 — even after the user removes it from the UI — now resolving against the freshly-reset (empty) hashtables, so it fires unconditionally and reports a bogus line (`line.unwrap_or(0)`). Repeated debug-edit-debug cycles compound: each run adds another duplicate breakpoint, so a single variable touch can fire multiple nested debugger stops, and since bp ids are just `bp{idx+1}`, a stale bp1 collides with the current run's own bp1, corrupting hit-count bookkeeping. Sending one Continue only unwinds one of the nested stops, so the script appears stuck and Continue must be clicked N times.

**Failure scenario:** User sets a Variable breakpoint on `$total`, runs Debug, then removes the breakpoint in the UI and starts Debug again on a different script that also assigns `$total`. The debugger unexpectedly pauses/fires on that line with zero breakpoints configured, reporting line 0 or a stale line number — and this keeps happening on every subsequent debug run until the app/session restarts. Empirically verified with pwsh 7.6.3: registering the same Variable breakpoint twice (simulating two debug runs) then touching the variable once fires the action twice (`Total fires for a single assignment: 2`), requiring two Continues to actually resume.

**Evidence:**

````
wrapper_script.push_str("$global:__psforge_bp_hits = @{}\n"); // etc — no Get-PSBreakpoint | Remove-PSBreakpoint anywhere in the file (repo-wide grep: zero matches)
} else if let Some(var_name) = variable {
    wrapper_script.push_str("Set-PSBreakpoint -Variable '");
    ... // no -Script filter here, unlike the -Line branch
Empirical repro: 'Registered breakpoint count: 2' / 'fired (count=1)' / 'fired (count=2)' for one $x assignment.
````

**Suggested fix:** Before registering the current run's breakpoints, clear stale PSForge-owned ones from a prior run, e.g. `Get-PSBreakpoint | Remove-PSBreakpoint` (or track/remove only the ids PSForge itself set) at the top of the breakpoint-registration block in the wrapper script.

**Verifier corrections/notes:**
- Scope and mechanism as described are accurate, but per this task's severity rubric (CRITICAL=data-loss/crash, HIGH=stability/cross-platform, MEDIUM=UX/correctness, LOW=polish), this is not a crash or app-stability issue and is not cross-platform in nature — it's confined to the debugger feature producing incorrect breakpoint behavior (spurious stops, wrong reported line, corrupted hit-count bookkeeping, needing extra Continue clicks) across repeated Debug-panel runs when Variable/Command breakpoints are used with the persist-runspace default. That is a real, user-reachable correctness/UX bug in a specific feature, not a whole-app stability or crash risk, so MEDIUM is the better fit than HIGH.

### S3-12 — start_terminal orphans the spawned PowerShell process if PTY reader/writer handle acquisition fails after spawn

**Severity:** MEDIUM · **Where:** `src-tauri/src/terminal.rs:320`

In start_terminal, the child process is spawned (pair.slave.spawn_command(cmd)), then the code tries to acquire the PTY reader (pair.master.try_clone_reader()) and writer (pair.master.take_writer()). Both use `.map_err(...)?`, so if either call fails, the function returns Err(AppError) immediately, dropping `child` (and pair.master) without ever calling child.kill(). Verified in vendored portable-pty 0.9.0 (win/mod.rs): WinChild has no Drop impl that terminates the process — dropping it only closes the process handle, it does not call TerminateProcess.

**Failure scenario:** If try_clone_reader()/take_writer() transiently fails after a successful spawn (brief handle/resource contention right after ConPTY creation), start_terminal returns TERMINAL_READER_INIT_FAILED/TERMINAL_WRITER_INIT_FAILED to the frontend — but the `pwsh.exe -NoExit ...` process it just spawned keeps running forever: no PID was recorded, no Session was inserted into TERMINALS, nothing else can reach or kill it. It sits invisible consuming memory for the life of the OS session, and its bootstrap temp script is only cleaned up by the 10-minute stale-file sweep at next app startup, not the leaked process itself.

**Evidence:**

````
let child = pair.slave.spawn_command(cmd).map_err(...)?;
drop(pair.slave);
let mut reader = pair.master.try_clone_reader().map_err(...)?;
let writer = pair.master.take_writer().map_err(...)?;
// No child.kill() call on either early-return path.
````

**Suggested fix:** On the reader/writer acquisition error paths, call child.kill() (or store child in a guard that kills on early drop) before returning the AppError.

### S3-13 — Copy Last Run Output / Copy Debug Bundle use a raw xterm buffer-line-index baseline that is invalidated by reflow (resize) and scrollback eviction (25,000-line cap), copying the wrong content

**Severity:** MEDIUM · **Where:** `src/components/TerminalPane.tsx:536`

lastRunOutputStartLineRef.current stores an absolute xterm buffer line index (term.buffer.active.length) captured right before a script run starts. copyLastRunOutputToClipboard/copyDebugBundleWithRunOutput later compute `total - startLine` and ask getContent() for that many TAIL lines of the CURRENT buffer. This assumes buffer line indices are stable over time, but they are not, for two independent reasons that both invalidate the same baseline arithmetic: (1) xterm.js reflows the entire scrollback buffer (re-wrapping every line to the new column count, changing buffer.active.length) whenever the terminal's column count changes, which FitAddon.fit() triggers on every container resize via the ResizeObserver/window-resize listeners registered in this same component — the normal path any time the user drags the editor/terminal splitter or resizes the window; and (2) once total scrollback exceeds the configured cap (25,000 lines, rows+scrollback), xterm's CircularList trims old lines from the front and buffer.active.length stops growing while every remaining line's index shifts down by the trimmed amount. Nothing recomputes or invalidates the stored baseline after either event, so the tail-length arithmetic silently operates on stale indices.

**Failure scenario:** Reflow case: run a script (F5) that prints output containing wrapped lines; the baseline is captured as the pre-run buffer length. Before copying, resize the terminal pane (drag the split, or resize the window) — common when widening the terminal to read output before copying. xterm reflows the buffer, shifting every earlier line's index. Clicking "Copy Last Run Output"/"Copy Debug Bundle" now targets the wrong window of the buffer: unrelated pre-run content gets prepended or trailing run output gets clipped. Eviction case: in a single long-lived session (interactive use plus repeated F5 runs, or one script printing tens of thousands of lines), once total scrollback exceeds ~25,000 lines, getTerminalLineCount() stops increasing while content shifts underneath; a `total - startLine` computed for a run whose baseline was captured before the cap now vastly overstates the amount of new output, copying most/all of the current buffer instead of just the last run's output. Both corrupt the exact artifact the app's AI paste-and-run-and-debug loop depends on.

**Evidence:**

````
lineCountFnRef.current = () => term.buffer.active.length;
// resize -> reflow: window.addEventListener("resize", onWindowResize); resizeObserver.observe(containerRef.current); (both call scheduleFit())
export async function copyTerminalOutputFromLine(startLine: number) {
  const total = getTerminalLineCount();
  if (total <= startLine) return false;
  const lineCount = total - startLine;
  const text = getTerminalPlainContent(lineCount);
  ...
}
// xterm Buffer.ts: reflow enabled path (`if (this._isReflowEnabled) { this._reflow(newCols, newRows); }`) and CircularList trimStart on scrollback cap.
````

**Suggested fix:** Don't rely on raw buffer line indices across time. Either write an explicit sentinel/marker into the PTY stream at run-start and search for it when copying, or snapshot the actual output text (not just a line count) at run boundaries, or re-derive/clamp the baseline immediately after any resize/eviction event.

**Verifier corrections/notes:**
- Mechanism and reachability are as described, but per the stated rubric (CRITICAL=data-loss/crash, HIGH=stability/cross-platform, MEDIUM=UX/correctness, LOW=polish) this is a silent-wrong-output correctness bug, not a crash, data-loss, or stability/cross-platform defect — it does not corrupt files on disk, crash the app, or affect any platform differently. That places it at MEDIUM, not HIGH. (Impact is somewhat elevated within MEDIUM because the corrupted artifact feeds an AI-assisted debug workflow that is a headline feature of this app, but it still doesn't meet the HIGH bar as defined.)

### S3-14 — stripSimpleHtml runs before fence/prose stripping; prose apostrophes desync its string tracker and HTML survives inside pasted code

**Severity:** MEDIUM · **Where:** `src/sanitize-paste.ts:401`

sanitizePastedTextWithSummary calls stripSimpleHtml (step 3) on the raw paste before extractEmbeddedMarkdownFences (step 4) and stripProseWrappers (step 8). stripSimpleHtml uses splitPsStringSegments to avoid stripping HTML inside real PS string literals (the S2-12 fix), but that function treats ANY bare ' or " anywhere in the input as a string delimiter — including in surrounding chat prose. A single unpaired apostrophe in a normal English contraction (e.g. "Here's the script:") before a fenced code block flips the tracker into "inside a string" for the rest of the input, so HTML tags copied from a docs page inside the actual code are never stripped. extractEmbeddedMarkdownFences then correctly pulls out just the code fence body afterward, but the un-stripped HTML tags are still in it. This is a regression of the exact use case S2-12 fixed, reintroduced by the ordering relative to the prose surrounding a fence.

**Failure scenario:** Paste: "Here's the script:\n```powershell\n<pre>Get-ChildItem</pre>\n```\nNote: run as admin". Expected after Paste Clean + Format: `Get-ChildItem`. Actual (verified with a vitest repro): the extracted/run script is the literal text `<pre>Get-ChildItem</pre>`, invalid PowerShell that fails to parse/run.

**Evidence:**

````
function stripSimpleHtml(input) { return splitPsStringSegments(input).map((seg) => seg.isString ? seg.text : seg.text.replace(SIMPLE_HTML_RE, ...)).join(""); }
// called at step 3, BEFORE extractEmbeddedFences (step 4) and stripProseWrappers (step 8)
// Empirically confirmed via vitest: input "Here's the script:\n```powershell\n<pre>Get-ChildItem</pre>\n```\nNote: run as admin" sanitizes to "<pre>Get-ChildItem</pre>" (tags not stripped).
````

**Suggested fix:** Run extractEmbeddedMarkdownFences (and/or stripProseWrappers) before stripSimpleHtml so the string-literal tracker only ever sees the actual code body, not surrounding chat prose apostrophes.

**Verifier corrections/notes:**
- Reachable code is accurate but the anchor line is off: opts.stripSimpleHtml executes at lines 410-413 (not 401, which is the normalizeNewlines block); extractEmbeddedMarkdownFences is invoked at line 415, stripProseWrappers at lines 435-439. Everything else in the report (mechanism, failure scenario, evidence) checks out and was independently reproduced. Severity should be MEDIUM (UX/correctness), not HIGH — no crash, no data loss, no stability/cross-platform effect; the broken output is visibly inserted into the editor for the user to notice/fix rather than silently corrupting persisted state.

### S3-15 — Line-number-gutter heuristic still misfires on 3+ sequential literal-integer Pester pipeline assertions

**Severity:** MEDIUM · **Where:** `src/sanitize-paste.ts:301`

looksLikeLineNumberGutter (the S2-15 fix) requires >=2 strictly-increasing 'N |'/'N:' matches covering >=60% of non-blank lines before stripping leading digits as a copy-pasted gutter. A real Pester test snippet with three or more literal sequential integers piped into assertions (e.g. `1 | Should -Be 1`, `2 | Should -Be 2`, `3 | Should -Be 3`) satisfies this threshold exactly (3 matches, strictly increasing, 100% coverage), so the sanitizer strips the leading 'N |' from every line, corrupting valid Pester code. The S2-15 regression test only exercises the single-line case (nums.length < 2); it doesn't cover the >=2-line false-positive the new threshold itself introduces.

**Failure scenario:** Paste a 3-assertion Pester snippet:\n1 | Should -Be 1\n2 | Should -Be 2\n3 | Should -Be 3\n\nExpected: unchanged (valid PowerShell/Pester). Actual (verified with a vitest repro): sanitized to `Should -Be 1\nShould -Be 2\nShould -Be 3`, silently changing each assertion's semantics (no piped input to Should -Be) and breaking the test file when run.

**Evidence:**

````
function looksLikeLineNumberGutter(input) { ... if (nums.length < 2 || nums.length < Math.ceil(nonBlank * 0.6)) return false; for (i=1;...) { if (nums[i] <= nums[i-1]) return false; } return true; }
// Empirically confirmed via vitest: sanitizePastedText("1 | Should -Be 1\n2 | Should -Be 2\n3 | Should -Be 3", FULL_PASTE_SANITIZE_OPTIONS) === "Should -Be 1\nShould -Be 2\nShould -Be 3".
````

**Suggested fix:** Require a much higher line count and/or check that the token after 'N |' isn't itself a plausible PowerShell pipeline element (e.g. a bare literal matching the Should/Pester assertion pattern) before treating it as a gutter.

**Verifier corrections/notes:**
- Severity is correctly MEDIUM, not higher: the edit goes through editor.executeEdits (standard Monaco undoable edit, so Ctrl+Z recovers the original), and showAppToast(formatPasteSummaryMessage(summary)) explicitly surfaces "N line number gutters removed" to the user immediately after the paste, giving a visible signal and an easy recovery path. No data loss (clipboard/undo intact) and no crash/instability, so this is a correctness/UX bug (silent-by-default unless the user reads the toast) rather than CRITICAL or HIGH.

### S3-16 — Scratch auto-save debounce timer is never cancelled when a tab stops being an autosave candidate (closed/discarded, or reverted to clean) — a discarded scratch file can be resurrected on disk

**Severity:** MEDIUM · **Where:** `src/App.tsx:2506`

The untitled-tab scratch-autosave effect keys a 1200ms setTimeout per tab id in scratchSaveTimersRef. Each run of the effect only clears+reschedules the timer for tabs it currently iterates into the "still dirty and untitled" branch (`if (tab.tabType === "welcome" || tab.filePath || !tab.isDirty) continue;`). If a tab id drops out of that set — the tab is closed, or its content reverts to equal savedContent (isDirty flips false) — the previously scheduled timer stays armed in the map and nobody ever calls clearTimeout on it. finalizeCloseTab, which runs the Discard/Save-as/Keep choices from CloseScratchDialog, does not touch scratchSaveTimersRef at all.

**Failure scenario:** Ctrl+N creates an untitled tab; user types a script. After ~300ms the effect schedules a scratch-save timer. Before 1200ms elapses, user closes the tab and picks "Discard". finalizeCloseTab's discard branch calls cmd.deleteScratchFile(scratchPath) — a no-op since nothing has been written yet (backend only removes the file if it exists) — then dispatches CLOSE_TAB. The pending timer is never cancelled. At t=1200ms the orphaned timeout still fires: it calls cmd.saveFileContent with the stale closed-over tab, writing the just-discarded content to scratchDir/<tabId>.ps1. On the next app launch, listScratchFiles() finds this file; since its tabId isn't in the live openIds set, ScratchRecoveryDialog offers to "recover" a script the user explicitly discarded — silently resurrecting deleted content.

**Evidence:**

````
for (const tab of state.tabs) {
  if (tab.tabType === "welcome" || tab.filePath || !tab.isDirty) continue;
  const existing = scratchSaveTimersRef.current.get(tab.id);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => { ...cmd.saveFileContent(path, tab.content, tab.encoding)... }, 1200);
  scratchSaveTimersRef.current.set(tab.id, timer);
}
// finalizeCloseTab discard branch: only calls cmd.deleteScratchFile, no timer cancellation
// backend delete_scratch_file: if target.exists() { std::fs::remove_file(target)?; } — no-op if not yet written
````

**Suggested fix:** In finalizeCloseTab, before/around the CLOSE_TAB dispatch, look up and clearTimeout any pending entry in scratchSaveTimersRef.current for tab.id (and delete the map entry) for every choice. Also clear it inside the autosave effect when a previously-scheduled tab id no longer qualifies.

**Verifier corrections/notes:**
- Bug is real and root-caused correctly, but HIGH is overstated relative to this repo's CRITICAL=data-loss/crash, HIGH=stability/cross-platform, MEDIUM=UX/correctness rubric. Nothing crashes and no data the user wanted is lost — the opposite happens: content the user asked to discard is offered back via the existing recovery-dialog UX, not silently merged into a live tab. Worst case is a confusing/annoying prompt the user can dismiss/discard again next launch; it does not corrupt a live document, block the app, or lose data the user was trying to keep. That fits MEDIUM (UX/correctness) rather than HIGH (stability/cross-platform). The fix is still worth doing exactly as hinted: clearTimeout+delete the map entry for tab.id in finalizeCloseTab for every choice branch (and/or clear stale entries in the autosave effect for tabs that drop out of the dirty/untitled set).

### S3-17 — First scratch auto-save silently renames an untitled tab's display title from "Untitled-N" to the raw UUID-based scratch filename

**Severity:** MEDIUM · **Where:** `src/App.tsx:2517`

scratchPathForTab builds the on-disk scratch path from the tab's own id, and tab ids are `tab-<uuid>` (post S2-3 UUID switch). Both places that auto-save an untitled tab to scratch — the debounced effect and the auto-save-before-run path — set the tab's display `title` to basename(path) once tab.filePath is empty, i.e. to the ~44-character UUID filename, replacing the friendly "Untitled-N" label. Before the S2-3 id-collision fix (short tab-1/tab-2 counters), this same code path produced tolerable labels; after switching to UUIDs, it produces a much longer, meaningless label.

**Failure scenario:** Ctrl+N opens a tab titled "Untitled-1" (id e.g. tab-3fa85f64-5717-4562-b3fc-2c963f66afa6). User types a few lines and pauses >1.2s (or presses F5 with default autoSaveOnRun: true). The scratch-autosave effect (or run pre-flight save) dispatches UPDATE_TAB with title: basename(path) where path is `.../scratch/tab-3fa85f64-....ps1`. TabBar now shows the full UUID filename instead of "Untitled-1" for the rest of the session (and in subsequent unsaved-changes dialogs, which quote tab.title), even though the user never asked to save the file anywhere.

**Evidence:**

````
const timer = window.setTimeout(() => {
  ...
  void cmd.saveFileContent(path, tab.content, tab.encoding).then(() => {
    dispatch({ type: "UPDATE_TAB", id: tab.id, changes: { filePath: path, title: basename(path), savedContent: tab.content, isDirty: false } });
  })
// scratchPathForTab: `${scratchDir}${sep}${tabId}.ps1`
// newTabId(): `tab-${crypto.randomUUID()}`
````

**Suggested fix:** Don't overwrite the visible title on a scratch auto-save — only set filePath/savedContent/isDirty. Keep the user-facing "Untitled-N" label until a real user-directed Save/Save-As assigns a real filename.

**Verifier corrections/notes:**
- One nuance the fix_hint misses: TabBar's own visible tab-strip label (TabBar.tsx disambiguateTabs/baseName, lines 22-26) does NOT read tab.title once tab.filePath is truthy — it recomputes the label from `tab.filePath`'s basename directly. Since both auto-save sites also set `filePath: path` (the scratch path) alongside `title`, the main tab-strip label would still show the ugly UUID filename even if the title field were left untouched, because filePath itself now points at the scratch file. So the suggested fix (only set filePath/savedContent/isDirty, leave title alone) fixes the CloseScratchDialog / close-confirmation text but does NOT fix the primary visible symptom in the tab strip itself — that would additionally require TabBar to special-case scratch-backed paths (e.g. via isScratchBackedTab) and fall back to tab.title for those, or the store to avoid conflating the internal scratch backing path with a user-facing 'saved to this path' filePath in the first place. Severity MEDIUM is still appropriate given no data loss and a real fix exists, just broader than the hint suggests.
- Confirmed at src/App.tsx:2517 and src/App.tsx:1585 exactly as described. However, the fix_hint as written ("only set filePath/savedContent/isDirty ... keep Untitled-N label") is incomplete: TabBar's displayed tab caption (src/components/TabBar.tsx `disambiguateTabs`/`baseName`, lines 22-26 and 229) reads `tab.filePath`'s basename in preference to `tab.title` whenever `filePath` is set, so the visible tab-bar label would still show the ugly UUID-based scratch filename even after that fix — only the run-history label (App.tsx:1739, rendered in WelcomePane) and the close-scratch confirmation text (CloseScratchDialog.tsx:49, and TabBar.tsx's own confirmDiscard fallback at lines 117/141) would be fixed by the suggested change. A full fix should also make TabBar prefer `tab.title` (or otherwise suppress the raw scratch path) for scratch-backed tabs so the tab-bar caption itself doesn't regress to the UUID name.
- Fix should address both symptoms: (1) don't let scratch autosave overwrite tab.title with basename(path) — keep the "Untitled-N" label; and (2) since TabBar.tsx's disambiguateTabs() derives the displayed label from tab.filePath whenever it's set (not from tab.title), also make TabBar treat scratch-backed paths (isScratchBackedTab helper already exists in scratch-utils.ts) as "no display path" so it falls back to tab.title instead of the scratch UUID filename. Fixing only the title field, as the original fix_hint suggests, leaves the main tab-bar label unchanged.

### S3-18 — Adding a Run Directory Preset and typing its name before its path silently deletes the row

**Severity:** MEDIUM · **Where:** `src/components/SettingsPanel.tsx:1022`

The preset Name input's onChange runs normalizeRunDirPresets() on every keystroke, which drops any preset whose path is still empty (`if (!name || !path) continue;`). The Path input's onChange does NOT run normalization — it commits the raw array. A freshly-added preset (via "Add preset") starts with a non-empty placeholder name ("Preset N") and an empty path (""). If the user edits the Name field first — the natural order for filling out a name/path pair — the very first keystroke calls normalizeRunDirPresets(presets), sees path === "" for that row, and filters it out before it's ever dispatched. The row disappears instantly with no warning.

**Failure scenario:** Settings > Execution > Run Directory Presets > click "Add preset" (creates {name:'Preset 1', path:''}) > click into the Name field and type any character (e.g. rename to 'Scripts'). On this first keystroke the row vanishes from the list — the user has to start over, and if they don't notice, cannot add a named preset without first filling the path field in a specific, non-obvious order.

**Evidence:**

````
onChange={(e) => {
  const presets = [...(state.settings.runDirPresets ?? [])];
  presets[index] = { ...preset, name: e.target.value };
  updateSetting("runDirPresets", normalizeRunDirPresets(presets));
}}
// vs. path field onChange which calls updateSetting("runDirPresets", presets) with no normalization
// run-dir-presets.ts: for (const preset of presets) { const name = preset.name.trim(); const path = preset.path.trim(); if (!name || !path) continue; ... }
````

**Suggested fix:** Only run normalizeRunDirPresets() on blur/save (or when both fields are non-empty), not on every Name keystroke — or make normalizeRunDirPresets() not drop rows that merely have an empty path, enforcing the non-empty rule only when settings are actually persisted/used.

**Verifier corrections/notes:**
- Downgrade HIGH to MEDIUM: this is a UX/correctness defect (silent loss of an unsaved, freshly-added row due to premature normalization), not a stability or cross-platform issue. Nothing crashes and no previously-persisted data is destroyed — the preset never existed in saved settings before vanishing — so it doesn't meet the CRITICAL/HIGH bar of data-loss-of-persisted-state or app instability. It does cause real, avoidable user frustration (silent, unexplained loss of in-progress input) and merits a straightforward fix (defer normalization to blur/save, or don't drop empty-path rows until persist time), consistent with a MEDIUM UX/correctness classification.

### S3-19 — Editor Font Preset selector overwrites the independently-configured terminal font even when fonts are unlinked

**Severity:** MEDIUM · **Where:** `src/components/SettingsPanel.tsx:240`

applyMonospacePreset's branch condition is `target === "editor" || linked`, an OR. Since the Editor "Font Preset" dropdown always calls this with target === "editor", the condition is always true regardless of linkEditorOutputFonts, so it always sets BOTH fontFamily and outputFontFamily to the chosen preset. This contradicts the documented behavior of the adjacent "Link Editor & Terminal Fonts" control ("sizes/family can still differ when unlinked") and contradicts the sibling "Terminal Font Preset" control, which correctly only touches outputFontFamily when unlinked.

**Failure scenario:** Uncheck "Link Editor & Terminal Fonts". Set Terminal Font Preset to "JetBrains Mono" (outputFontFamily correctly updates, fontFamily untouched). Later, change the Editor "Font Preset" dropdown to "Fira Code" expecting only the editor font to change. Instead outputFontFamily is silently reset to "Fira Code" too, discarding the independently-chosen terminal font with no indication.

**Evidence:**

````
const applyMonospacePreset = (family: string, target: "editor" | "output") => {
  if (target === "editor" || state.settings.linkEditorOutputFonts !== false) {
    dispatch({ type: "SET_SETTINGS", settings: { ...state.settings, fontFamily: family, outputFontFamily: family } });
    return;
  }
  updateSetting("outputFontFamily", family);
};
````

**Suggested fix:** Change the condition to `target === "editor" && linked` for the "set both" branch, and add an `else if (target === "editor") updateSetting("fontFamily", family);` branch for the unlinked editor case.

**Verifier corrections/notes:**
- Severity should be MEDIUM, not HIGH. Per the given rubric (CRITICAL=data-loss/crash, HIGH=stability/cross-platform, MEDIUM=UX/correctness, LOW=polish), this is a pure settings-correctness bug: a user preference (terminal font) is silently overwritten. It does not crash the app, does not affect script/file data, and has no stability or cross-platform dimension — it fits MEDIUM (UX/correctness) squarely.

### S3-20 — Status bar Editor size +/- silently overwrites an independently-set terminal font size whenever fonts are linked

**Severity:** MEDIUM · **Where:** `src/components/FontQuickControls.tsx:44`

bumpEditorSize forces outputFontSize to match the new fontSize whenever linked (linkEditorOutputFonts !== false, the default) is true: `outputFontSize: linked ? next : state.settings.outputFontSize`. But linkEditorOutputFonts only governs font FAMILY per its own tooltip in SettingsPanel.tsx ("editor and terminal share the same monospace font family — sizes can still differ") and per the fully independent, never-disabled "Output Font Size" NumberInput in Settings > Output. Because the "Terminal size" sub-control in this same popup is hidden whenever linked, the user has no visibility into, or way to prevent, this overwrite from the status bar control.

**Failure scenario:** With default linkEditorOutputFonts: true, go to Settings > Output and set "Output Font Size" to 20. Later, click the status bar font control and press "+" once on "Editor size". outputFontSize is silently reset to match the new editor size (e.g. 15), discarding the previously-set 20pt terminal font size with no warning and no way to see it happened from that popup (the Terminal size row is hidden while linked).

**Evidence:**

````
const bumpEditorSize = (delta: number) => {
  const next = Math.max(8, Math.min(72, (state.settings.fontSize ?? 14) + delta));
  patchSettings({ fontSize: next, outputFontSize: linked ? next : state.settings.outputFontSize });
};
````

**Suggested fix:** Drop the outputFontSize write from bumpEditorSize entirely — linkEditorOutputFonts should only ever touch font family, matching SettingsPanel.tsx's own updateSetting() and the documented behavior.

**Verifier corrections/notes:**
- Same file/line (FontQuickControls.tsx:44-53) and failure scenario as claimed are accurate. Severity should be MEDIUM, not HIGH: per the given rubric HIGH is reserved for stability/cross-platform issues, and this is a silent UX/correctness inconsistency (loses a persisted preference value, not a crash or data-loss of real user content) that is also intentionally duplicated in App.tsx's Ctrl+=/Ctrl+- shortcuts and documented in the original feature commit message, suggesting it's a debatable design choice rather than a pure oversight.

### S3-21 — Max Recent Files field is UI-capped at 50 even though the range validator and backend allow up to 100

**Severity:** MEDIUM · **Where:** `src/components/SettingsPanel.tsx:1283`

The "Max Recent Files" NumberInput is instantiated with max={50} — confirmed still present by reading the current file (line 1283). NumberInput commits live only within [min,max] and clamps to that same range on blur, so a value above 50 can never be entered or persisted through this control. But the panel's own validation message states "Max recent files must be between 1 and 100", matching the backend cap MAX_MAX_RECENT_FILES = 100 in settings.rs, and the sibling "Max Recent Runs" NumberInput a few rows below correctly uses max={100}. Note: AUDIT-FIXES #19 claims this exact cap was already widened to 100 — the live code contradicts that record, so either the fix regressed or was never applied to this control; either way the bug is currently present.

**Failure scenario:** Settings > Output > Max Recent Files: type '80', tab away. onBlur clamps Math.min(50, 80) to 50 — the field silently snaps to 50 instead of persisting 80, even though the backend and the panel's own displayed validation rule both say up to 100 is valid.

**Evidence:**

````
<NumberInput
  min={1}
  max={50}
  value={state.settings.maxRecentFiles ?? 20}
  onChange={(v) => updateSetting("maxRecentFiles", v)}
  error={validationErrors.maxRecentFiles}
  width="w-20"
/>
// validationErrors.maxRecentFiles message: "Max recent files must be between 1 and 100."; settings.rs: const MAX_MAX_RECENT_FILES: usize = 100;
````

**Suggested fix:** Change max={50} to max={100} to match the validator, backend cap, and the sibling Max Recent Runs control.

### S3-22 — Keyboard Shortcut panel auto-focuses its search box but never traps focus, so Tab escapes to the background app

**Severity:** MEDIUM · **Where:** `src/components/KeyboardShortcutPanel.tsx:153`

The panel autofocuses searchRef on open (setTimeout(() => searchRef.current?.focus(), 50)) but — unlike ScriptSigningDialog/ParamPromptDialog/SettingsPanel — never wires useFocusTrap. The panel's only focusable elements are the close button and the search input; from the search input, pressing Tab moves focus out of the modal entirely into the browser's natural document tab order (e.g. back into the toolbar or the Monaco editor), while the panel remains visually open on top. L1 explicitly did not cover this component.

**Failure scenario:** Press Ctrl+F1 to open the shortcut reference while editing a script. The search box auto-focuses. Type a filter query, then press Tab (a natural next action). Focus silently moves to the underlying editor/toolbar (panel still shown covering the screen). Continuing to type — thinking it is still filtering the shortcut list — instead inserts text into the open script.

**Evidence:**

````
KeyboardShortcutPanel.tsx: `import React, { useState, useEffect, useRef } from "react";` — no useFocusTrap import. Only autofocus-on-open via setTimeout; no Tab interception anywhere in the component.
````

**Suggested fix:** Add a ref to the panel card div and call useFocusTrap(panelRef, state.shortcutPanelOpen), matching the pattern in SettingsPanel.tsx.

**Verifier corrections/notes:**
- Line anchor is close but not exact: the useEffect block starts at line 153 as cited, but the actual offending autofocus call is line 157 (`setTimeout(() => searchRef.current?.focus(), 50)`). Everything else in the report (file, mechanism, comparison to the other 6 dialogs, failure scenario) is accurate as verified against the code.

### S3-23 — Debug bundle markdown fences break when script content or run output contains a literal ``` sequence

**Severity:** MEDIUM · **Where:** `src/debug-bundle.ts:76`

buildDebugBundleMarkdown() wraps tab.content and the captured terminal output verbatim inside ```powershell/```text fences with no check for embedded triple-backtick sequences. If the script's own source (or its printed output) contains a literal ``` — e.g. a here-string that builds a Markdown code sample — the embedded ``` prematurely closes the fence, and the following ``` re-opens/closes an unrelated anonymous block. The rest of the bundle (including PSForge's own closing fence and everything after it) renders outside any code fence. This is the exact bug class S2-1 fixed for paste sanitization (extractEmbeddedMarkdownFences), but debug-bundle.ts's own fence-wrapping was never given the same treatment.

**Failure scenario:** Script.ps1 contains a here-string building a markdown snippet with an embedded ``` fence. User hits an error and clicks "Copy Debug Bundle" (Ctrl+Shift+P). The generated markdown's ```powershell fence closes prematurely inside the here-string content, the embedded sample becomes an unrelated anonymous code block, and everything below (Terminal output section, etc.) renders as top-level prose instead of inside the intended fence when pasted into an AI chat — corrupting the exact artifact this feature exists to produce.

**Evidence:**

````
if (tab?.content?.trim()) {
  lines.push("", "### Script snapshot", "", "```powershell", tab.content.trimEnd(), "```");
}
...
if (output) {
  lines.push("```text", output, "```");
}
// verified with node repro: a script containing an embedded ``` fence produces an anonymous mid-block and leaves trailing content outside any fence.
````

**Suggested fix:** Reuse extractEmbeddedMarkdownFences/the S2-1 fence-safety logic (or a fence-length-detection wrapper that picks a longer backtick run than any found in the content) when building the debug bundle's code fences.

### S3-24 — pathKey() normalizes case but not path separators, so bookmarks/breakpoints fail to reattach across the app's own two path styles

**Severity:** MEDIUM · **Where:** `src/path-state-store.ts:44`

pathKey() only lower-cases the path on Windows; it never normalizes \\ vs /. PSForge itself produces both styles for the same absolute file: the native file-open dialog/CLI launch path returns native Windows paths with backslashes, while openScriptFolder in App.tsx explicitly forward-slash-normalizes every listed file (`${base}/${entry.name}`.replace(/\\/g, "/")`). getBookmarksForPath/getBreakpointsForPath/setBookmarksForPath/setBreakpointsForPath all key off pathKey(filePath) directly on whatever string openFile() was called with, so the same file opened through "Open Folder" vs "File > Open" hashes to two different keys. This is a residual bug within the L10 path-keyed persistence feature, not something L10 itself fixed.

**Failure scenario:** User opens C:\\Scripts\\foo.ps1 via File > Open, sets a bookmark on line 10 (persisted under key 'c:\\scripts\\foo.ps1'). Later uses "Open Folder" on C:\\Scripts, which lists the same file as C:/Scripts/foo.ps1 (forward slashes) and opens it in a new tab; getBookmarksForPath looks up key 'c:/scripts/foo.ps1' — a miss — so the previously-set bookmark silently does not reattach, even though it's the exact same file and the feature exists specifically to survive close/reopen.

**Evidence:**

````
function pathKey(filePath: string): string {
  if (!filePath) return "";
  return isWindowsRuntime() ? filePath.toLowerCase() : filePath;
}
// App.tsx openScriptFolder: .map((entry) => `${base}/${entry.name}`.replace(/\\/g, "/"))
// node repro: pathKey('C:\\Scripts\\foo.ps1') !== pathKey('C:/Scripts/foo.ps1') under case-only lowering
````

**Suggested fix:** Normalize separators (e.g. replace all backslashes with forward slashes) in pathKey() before lower-casing, so both path styles hash to the same key.

### S3-25 — Numeric parameter validation rejects valid PowerShell numeric literals (.5, 5., +5), permanently blocking Run

**Severity:** MEDIUM · **Where:** `src/components/ParamPromptDialog.tsx:158`

validateField()'s numeric regex `^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$` requires at least one digit before the decimal point and does not accept a leading +. This is the same regex AUDIT-FIXES #17 shipped (adding scientific-notation support) — confirmed unchanged in the current file — but it never addressed the missing-leading-digit / leading-plus cases. PowerShell itself accepts all of these when converting to numeric types (`[double]'.5'` -> 0.5, `[int]'+5'` -> 5), so a mandatory numeric parameter whose intended value is a common shorthand like .5 is flagged "Must be a number" and Run stays disabled, even though the exact same text would work if typed directly into a PowerShell console.

**Failure scenario:** A script declares `[Parameter(Mandatory)][double]$Threshold`. The dialog appears; user types `.5` (a natural way to enter a fractional threshold). validateField returns "Must be a number", the field shows an inline error, and canRun becomes false — Run stays disabled with no way to submit .5 even though PowerShell would parse it correctly.

**Evidence:**

````
!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())
// node repro: re.test('.5') === false, re.test('+5') === false, re.test('5.') === false
// powershell repro: [double]'.5' -> 0.5 ; [int]'+5' -> 5 (both succeed)
````

**Suggested fix:** Extend the regex to allow an optional leading + and a digitless integer part before the decimal, e.g. `^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`.

**Verifier corrections/notes:**
- Severity as originally rated (MEDIUM) is appropriate: correctness/UX bug with an easy workaround (re-type in canonical form like \"0.5\"), not data loss, crash, or cross-platform instability.

### S3-26 — quotePsArgument() leaves values with a dangerous leading character unquoted, corrupting the generated command

**Severity:** MEDIUM · **Where:** `src/components/ShowCommandPane.tsx:10`

quotePsArgument() only single-quotes a parameter value when it contains whitespace, a single quote, a double quote, or a backtick (`/[\s'"`]/`). Any value that starts with a PowerShell-significant character but contains none of those — `#`, `-`, `$`, `@` — is emitted completely bare. commandPreview() (lines 184-199) then joins `-ParamName` and the bare value with a single space, so the token is handed straight to the PowerShell parser as an unquoted argument. Depending on the leading character this either (a) opens a comment that silently deletes the rest of the line, (b) gets parsed as a different parameter switch, or (c) gets expanded as a variable reference instead of being treated as literal text. This is a sibling implementation to `TerminalPane.tsx:209-211`'s `quotePs()`, which unconditionally single-quotes and has none of these bugs — ShowCommandPane's own ad-hoc reimplementation is the only one of the three quoting helpers in the codebase with a conditional (buggy) fast path.

**Failure scenario:** User selects any cmdlet in Show Command, types `#123` into a parameter value field (e.g. an issue-number-shaped literal, or any text a user types that happens to start with `#`), and clicks 'Insert At Cursor' or 'Copy'. The generated text is `Cmdlet-Name -ParamA #123 -ParamB done`. Empirically verified: running `Test-Foo -Name #123 -Value done` throws `Missing an argument for parameter 'Name'` because `#123 -Value done` is parsed as a trailing line comment — the value AND every subsequent `-Param value` pair on the line are silently dropped. Two related leading-character cases were also empirically confirmed: a value of `-Value` (or any leading `-`) triggers the same 'Missing an argument' failure because it's parsed as another parameter name; a value of `$undefinedVar123` (leading `$`) does NOT error at all — `Test-Foo -Name $undefinedVar123 -Value done` returns `N= V=done`, i.e. the literal text the user typed is silently discarded and replaced with `$null`, with no error shown anywhere.

**Evidence:**

````
ShowCommandPane.tsx:10-13:
function quotePsArgument(value: string): string {
  if (!/[\s'"`]/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

commandPreview (lines 195-198):
      parts.push(`-${param.name}`);
      parts.push(quotePsArgument(trimmed));
    }
    return parts.join(" ");

Empirical repro (pwsh):
> function Test-Foo { param($Name,$Value) "N=$Name V=$Value" }; Test-Foo -Name #123 -Value done
Test-Foo: Missing an argument for parameter 'Name'. Specify a parameter of type 'System.Object' and try again.
> function Test-Foo { param($Name,$Value) "N=$Name V=$Value" }; Test-Foo -Name -Value done
Test-Foo: Missing an argument for parameter 'Name'. Specify a parameter of type 'System.Object' and try again.
> function Test-Foo { param($Name,$Value) "N=$Name V=$Value" }; Test-Foo -Name $undefinedVar123 -Value done
N= V=done
````

**Suggested fix:** Drop the conditional and always single-quote, matching TerminalPane.tsx:209-211's unconditional quotePs() (`'${value.replace(/'/g, "''")}'`). There is no value for which bare emission is actually needed here, so the whitelist-of-safe-characters approach is strictly worse than always quoting.

**Verifier corrections/notes:**
- Reachability and mechanism are correctly described — keep the finding, but the severity rubric in use (CRITICAL=data-loss/crash, HIGH=stability/cross-platform, MEDIUM=UX/correctness, LOW=polish) fits this as MEDIUM, not HIGH. The bug never crashes or destabilizes PSForge itself, and it isn't a cross-platform issue — it's a text-generation correctness bug in one optional convenience feature (Show Command builder). The two `#`/`-` cases fail loudly with a PowerShell parser error the instant the user runs the inserted text, which is self-limiting (annoying, not dangerous). The `$` case is the genuinely concerning one — silent substitution of $null for user-typed text with no error — but it still requires the user to (a) type an unquoted variable-shaped value into a Show Command parameter field, (b) not notice the preview differs from intent, and (c) then execute a command where a silently-nulled parameter causes real harm; that chain of preconditions is why this reads as correctness/UX rather than a HIGH-severity stability issue. Fix (always single-quote via quotePsArgument, matching TerminalPane.tsx's unconditional quotePs) is correct and cheap regardless of severity label.

### S3-27 — PS-path change while sidebar is hidden leaves ShowCommandPane serving stale module list from the previous PowerShell install

**Severity:** MEDIUM · **Where:** `src/components/ShowCommandPane.tsx:59`

Only Sidebar.tsx resets the shared state.modules/state.modulesLoading when state.selectedPsPath changes (Sidebar.tsx:169-180), and that effect only runs while <Sidebar/> is mounted (App.tsx:3278/3325, gated on state.sidebarVisible which defaults to false per AUDIT-FIXES S2-21). ShowCommandPane's own path-change effect only clears its own local component state (selectedModule, selectedCommand, commandsByModule, commandParams, paramValues, error strings) and never dispatches SET_MODULES/SET_MODULES_LOADING to reset the shared modules list.

**Failure scenario:** Sidebar hidden (default). User opens 'Show Command', modules load for PS path A (state.modules now non-empty, tied to A). User then switches the active PowerShell version via the Toolbar PS-version <select> (Toolbar.tsx:316-327, dispatches SET_SELECTED_PS directly with no module reset) to path B, without ever opening the sidebar. Back in 'Show Command', ShowCommandPane's path-change effect (lines 59-68) clears only local UI selection state; state.modules.length is still >0 (stale from A), so the load-effect guard at line 72 (`state.modules.length > 0 || state.modulesLoading`) skips reloading. The module dropdown keeps offering path A's module list while state.selectedPsPath is now B; picking any module/command from the stale list calls get_module_commands/get_command_parameters against path B with a module name/metadata that may not exist (or differs) there, producing a lookup failure or wrong parameter metadata for the actually-selected PowerShell installation.

**Evidence:**

````
useEffect(() => {
    setSelectedModule("");
    setSelectedCommand("");
    setCommandsByModule({});
    setCommandParams([]);
    setParamValues({});
    setModuleError("");
    setCommandsError("");
    setParamsError("");
  }, [state.selectedPsPath]); // never touches state.modules / dispatches SET_MODULES

  useEffect(() => {
    if (!state.selectedPsPath) return;
    if (state.modules.length > 0 || state.modulesLoading) return; // stale modules.length>0 from prior path blocks reload
    void loadModules();
  }, [loadModules, state.selectedPsPath, state.modules.length, state.modulesLoading]);
````

**Suggested fix:** Dispatch SET_MODULES:[] (and clear moduleError) alongside the local-state reset when state.selectedPsPath changes, so the shared module list is invalidated for every consumer, not just Sidebar's.

### S3-28 — psforge-insert handler silently no-ops with zero user feedback when no code editor is active

**Severity:** MEDIUM · **Where:** `src/components/EditorPane.tsx:302`

The single consumer of the `psforge-insert` CustomEvent (dispatched by CommandPalette.tsx:70 for snippets, ShowCommandPane.tsx:203-205 for built commands, and Sidebar.tsx:285 for module command names) guards with `if (!text || !editorRef.current) return;` and does nothing else — no toast, no terminal notice, no console warning. `editorRef.current` is only populated by Monaco's `onMount`, which per the component's own header comment doesn't fire when the active tab is the 'welcome' tab (WelcomePane is rendered in its place, per the doc comment 'When the active tab is a "welcome" tab, renders the WelcomePane instead.'). The Welcome tab is the app's actual initial tab on first launch (store.tsx:390-411, `createInitialTab()`), and both the Command Palette (Ctrl+Shift+P / Ctrl+J) and the Show Command bottom-panel tab are reachable regardless of which editor tab is active — the bottom panel is independent of the top editor tab strip, so a user can have Show Command open while the editor area still shows Welcome.

**Failure scenario:** First-run user (no `psforge.welcomed` localStorage key yet) launches PSForge, is shown the Welcome tab, and — without opening or creating a file first — presses Ctrl+Shift+P and picks any snippet, or opens the Show Command tab, fills in a command, and clicks 'Insert At Cursor'. `window.dispatchEvent(new CustomEvent('psforge-insert', ...))` fires, EditorPane's handler sees `editorRef.current === null`, and returns immediately. The palette/pane closes (or stays open) with no text inserted anywhere and no error, toast, or log message — the user has no way to tell the action did nothing versus succeeding invisibly.

**Evidence:**

````
EditorPane.tsx:302-318:
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (!text || !editorRef.current) return;
      const editor = editorRef.current;
      ...

store.tsx:390-405 createInitialTab():
    const welcomed = localStorage.getItem("psforge.welcomed");
    if (!welcomed) {
      localStorage.setItem("psforge.welcomed", "1");
      return { id: "tab-welcome", ..., tabType: "welcome" };

EditorPane.tsx:3 (header comment): "When the active tab is a \"welcome\" tab, renders the WelcomePane instead."
````

**Suggested fix:** When `!editorRef.current`, surface feedback via the existing `showAppToast` helper (already imported in EditorPane.tsx) instead of silently returning, e.g. 'Open a script tab to insert here.'

## LOW (4)

### S3-29 — Any script output line that happens to match the internal PSFORGE_DONE marker format is silently swallowed instead of shown, regardless of whether it belongs to the current run

**Severity:** LOW · **Where:** `src-tauri/src/powershell.rs:1115`

parse_run_complete_marker/parse_run_complete_stderr_marker only check text shape (prefix + trailing '>>' + parseable fields) — they don't require the id to match the active command_id to be treated as a marker. In execute()'s main select loop, once either parser returns Some(...), the line is `continue`d (never passed to on_output) even when `done_id != command_id`, i.e. even when explicitly recognized as belonging to a different/unknown command. Any user script line that coincidentally matches `<<PSFORGE_DONE|<text>|<int>>>` or `<<PSFORGE_DONE_ERR|<text>>>` is removed from the visible output stream with no indication a line was dropped.

**Failure scenario:** A debugged script prints a diagnostic that coincidentally matches the marker shape, e.g. `Write-Output '<<PSFORGE_DONE|batch1|0>>'` as part of its own status logging. That line never appears in the Output/Variables pane, discarded by the `continue` even though its done_id ('batch1') doesn't match the real running command's UUID.

**Evidence:**

````
if let Some((done_id, code)) = parse_run_complete_marker(&line.text) {
    if done_id == command_id { ... }
    // Marker for an unrelated command; do not surface.
    continue;
}
````

**Suggested fix:** Only treat the line as a marker (and suppress it) when done_id == command_id; otherwise pass it through to on_output like any other line.

**Verifier corrections/notes:**
- File/description are accurate; the anchor line is best placed at 1116 (the `parse_run_complete_marker` check) rather than 1115 (which is the `Some(SessionEvent::Output(line)) =>` match arm one line above it). The unconditional `continue` that swallows the line is at line 1124. The same flaw is duplicated in the stderr-drain loop at lines 1088-1099 (worth noting in the fix, since the fix_hint's single-site fix should be applied to both occurrences, or refactored into one shared check).

### S3-30 — Session-persist effect reads state.referenceSubview but omits it from the dependency array — Reference-pane sub-tab selection doesn't survive a restart unless another tracked field also changes

**Severity:** LOW · **Where:** `src/store.tsx:1284`

The useEffect that writes PersistedSession to localStorage builds its snapshot using `referenceSubview: state.referenceSubview`, but the effect's dependency array lists only tabs, activeTabId, bottomPanelTab, workingDir, selectedPsPath, breakpoints, bookmarks — state.referenceSubview is missing. React only re-runs (and re-persists) the effect when a listed dependency changes identity; changing only referenceSubview does not trigger a re-run, so the persisted value goes stale.

**Failure scenario:** User opens the Reference tab (bottomPanelTab becomes "reference", referenceSubview defaults to "problems") — effect runs, persists referenceSubview="problems". User clicks the "Help" sub-tab; OutputPane.tsx dispatches SET_REFERENCE_SUBVIEW (only referenceSubview changes; bottomPanelTab stays "reference"). Because referenceSubview isn't a dependency, the persist effect doesn't re-run, so localStorage still has referenceSubview:"problems". User quits without touching any tracked dependency. On next launch, the app restores the stale "problems" subview instead of "help".

**Evidence:**

````
const snapshot: PersistedSession = { tabs, activeTabId: ..., bottomPanelTab: state.bottomPanelTab, referenceSubview: state.referenceSubview, workingDir: state.workingDir, ... };
}, [
  state.tabs,
  state.activeTabId,
  state.bottomPanelTab,
  state.workingDir,
  state.selectedPsPath,
  state.breakpoints,
  state.bookmarks,
]); // referenceSubview omitted
````

**Suggested fix:** Add state.referenceSubview to the effect's dependency array.

### S3-31 — recoverScratchFiles silently drops candidates it fails to read, closing the dialog with no error and no tab added

**Severity:** LOW · **Where:** `src/App.tsx:1889`

When the user confirms "Recover selected" in ScratchRecoveryDialog, recoverScratchFiles reads each candidate file and on failure just skips it with a comment — no notice is surfaced anywhere, and the dialog still closes via setScratchRecoveryCandidates(null) at the end of the loop. This is the same "silently swallowed failure" pattern the codebase fixed elsewhere (AUDIT-FIXES #25/L9 via writeTerminalNotice), but was missed for this call site.

**Failure scenario:** A scratch file listed as a recovery candidate is deleted or becomes unreadable between the recovery dialog populating and the user clicking "Recover selected" (cleaned up externally, or the scratch dir touched by another running instance). cmd.readFileContent(candidate.path) throws, the candidate is skipped, and the dialog closes. From the user's point of view they selected a script, clicked the primary confirm button, and nothing happened — no tab appears, no error message.

**Evidence:**

````
for (const candidate of selected) {
  const existing = state.tabs.find((t) => t.id === candidate.tabId);
  if (existing) { dispatch({ type: "SET_ACTIVE_TAB", id: existing.id }); continue; }
  try {
    const file = await cmd.readFileContent(candidate.path);
    ...
    dispatch({ type: "ADD_TAB", tab });
  } catch {
    // skip unreadable scratch files
  }
}
setScratchRecoveryCandidates(null);
````

**Suggested fix:** On catch, call writeTerminalNotice (already used throughout App.tsx for this pattern) naming the file that couldn't be recovered instead of silently dropping it.

### S3-32 — About dialog has no focus trap or initial focus, so keyboard input can leak to the editor/toolbar behind the translucent backdrop

**Severity:** LOW · **Where:** `src/components/AboutDialog.tsx:17`

Unlike ScriptSigningDialog, ParamPromptDialog, and SettingsPanel (wired to useFocusTrap per AUDIT-FIXES L1), AboutDialog never imports or calls useFocusTrap and never moves focus into the dialog on open. The backdrop is only rgba(0,0,0,0.55) (translucent, not opaque), so background elements stay visible, and since nothing moved DOM focus, whatever previously had focus (a toolbar button, or the Monaco editor) keeps it. There is no readOnly/blur gating on the editor for state.showAbout anywhere. L1 explicitly did not cover AboutDialog.

**Failure scenario:** Open the About dialog while the Monaco editor still has focus (or focus returns to it via a subsequent Tab press, since Tab is never intercepted). Press Enter/Space/any character key expecting to interact with the visible "Close" button — instead the keystroke is delivered to the editor behind the dialog, inserting a newline/character into the open script, with the About dialog still appearing modally on top.

**Evidence:**

````
AboutDialog.tsx imports: `import React, { useEffect, useState } from "react";` — no useFocusTrap import anywhere in the file, no ref/focus-on-mount logic. Grep confirms useFocusTrap is used only in ScriptSigningDialog, ParamPromptDialog, and SettingsPanel.tsx, not AboutDialog.tsx.
````

**Suggested fix:** Wire AboutDialog's dialog card through the same useFocusTrap hook already used by the other three modals, with a ref on the card div.

**Verifier corrections/notes:**
- Same file/line is fine (AboutDialog.tsx component, lines 12 and 50-64 for the missing import and missing focus-trap wiring). Severity should be LOW, not MEDIUM, per this repo's own precedent: AUDIT-FIXES.md item L1 classified the identical 'modal missing useFocusTrap' defect as LOW when fixing it for ScriptSigningDialog/ParamPromptDialog/SettingsPanel. AboutDialog is purely informational (no inputs, no destructive action), so the worst realistic consequence is an accidental keystroke landing in the editor while the dialog is open — undoable, not data-destructive, and requires an explicit subsequent save to persist. Additionally, the failure_scenario's premise that the editor 'still has focus' when the dialog opens is inaccurate — TOGGLE_ABOUT fires only from a native toolbar <button> click, which claims DOM focus itself; the real leak path is Tab-cycling away from that button afterward (which the report does also mention as an alternative).

---

## Phase 2 — Regression bug sweep (after all fixes land)

Adversarial review of the complete diff before release:

1. `git diff <pre-sweep-base>..HEAD` — review the full diff through independent
   lenses: correctness, IPC/contract conformance (commands.ts ↔ commands.rs ↔
   settings.rs), edge cases & failure modes, security (path handling, quoting,
   registry), and Windows specifics (paths, encodings, PS 5.1 vs 7).
2. Re-run the historically productive checks on the diff:
   - Parse every embedded PowerShell script string you touched with
     `[System.Management.Automation.Language.Parser]::ParseInput` via
     `pwsh -NoProfile` (simulate Rust `format!` substitutions — watch `{{ }}` escapes).
     This repo has shipped three embedded-PS syntax bugs; do not skip this.
   - Settings defaults parity: every field in `src/types.ts` DEFAULT_SETTINGS must have
     a matching field + identical default in `src-tauri/src/settings.rs` (S3-2 is the
     third instance of this class — consider a Rust test that round-trips an empty JSON
     `{}` and asserts the serialized defaults match a checked-in snapshot of the
     frontend defaults).
   - Stale-closure scan of every App.tsx / component effect the diff touches: check
     each effect's dependency array against every value it reads.
3. Try to refute each new finding before acting on it; fix the confirmed ones, list the
   rejected ones with reasons in AUDIT-FIXES.md.
4. Gate (all must pass locally, then in CI):
   - `npm test` and `npm run build`
   - `PATH="/c/Users/Swatto/.cargo/bin:$PATH" rustup run stable cargo fmt --all -- --check`
   - `... cargo clippy --all-targets -- -D warnings`
   - `... cargo test` (all from `src-tauri/`)
   - Push to `main`; confirm GitHub CI green on **both** the ubuntu and windows legs.

## Phase 3 — Release v1.3.1

The green CI gate is the only pre-release bar — no manual/live test gate.

1. Bump `1.3.0` → `1.3.1` in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml` (this repo does not bump `package-lock.json`'s version field).
2. Sync the lockfile (from `src-tauri/`):
   `PATH="/c/Users/Swatto/.cargo/bin:$PATH" rustup run stable cargo update -p psforge --precise 1.3.1`
3. Commit `chore: bump version to 1.3.1` (include the AUDIT-FIXES.md / AI_CONTEXT.md
   updates here if not already committed), push to `main`, wait for CI green.
4. Tag the bump commit and push the tag: `git tag v1.3.1 && git push origin v1.3.1`.
   `release.yml` verifies tag == all three manifest versions, builds
   macOS/Linux/Windows, uploads installers + updater artifacts, and auto-publishes.
5. Verify with `gh release view v1.3.1`: release is published (not draft) and assets
   include the Windows installer, `latest.json`, and `.sig` files. If S3-5's fix
   changed how `latest.json` is assembled, download it and confirm it contains
   platform entries for **all three** OSes.
6. Tags are cumulative in this repo — do not delete prior releases.

## Reporting

When done, report per finding: fixed / won't-fix (reason), and the verification level
honestly — "compile-verified" (fmt + clippy + tests + build green) vs "live-run
verified" (exercised in the running app). Do not imply the latter from the former.
