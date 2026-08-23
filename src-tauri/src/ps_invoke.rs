//! Shared PowerShell fragments for binding script arguments from PSForge's
//! frontend ParamPromptDialog tokens into a script's param() block.
//!
//! Both the persistent execution host (`powershell.rs`) and the integrated
//! terminal psrun wrapper (`commands.rs::prepare_terminal_script_command`)
//! must share this logic so named/colon/switch/SecureString tokens bind the
//! same way. Splatting a string array to `pwsh -File` does not reliably bind
//! named parameters (and treats `-Switch:$false` as positional argv tokens).

/// Converts frontend argument tokens (including SecureString sentinels) into
/// values the PowerShell parameter binder accepts.
pub(crate) const PSFORGE_COERCE_ARG_VALUE_FN: &str = r#"
function __psforge_coerce_arg_value {
    param([object]$Raw)
    if ($null -eq $Raw) { return $null }
    $__psforge_text = [string]$Raw
    if ($__psforge_text -match '^(?i)\$?true$') { return $true }
    if ($__psforge_text -match '^(?i)\$?false$') { return $false }
    if ($__psforge_text.StartsWith('__psforge_securestring__')) {
        # SecureString sentinel emitted by the frontend ParamPromptDialog so
        # plain-text values typed into the dialog can satisfy a script
        # parameter declared as [SecureString]. Without this conversion, the
        # parameter binder would reject the string with a "Cannot convert"
        # error and the script would never start. The base64 encoding keeps
        # the value safe across the colon-tokenizer and shell metacharacters.
        $__psforge_b64 = $__psforge_text.Substring('__psforge_securestring__'.Length)
        try {
            $__psforge_bytes = [Convert]::FromBase64String($__psforge_b64)
            $__psforge_plain = [System.Text.Encoding]::UTF8.GetString($__psforge_bytes)
            # ConvertTo-SecureString -AsPlainText is PowerShell 6+ only.
            # Use NetworkCredential on Windows PowerShell 5.1 so mandatory
            # [SecureString] params still bind after Paste + Run / F5.
            if ($PSVersionTable.PSVersion.Major -ge 6) {
                return (ConvertTo-SecureString -String $__psforge_plain -AsPlainText -Force)
            }
            return (New-Object System.Net.NetworkCredential('', $__psforge_plain)).SecurePassword
        } catch {
            # Malformed sentinel: fall through to the original token rather
            # than blocking the run. The script will then receive the
            # tagged string and surface its own binding error to the user.
        }
    }
    return $Raw
}
"#;

/// Emits the variable-inspector JSON marker after a persistent-host run.
pub(crate) const PSFORGE_EMIT_VARIABLES_FN: &str = r#"
function __psforge_emit_variables {
    try {
        $__psforge_value_max = 4096
        $__psforge_vars = @(
            Get-Variable |
            Where-Object {
                $_.Name -notmatch '^(\?|args|input|MyInvocation|PSBoundParameters|PSCommandPath|PSScriptRoot|utf8NoBom|psfHwnd)$' -and
                $_.Name -notlike '__psforge*'
            } |
            ForEach-Object {
                # Truncate large values so a single $bigArray cannot blow up the
                # variable inspector pipe and stall the host. The frontend tab
                # is interactive, not a data dump, so 4 KiB is plenty.
                $__psforge_raw = if ($_.Value -ne $null) {
                    try { $_.Value.ToString() } catch { '<unprintable>' }
                } else { '<null>' }
                if ($__psforge_raw.Length -gt $__psforge_value_max) {
                    $__psforge_raw = $__psforge_raw.Substring(0, $__psforge_value_max) + "... (truncated, $($__psforge_raw.Length - $__psforge_value_max) more chars)"
                }
                [PSCustomObject]@{
                    Name = $_.Name
                    Value = $__psforge_raw
                    TypeName = if ($_.Value -ne $null) { $_.Value.GetType().Name } else { 'Null' }
                }
            }
        )
        $__psforge_json = if ($__psforge_vars.Count -eq 0) {
            '[]'
        } else {
            ConvertTo-Json -Compress -InputObject $__psforge_vars
        }
        [Console]::Out.WriteLine('<<PSFORGE_VARIABLES_JSON>>' + $__psforge_json)
    } catch {
        [Console]::Out.WriteLine('<<PSFORGE_VARIABLES_JSON>>[]')
    } finally {
        [Console]::Out.Flush()
    }
}
"#;

