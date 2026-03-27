/**
 * ParamPromptDialog — modal that collects values for mandatory PowerShell
 * script parameters before a run.
 *
 * PSForge detects mandatory parameters (those carrying `[Parameter(Mandatory)]`
 * without a default value) via the Rust `get_script_parameters` command before
 * executing a script.  If any are found this dialog is shown so the user can
 * supply values, avoiding the cryptic PowerShell "missing mandatory parameter"
 * error that would otherwise appear after the run starts.
 *
 * Input control type is chosen from the PS type name:
 *  - Boolean / Bool / SwitchParameter -> checkbox (always has a value)
 *  - Int32 / Int64 / Double / … (numeric) -> number input
 *  - SecureString -> password input (masked)
 *  - Everything else -> text input
 *
 * The Run button is disabled when any non-boolean field is empty, or when a
 * numeric field contains a non-numeric value.
 *
 * Keyboard: Enter submits (when valid), Escape cancels.
 * The dialog is theme-aware via CSS variables.
 */

import React, { useEffect, useRef, useState } from "react";
import type { ScriptParameter } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  /** The mandatory parameters that need values. */
  params: ScriptParameter[];
  /** Called with a map of paramName -> stringified value when the user clicks Run. */
  onConfirm: (values: Record<string, string>) => void;
  /** Called when the user cancels (closes dialog or presses Escape). */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set of PowerShell numeric type names (lower-cased for comparison). */
const NUMERIC_TYPES = new Set([
  "int",
  "int16",
  "int32",
  "int64",
  "uint16",
  "uint32",
  "uint64",
  "long",
  "short",
  "byte",
  "sbyte",
  "double",
  "single",
  "float",
  "decimal",
  "system.int32",
  "system.int64",
  "system.double",
  "system.decimal",
  "system.single",
]);

/** Set of PowerShell boolean/switch type names (lower-cased). */
const BOOL_TYPES = new Set([
  "bool",
  "boolean",
  "switchparameter",
  "system.boolean",
  "system.management.automation.switchparameter",
]);

function isBoolType(typeName: string): boolean {
  return BOOL_TYPES.has(typeName.toLowerCase());
}

function isNumericType(typeName: string): boolean {
  return NUMERIC_TYPES.has(typeName.toLowerCase());
}

function isSecureString(typeName: string): boolean {
  return (
    typeName.toLowerCase() === "securestring" ||
    typeName.toLowerCase() === "system.security.securestring"
  );
}

