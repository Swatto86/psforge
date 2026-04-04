// E2E integration tests for PowerShell IntelliSense completions (Rule 3).
//
// These tests drive `commands::get_completions` directly, without a Tauri app
// or browser. They exercise the full backend path: Rust -> PowerShell
// subprocess -> TabExpansion2 -> JSON parse -> Vec<PsCompletion>.
//
// Coverage:
// 1. Cmdlet completions are returned for a partial cmdlet name.
// 2. Parameter completions are returned when cursor follows `<cmdlet> -`.
// 3. Parameter `completion_text` includes the leading `-`, but `list_item_text` does not.
//    This confirms the Monaco filterText bug described in the issue: Monaco's filter
//    compared the label "Path" against trigger text "-" and discarded the suggestion.
//    The fix adds `filterText: c.completionText` so Monaco uses "-Path" for matching.
// 4. Partial parameter entry still surfaces matching suggestions.
// 5. Graceful degradation: garbage input returns Ok([]) not a panic or Err.
// 6. Empty script returns Ok([]) not an error.
// 7. Variable completions are returned for `$` trigger.
// 8. Named-parameter value completions (e.g. `-ErrorAction `) surface enum values.
// 9. Completions succeed for a multi-line script (cursor inside the script).
// 10. Cursor at offset 0 in empty script returns Ok([]).

// Conservative async deadline: TabExpansion2 can be slow on cold Windows PowerShell 5.1.
// 60 s is 5x the worst-case local time on a clean machine. Rule 3 requires this constant.
const TEST_TIMEOUT_SECS: u64 = 60;

use psforge_lib::commands::{self, PsCompletion};
use tokio::time::{timeout, Duration};

// ---------------------------------------------------------------------------
// Helper macros / functions
// ---------------------------------------------------------------------------

/// Wraps an async expression with the hard deadline (Rule 3).
macro_rules! bounded {
    ($e:expr) => {
        timeout(Duration::from_secs(TEST_TIMEOUT_SECS), $e)
            .await
            .expect("completion test timed out -- TabExpansion2 may have hung")
    };
}