/// Parses PSForge frontend tokens and dot-sources the staged user script path.
pub(crate) const PSFORGE_INVOKE_USER_SCRIPT_FN: &str = r#"
function __psforge_invoke_user_script {
    param([object[]]$__psforge_input_args)

    $__psforge_named = @{}
    $__psforge_positional = [System.Collections.Generic.List[object]]::new()
    $__psforge_i = 0
    while ($__psforge_i -lt $__psforge_input_args.Count) {
        $__psforge_token_obj = $__psforge_input_args[$__psforge_i]
        $__psforge_token = if ($null -eq $__psforge_token_obj) { '' } else { [string]$__psforge_token_obj }
        if ([string]::IsNullOrWhiteSpace($__psforge_token)) {
            $__psforge_i++
            continue
        }

        if ($__psforge_token.StartsWith('-')) {
            $__psforge_body = $__psforge_token.Substring(1)
            $__psforge_colon_idx = $__psforge_body.IndexOf(':')
            if ($__psforge_colon_idx -ge 0) {
                $__psforge_name = $__psforge_body.Substring(0, $__psforge_colon_idx).Trim()
                if ($__psforge_name.Length -gt 0) {
                    $__psforge_value_text = $__psforge_body.Substring($__psforge_colon_idx + 1)
                    $__psforge_named[$__psforge_name] = __psforge_coerce_arg_value $__psforge_value_text
                    $__psforge_i++
                    continue
                }
            } else {
                $__psforge_name = $__psforge_body.Trim()
                if ($__psforge_name.Length -gt 0) {
                    if (($__psforge_i + 1) -lt $__psforge_input_args.Count) {
                        # Always coerce so SecureString/bool tokens bind even
                        # when emitted in space form (-Name value) rather than
                        # colon form (-Name:value).
                        $__psforge_named[$__psforge_name] = __psforge_coerce_arg_value $__psforge_input_args[$__psforge_i + 1]
                        $__psforge_i += 2
                        continue
                    }
                    # Final bare switch token: treat as $true.
                    $__psforge_named[$__psforge_name] = $true
                    $__psforge_i++
                    continue
                }
            }
        }

        $__psforge_positional.Add($__psforge_token_obj)
        $__psforge_i++
    }

    . $__psforge_script_path @__psforge_named @__psforge_positional
}
"#;

/// Persistent-host wrapper: coerce/bind args, then emit variables after the run.
/// Built with format! (not concat!) so const &str fragments compile on stable.
pub(crate) fn persistent_host_invoke_block() -> String {
    format!(
        "{coerce}\n{emit}\n{invoke}\nfunction __psforge_invoke_user_script_with_emit {{\n    param([object[]]$__psforge_input_args)\n    try {{\n        __psforge_invoke_user_script @__psforge_input_args\n    }} finally {{\n        __psforge_emit_variables\n    }}\n}}\n",
        coerce = PSFORGE_COERCE_ARG_VALUE_FN,
        emit = PSFORGE_EMIT_VARIABLES_FN,
        invoke = PSFORGE_INVOKE_USER_SCRIPT_FN,
    )
}

/// Builds the child-process invoke script used by the integrated terminal psrun
/// wrapper. Arguments arrive via `$args` when the file is launched with
/// `pwsh -File invoke.ps1 @frontendTokens`.
pub(crate) fn build_terminal_invoke_wrapper(user_script_path_ps: &str) -> String {
    format!(
        "$__psforge_script_path = '{user_script_path_ps}'\n{PSFORGE_COERCE_ARG_VALUE_FN}\n{PSFORGE_INVOKE_USER_SCRIPT_FN}\n__psforge_invoke_user_script @args\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_invoke_wrapper_includes_shared_binders() {
        let script = build_terminal_invoke_wrapper("C:\\temp\\run.ps1");
        assert!(script.contains("__psforge_coerce_arg_value"));
        assert!(script.contains("__psforge_invoke_user_script"));
        assert!(script.contains("__psforge_invoke_user_script @args"));
        assert!(script.contains("$__psforge_script_path = 'C:\\temp\\run.ps1'"));
        assert!(
            script.contains("NetworkCredential"),
            "PS 5.1 SecureString path must be present"
        );
        assert!(
            script.contains("__psforge_coerce_arg_value $__psforge_input_args[$__psforge_i + 1]"),
            "space-form tokens must be coerced"
        );
    }

    #[test]
    fn persistent_host_block_includes_emit_wrapper() {
        let block = persistent_host_invoke_block();
        assert!(block.contains("__psforge_invoke_user_script_with_emit"));
        assert!(block.contains("__psforge_emit_variables"));
        assert!(block.contains("NetworkCredential"));
    }
}