/** Short, user-friendly type label for the hint under each field. */
function typeLabel(typeName: string): string {
  const lower = typeName.toLowerCase();
  if (BOOL_TYPES.has(lower)) return "Boolean";
  if (lower === "securestring" || lower === "system.security.securestring")
    return "SecureString";
  if (NUMERIC_TYPES.has(lower)) {
    // Use the short name for display
    const short = typeName.split(".").pop() ?? typeName;
    return short.charAt(0).toUpperCase() + short.slice(1);
  }
  // Strip System. prefix for cleaner display
  return (
    (typeName.startsWith("System.") ? typeName.slice(7) : typeName) || "String"
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ParamPromptDialog({ params, onConfirm, onCancel }: Props) {
  // Initialise form values:
  //  - booleans start as false (empty checkbox)
  //  - everything else starts as an empty string
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of params) {
      init[p.name] = isBoolType(p.typeName) ? "false" : "";
    }
    return init;
  });

  const firstInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the first non-boolean field (or the first field if all boolean) on mount.
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  // Escape key cancels.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /** Returns null when valid, or an error string when invalid. */
  function validateField(param: ScriptParameter, value: string): string | null {
    if (isBoolType(param.typeName)) return null; // checkboxes always valid
    if (value.trim() === "") return "Required";
    if (
      isNumericType(param.typeName) &&
      !/^-?\d+(\.\d+)?$/.test(value.trim())
    ) {
      return "Must be a number";
    }
    return null;
  }

  const errors: Record<string, string | null> = {};
  for (const p of params) {
    errors[p.name] = validateField(p, values[p.name] ?? "");
  }
  const canRun = Object.values(errors).every((e) => e === null);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleChange(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleBoolChange(name: string, checked: boolean) {
    setValues((prev) => ({ ...prev, [name]: checked ? "true" : "false" }));
  }

  function handleConfirm() {
    if (!canRun) return;
    onConfirm(values);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && canRun) {
      e.preventDefault();
      handleConfirm();
    }
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onCancel();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  let firstInputAssigned = false;

  return (
    <div
      data-testid="param-prompt-backdrop"
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        data-testid="param-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="param-prompt-title"
        onKeyDown={handleKeyDown}
        style={{
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-primary)",
          borderRadius: "6px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.48)",
          width: "420px",
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--border-primary)",
          }}
        >
          <div
            id="param-prompt-title"
            data-testid="param-prompt-title"
            style={{
              fontSize: "var(--ui-font-size-lg)",
              fontWeight: "600",
              color: "var(--text-primary)",
              marginBottom: "4px",
            }}
          >
            Script Parameters Required
          </div>
          <div style={{ fontSize: "var(--ui-font-size-sm)", color: "var(--text-muted)" }}>
            Enter values for the mandatory parameters below.
          </div>
        </div>

        {/* Scrollable parameter fields */}
        <div
          style={{
            overflowY: "auto",
            padding: "12px 20px",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {params.map((param) => {
            const value = values[param.name] ?? "";
            const error = errors[param.name];
            const isBool = isBoolType(param.typeName);
            const isNum = isNumericType(param.typeName);
            const isSecret = isSecureString(param.typeName);

            // Assign the firstInputRef to the first focusable field.
            let refProp: React.RefObject<HTMLInputElement | null> | undefined;
            if (!firstInputAssigned) {
              refProp = firstInputRef;
              firstInputAssigned = true;
            }

            const inputStyle: React.CSSProperties = {
              width: "100%",
              padding: "6px 8px",
              backgroundColor: "var(--bg-input, var(--bg-secondary))",
              color: "var(--text-primary)",
              border: `1px solid ${error ? "var(--error, #f44)" : "var(--border-primary)"}`,
              borderRadius: "4px",
              fontSize: "var(--ui-font-size-md)",
              fontFamily: "inherit",
              outline: "none",
              boxSizing: "border-box",
            };

            return (
              <div key={param.name} data-testid={`param-field-${param.name}`}>
                {/* Label row */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: "6px",
                    marginBottom: "4px",
                  }}
                >
                  <label
                    htmlFor={`param-input-${param.name}`}
                    style={{
                      fontWeight: "600",
                      fontSize: "var(--ui-font-size-md)",
                      color: "var(--text-primary)",
                      fontFamily: "Cascadia Code, Consolas, monospace",
                    }}
                  >
                    ${param.name}
                  </label>
                  <span
                    style={{
                      fontSize: "var(--ui-font-size-xs)",
                      color: "var(--accent)",
                      opacity: 0.75,
                    }}
                  >
                    [{typeLabel(param.typeName)}]
                  </span>
                </div>

                {/* Help message */}
                {param.helpMessage && (
                  <div
                    style={{
                      fontSize: "var(--ui-font-size-xs)",
                      color: "var(--text-muted)",
                      marginBottom: "4px",
                    }}
                  >
                    {param.helpMessage}
                  </div>
                )}

                {/* Input control */}
                {isBool ? (
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      id={`param-input-${param.name}`}
                      data-testid={`param-input-${param.name}`}
                      type="checkbox"
                      checked={value === "true"}
                      onChange={(e) =>
                        handleBoolChange(param.name, e.target.checked)
                      }
                      ref={
                        refProp as React.RefObject<HTMLInputElement> | undefined
                      }
                      style={{
                        accentColor: "var(--accent)",
                        width: "15px",
                        height: "15px",
                      }}
                    />
                    <span
                      style={{
                        fontSize: "var(--ui-font-size-md)",
                        color: "var(--text-secondary, var(--text-muted))",
                      }}
                    >
                      {value === "true" ? "$true" : "$false"}
                    </span>
                  </label>
                ) : (
                  <input
                    id={`param-input-${param.name}`}
                    data-testid={`param-input-${param.name}`}
                    type={isSecret ? "password" : isNum ? "text" : "text"}
                    inputMode={isNum ? "decimal" : undefined}
                    value={value}
                    onChange={(e) => handleChange(param.name, e.target.value)}
                    placeholder={
                      isNum
                        ? "Enter a number"
                        : isSecret
                          ? "Enter a secure value"
                          : "Enter a value"
                    }
                    ref={
                      refProp as React.RefObject<HTMLInputElement> | undefined
                    }
                    style={inputStyle}
                    onFocus={(e) =>
                      (e.currentTarget.style.borderColor = error
                        ? "var(--error, #f44)"
                        : "var(--accent)")
                    }
                    onBlur={(e) =>
                      (e.currentTarget.style.borderColor = error
                        ? "var(--error, #f44)"
                        : "var(--border-primary)")
                    }
                  />
                )}

                {/* Inline validation error */}
                {error && (
                  <div
                    style={{
                      fontSize: "var(--ui-font-size-xs)",
                      color: "var(--error, #f44)",
                      marginTop: "3px",
                    }}
                  >
                    {error}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer: Cancel / Run */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "12px 20px",
            borderTop: "1px solid var(--border-primary)",
          }}
        >
          <button
            data-testid="param-prompt-cancel"
            onClick={onCancel}
            style={{
              padding: "6px 16px",
              borderRadius: "4px",
              border: "1px solid var(--border-primary)",
              backgroundColor: "transparent",
              color: "var(--text-primary)",
              cursor: "pointer",
              fontSize: "var(--ui-font-size-md)",
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLElement).style.backgroundColor =
                "var(--bg-hover)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLElement).style.backgroundColor =
                "transparent")
            }
          >
            Cancel
          </button>
          <button
            data-testid="param-prompt-run"
            onClick={handleConfirm}
            disabled={!canRun}
            style={{
              padding: "6px 20px",
              borderRadius: "4px",
              border: "none",
              backgroundColor: canRun
                ? "var(--accent)"
                : "var(--bg-tertiary, var(--bg-secondary))",
              color: canRun ? "#fff" : "var(--text-muted)",
              cursor: canRun ? "pointer" : "not-allowed",
              fontSize: "var(--ui-font-size-md)",
              fontWeight: "600",
              opacity: canRun ? 1 : 0.5,
            }}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