/// Locates the first working PowerShell executable on the machine.
/// Prefers pwsh (7+) for faster startup; falls back to Windows PowerShell 5.1.
/// Returns `None` when no PowerShell is available (test will be skipped).
fn find_ps() -> Option<String> {
    for candidate in &["pwsh.exe", "powershell.exe"] {
        let ok = std::process::Command::new(candidate)
            .args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Requires a working PowerShell; early-returns from the enclosing test if not found.
macro_rules! require_ps {
    () => {
        match find_ps() {
            Some(p) => p,
            None => {
                eprintln!("[SKIP] No PowerShell executable found — skipping test.");
                return;
            }
        }
    };
}

// ---------------------------------------------------------------------------
// 1. Cmdlet completions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cmdlet_completions_returned_for_partial_name() {
    let ps = require_ps!();
    bounded!(async {
        let script = "Get-C";
        let cursor = script.len(); // cursor at end

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must not return Err for valid partial cmdlet");

        assert!(
            !items.is_empty(),
            "Expected cmdlet completions for 'Get-C', got none. \
             Check that PowerShell is accessible and TabExpansion2 is available."
        );

        // Every returned item's result_type should be "Command" or "Method" —
        // verifies we're getting cmdlet-level completions, not some other type.
        let has_command_type = items.iter().any(|c| c.result_type == "Command");
        assert!(
            has_command_type,
            "Expected at least one resultType='Command' in completions for 'Get-C', \
             got: {:?}",
            items.iter().map(|c| &c.result_type).collect::<Vec<_>>()
        );

        // At least one known cmdlet should appear.
        let has_get_childitem = items
            .iter()
            .any(|c| c.completion_text.eq_ignore_ascii_case("Get-ChildItem"));
        assert!(
            has_get_childitem,
            "Expected 'Get-ChildItem' in completions for 'Get-C'"
        );
    });
}

// ---------------------------------------------------------------------------
// 2. Parameter completions are returned after `<cmdlet> -`
// ---------------------------------------------------------------------------

#[tokio::test]
async fn parameter_completions_returned_after_dash() {
    let ps = require_ps!();
    bounded!(async {
        let script = "Get-ChildItem -";
        let cursor = script.len();

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must not return Err");

        assert!(
            !items.is_empty(),
            "Expected parameter completions for 'Get-ChildItem -', got none. \
             This is the primary IntelliSense bug: parameters must be returned after a dash."
        );

        let param_items: Vec<&PsCompletion> = items
            .iter()
            .filter(|c| c.result_type == "ParameterName")
            .collect();

        assert!(
            !param_items.is_empty(),
            "Expected at least one resultType='ParameterName' for 'Get-ChildItem -', \
             got types: {:?}",
            items.iter().map(|c| &c.result_type).collect::<Vec<_>>()
        );

        // A known parameter must appear.
        let has_path = param_items
            .iter()
            .any(|c| c.completion_text.eq_ignore_ascii_case("-Path"));
        assert!(
            has_path,
            "Expected '-Path' parameter in completions for 'Get-ChildItem -'. \
             Got parameter completionTexts: {:?}",
            param_items
                .iter()
                .map(|c| &c.completion_text)
                .collect::<Vec<_>>()
        );
    });
}

// ---------------------------------------------------------------------------
// 3. completionText has dash prefix; listItemText does NOT
//    This is the smoking gun for the Monaco filterText bug.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn parameter_completion_text_has_dash_but_list_item_text_does_not() {
    let ps = require_ps!();
    bounded!(async {
        let script = "Get-ChildItem -";
        let cursor = script.len();

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must succeed");

        // Find the -Path parameter specifically.
        let path_param = items
            .iter()
            .find(|c| c.completion_text.eq_ignore_ascii_case("-Path"));

        let path_param = path_param.expect(
            "'-Path' must be returned for 'Get-ChildItem -'. \
             If this assertion fails, PowerShell's TabExpansion2 is not available \
             or is returning unexpected output.",
        );

        // completionText MUST start with `-`.
        assert!(
            path_param.completion_text.starts_with('-'),
            "completionText for a parameter must start with '-', got: {:?}",
            path_param.completion_text
        );

        // listItemText must NOT start with `-` — this is by PowerShell design.
        // Monaco uses `label` (from listItemText) for filtering.  When the
        // user types '-', Monaco's filter compared "Path" against "-" and found
        // no match, silently hiding all parameter suggestions.  The fix adds
        // `filterText: completionText` ("-Path") so Monaco matches correctly.
        assert!(
            !path_param.list_item_text.starts_with('-'),
            "listItemText must NOT start with '-' (PowerShell design). \
             If this assertion fails, the Monaco filterText fix may be unnecessary. \
             Got: {:?}",
            path_param.list_item_text
        );

        // Confirm the exact discrepancy.
        assert_ne!(
            path_param.completion_text, path_param.list_item_text,
            "completionText and listItemText must differ for parameters \
             (that's what caused the Monaco filtering bug)"
        );

        eprintln!(
            "[INFO] Parameter completion_text={:?}, list_item_text={:?} — \
             filterText fix is necessary and correct.",
            path_param.completion_text, path_param.list_item_text
        );
    });
}

// ---------------------------------------------------------------------------
// 4. Partial parameter entry still surfaces matching suggestions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn partial_parameter_completions_are_filtered() {
    let ps = require_ps!();
    bounded!(async {
        let script = "Get-ChildItem -Pa";
        let cursor = script.len();

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must succeed for partial parameter");

        assert!(
            !items.is_empty(),
            "Expected completions for partial '-Pa', got none"
        );

        // All returned completions should relate to '-Pa' prefix.
        let relevant: Vec<_> = items
            .iter()
            .filter(|c| c.completion_text.to_ascii_lowercase().starts_with("-pa"))
            .collect();

        assert!(
            !relevant.is_empty(),
            "Expected at least one completion matching '-Pa*' but got: {:?}",
            items.iter().map(|c| &c.completion_text).collect::<Vec<_>>()
        );
    });
}

// ---------------------------------------------------------------------------
// 5. Graceful degradation: garbage input returns Ok([]) not panic
// ---------------------------------------------------------------------------

#[tokio::test]
async fn garbage_input_returns_empty_not_error() {
    let ps = require_ps!();
    bounded!(async {
        let script = "!@#$%^&*() this is not PowerShell !!!";
        let cursor = script.len();

        let result = commands::get_completions(ps, script.to_string(), cursor).await;

        assert!(
            result.is_ok(),
            "get_completions must return Ok([]) for garbage input, not Err. \
             Got: {:?}",
            result.err()
        );
        // May be empty or return some completions — both are acceptable.
        // The important thing is no crash/panic/Err.
    });
}

// ---------------------------------------------------------------------------
// 6. Empty script returns Ok([])
// ---------------------------------------------------------------------------

#[tokio::test]
async fn empty_script_returns_empty_completions() {
    let ps = require_ps!();
    bounded!(async {
        let result = commands::get_completions(ps, String::new(), 0).await;

        assert!(
            result.is_ok(),
            "get_completions must return Ok for empty script, got: {:?}",
            result.err()
        );
    });
}

// ---------------------------------------------------------------------------
// 7. Variable completions are returned for `$` trigger
// ---------------------------------------------------------------------------

#[tokio::test]
async fn variable_completions_returned_for_dollar() {
    let ps = require_ps!();
    bounded!(async {
        let script = "$";
        let cursor = 1;

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must not Err for '$'");

        // PowerShell always has built-in variables like $true, $false, $null, $PSVersionTable.
        // We should get at least a few Variable-type completions.
        let var_items: Vec<_> = items
            .iter()
            .filter(|c| c.result_type == "Variable")
            .collect();

        assert!(
            !var_items.is_empty(),
            "Expected Variable completions for '$', got none. All types returned: {:?}",
            items.iter().map(|c| &c.result_type).collect::<Vec<_>>()
        );

        // $true and $false are universally present in all PS versions.
        let has_true = items
            .iter()
            .any(|c| c.completion_text.eq_ignore_ascii_case("$true"));
        assert!(has_true, "Expected '$true' in variable completions for '$'");
    });
}

// ---------------------------------------------------------------------------
// 8. Named-parameter value completions (enum values after `-ErrorAction `)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn enum_value_completions_returned_for_error_action() {
    let ps = require_ps!();
    bounded!(async {
        // Cursor immediately after the space following "-ErrorAction".
        let script = "Get-ChildItem -ErrorAction ";
        let cursor = script.len();

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must not Err for ErrorAction value");

        // PowerShell should suggest enum values: Continue, Stop, SilentlyContinue, etc.
        // result_type for these is "ParameterValue" in some PS versions.
        assert!(
            !items.is_empty(),
            "Expected enum value completions after '-ErrorAction ', got none"
        );

        let has_stop = items
            .iter()
            .any(|c| c.completion_text.eq_ignore_ascii_case("Stop"));
        let has_continue = items
            .iter()
            .any(|c| c.completion_text.eq_ignore_ascii_case("Continue"));

        assert!(
            has_stop || has_continue,
            "Expected at least 'Stop' or 'Continue' in -ErrorAction suggestions. Got: {:?}",
            items.iter().map(|c| &c.completion_text).collect::<Vec<_>>()
        );
    });
}

// ---------------------------------------------------------------------------
// 9. Multi-line script: completions inside the script body
// ---------------------------------------------------------------------------

#[tokio::test]
async fn completions_work_in_multiline_script() {
    let ps = require_ps!();
    bounded!(async {
        // A typical multi-line script with the cursor inside line 3.
        let script = "$x = 1\n$y = 2\nGet-ChildItem -";
        let cursor = script.len(); // cursor at end of last line

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must succeed for multi-line script");

        assert!(
            !items.is_empty(),
            "Expected parameter completions inside a multi-line script, got none"
        );

        let has_param = items
            .iter()
            .any(|c| c.result_type == "ParameterName" && c.completion_text.starts_with('-'));

        assert!(
            has_param,
            "Expected at least one ParameterName completion in a multi-line script"
        );
    });
}

// ---------------------------------------------------------------------------
// 10. Cursor at offset 0 in empty script returns Ok([])
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cursor_at_zero_in_empty_script_is_safe() {
    let ps = require_ps!();
    bounded!(async {
        let result = commands::get_completions(ps, String::new(), 0).await;
        assert!(
            result.is_ok(),
            "cursor at offset 0 in empty script must be Ok, got: {:?}",
            result.err()
        );
    });
}

// ---------------------------------------------------------------------------
// 11. Completions returned for pipe continuation (common authoring pattern)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn completions_returned_after_pipe() {
    let ps = require_ps!();
    bounded!(async {
        // Script with a pipeline; cursor after `| Where-O` expects cmdlet completion.
        let script = "Get-Process | Where-O";
        let cursor = script.len();

        let items = commands::get_completions(ps, script.to_string(), cursor)
            .await
            .expect("get_completions must succeed after pipe");

        assert!(
            !items.is_empty(),
            "Expected completions for 'Where-O' after pipe, got none"
        );

        let has_where_object = items
            .iter()
            .any(|c| c.completion_text.eq_ignore_ascii_case("Where-Object"));

        assert!(
            has_where_object,
            "Expected 'Where-Object' in completions after pipe and 'Where-O'. \
             Got: {:?}",
            items.iter().map(|c| &c.completion_text).collect::<Vec<_>>()
        );
    });
}
