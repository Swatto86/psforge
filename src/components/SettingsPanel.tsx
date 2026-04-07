/** PSForge Settings Panel.
 *  Modal overlay with six sections covering all ISE-parity configurables:
 *  Editor, IntelliSense, Execution, Output, Appearance, File Associations.
 *
 *  All settings use real-time validation (Rule 16).
 *  Execution policy is applied via the Rust backend for the CurrentUser scope
 *  (no administrator rights required).
 */

import React, { useState, useEffect } from "react";
import { useAppState } from "../store";
import * as cmd from "../commands";
import type { AssociationStatus, ThemeName } from "../types";
import { PS_EXTENSIONS } from "../types";

/** Section identifiers. */
type Section =
  | "editor"
  | "intellisense"
  | "execution"
  | "output"
  | "appearance"
  | "associations";

/** All panel sections with display labels. */
const SECTIONS: { id: Section; label: string }[] = [
  { id: "editor", label: "Editor" },
  { id: "intellisense", label: "IntelliSense" },
  { id: "execution", label: "Execution" },
  { id: "output", label: "Output" },
  { id: "appearance", label: "Appearance" },
  { id: "associations", label: "File Associations" },
];

/** Valid execution policy values (must mirror the Rust ALLOWED_POLICIES constant). */
const EXECUTION_POLICIES = [
  "Default",
  "Restricted",
  "AllSigned",
  "RemoteSigned",
  "Unrestricted",
  "Bypass",
] as const;

/** Descriptions shown next to each policy option. */
const POLICY_DESCRIPTIONS: Record<string, string> = {
  Default: "No override -- use whatever is already set",
  Restricted: "No scripts allowed (most restrictive)",
  AllSigned: "Only scripts signed by a trusted publisher",
  RemoteSigned: "Downloaded scripts must be signed (recommended)",
  Unrestricted: "All scripts run with a warning for untrusted scripts",
  Bypass: "No restrictions or warnings (for automation -- use with caution)",
};

function isLikelyAbsoluteWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function SettingsPanel() {
  const { state, dispatch } = useAppState();
  const [activeSection, setActiveSection] = useState<Section>("editor");
  const [associations, setAssociations] = useState<AssociationStatus[]>([]);
  const [assocLoading, setAssocLoading] = useState(false);
  /** Busy flag for individual or batch file association operations (Rule 16). */
  const [assocBusy, setAssocBusy] = useState(false);
  const [execPolicyFeedback, setExecPolicyFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [applyingPolicy, setApplyingPolicy] = useState(false);

  // Load file association status when that section is shown.
  useEffect(() => {
    if (activeSection === "associations") {
      setAssocLoading(true);
      cmd
        .getFileAssociationStatus()
        .then(setAssociations)
        .catch(() => {})
        .finally(() => setAssocLoading(false));
    }
  }, [activeSection]);

  // Close the settings panel on Escape key (matches documented shortcut).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: "TOGGLE_SETTINGS" });
      }
    };
    // Capture phase so the handler fires before Monaco or other elements.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [dispatch]);

  // ---------------------------------------------------------------------------
  // Real-time validation (Rule 16 -- actionable inline errors)
  // ---------------------------------------------------------------------------
  const validationErrors: Record<string, string> = {};

  const fs = state.settings.fontSize;
  if (!Number.isFinite(fs) || fs < 8 || fs > 72) {
    validationErrors.fontSize = "Font size must be between 8 and 72.";
  }
  if (!state.settings.fontFamily || state.settings.fontFamily.trim() === "") {
    validationErrors.fontFamily = "Font family must not be empty.";
  }
  const ofs = state.settings.outputFontSize ?? 13;
  if (!Number.isFinite(ofs) || ofs < 8 || ofs > 72) {
    validationErrors.outputFontSize =
      "Output font size must be between 8 and 72.";
  }
  if (
    !state.settings.outputFontFamily ||
    state.settings.outputFontFamily.trim() === ""
  ) {
    validationErrors.outputFontFamily = "Output font family must not be empty.";
  }
  const uis = state.settings.uiFontSize ?? 13;
  if (!Number.isFinite(uis) || uis < 8 || uis > 24) {
    validationErrors.uiFontSize = "UI font size must be between 8 and 24.";
  }
  if (
    !state.settings.uiFontFamily ||
    state.settings.uiFontFamily.trim() === ""
  ) {
    validationErrors.uiFontFamily = "UI font family must not be empty.";
  }
  const sfs = state.settings.sidebarFontSize ?? 12;
  if (!Number.isFinite(sfs) || sfs < 8 || sfs > 24) {
    validationErrors.sidebarFontSize =
      "Sidebar font size must be between 8 and 24.";
  }
  if (
    !state.settings.sidebarFontFamily ||
    state.settings.sidebarFontFamily.trim() === ""
  ) {
    validationErrors.sidebarFontFamily =
      "Sidebar font family must not be empty.";
  }
  const tabSz = state.settings.tabSize ?? 4;
  if (!Number.isFinite(tabSz) || tabSz < 1 || tabSz > 16) {
    validationErrors.tabSize = "Tab size must be between 1 and 16.";
  }
  const maxRecent = state.settings.maxRecentFiles ?? 20;
  if (!Number.isFinite(maxRecent) || maxRecent < 1 || maxRecent > 50) {
    validationErrors.maxRecentFiles =
      "Max recent files must be between 1 and 50.";
  }
  if (
    state.settings.workingDirMode === "custom" &&
    (!state.settings.customWorkingDir ||
      state.settings.customWorkingDir.trim() === "")
  ) {
    validationErrors.customWorkingDir =
      "A working directory path is required when mode is Custom.";
  } else if (
    state.settings.workingDirMode === "custom" &&
    !isLikelyAbsoluteWindowsPath(state.settings.customWorkingDir.trim())
  ) {
    validationErrors.customWorkingDir =
      "Custom working directory must be an absolute path.";
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const updateSetting = <K extends keyof typeof state.settings>(
    key: K,
    value: (typeof state.settings)[K],
  ) => {
    dispatch({
      type: "SET_SETTINGS",
      settings: { ...state.settings, [key]: value },
    });
  };

  const handleDefaultPsChange = (value: string) => {
    updateSetting("defaultPsVersion", value);

    if (value === "auto") {
      if (state.psVersions.length > 0) {
        dispatch({ type: "SET_SELECTED_PS", path: state.psVersions[0].path });
      }
      return;
    }

    dispatch({ type: "SET_SELECTED_PS", path: value });
  };

  const handleRegister = async (ext: string) => {
    if (assocBusy) return;
    setAssocBusy(true);
    try {
      await cmd.registerFileAssociation(ext);
      setAssociations(await cmd.getFileAssociationStatus());
    } catch {
      // ignore
    } finally {
      setAssocBusy(false);
    }
  };

  const handleUnregister = async (ext: string) => {
    if (assocBusy) return;
    setAssocBusy(true);
    try {
      await cmd.unregisterFileAssociation(ext);
      setAssociations(await cmd.getFileAssociationStatus());
    } catch {
      // ignore
    } finally {
      setAssocBusy(false);
    }
  };

  const registerAll = async () => {
    if (assocBusy) return;
    setAssocBusy(true);
    try {
      await cmd.batchRegisterFileAssociations([...PS_EXTENSIONS]);
      setAssociations(await cmd.getFileAssociationStatus());
    } catch {
      // ignore
    } finally {
      setAssocBusy(false);
    }
  };

  const unregisterAll = async () => {
    if (assocBusy) return;
    setAssocBusy(true);
    try {
      await cmd.batchUnregisterFileAssociations([...PS_EXTENSIONS]);
      setAssociations(await cmd.getFileAssociationStatus());
    } catch {
      // ignore
    } finally {
      setAssocBusy(false);
    }
  };

  const applyExecutionPolicy = async () => {
    if (!state.selectedPsPath || applyingPolicy) return;
    setApplyingPolicy(true);
    setExecPolicyFeedback(null);
    try {
      await cmd.setExecutionPolicy(
        state.selectedPsPath,
        state.settings.executionPolicy ?? "Default",
      );
      setExecPolicyFeedback({
        type: "success",
        message: `Execution policy applied: ${state.settings.executionPolicy ?? "Default"}`,
      });
    } catch (err) {
      setExecPolicyFeedback({
        type: "error",
        message: String(err),
      });
    } finally {
      setApplyingPolicy(false);
    }
  };

  const isDefaultPolicy =
    (state.settings.executionPolicy ?? "Default") === "Default";

  return (
    <div
      data-testid="settings-panel"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) dispatch({ type: "TOGGLE_SETTINGS" });
      }}
    >
      <div
        className="rounded-lg shadow-2xl flex overflow-hidden"
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-primary)",
          fontFamily: "var(--ui-font-family)",
          fontSize: "var(--ui-font-size)",
          width: "780px",
          height: "580px",
        }}
      >
        {/* Left nav */}
        <div
          className="flex flex-col py-4"
          style={{
            width: "180px",
            borderRight: "1px solid var(--border-primary)",
            backgroundColor: "var(--bg-tertiary)",
            flexShrink: 0,
          }}
        >
          <h2
            className="text-sm font-semibold px-4 mb-3"
            style={{ color: "var(--text-primary)" }}
          >
            Settings
          </h2>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              data-testid={`settings-nav-${s.id}`}
              onClick={() => setActiveSection(s.id)}
              className="text-left px-4 py-1.5 text-sm transition-colors"
              style={{
                backgroundColor:
                  activeSection === s.id ? "var(--bg-hover)" : "transparent",
                color:
                  activeSection === s.id
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                borderLeft:
                  activeSection === s.id
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
              }}
            >
              {s.label}
            </button>
          ))}

          <div className="flex-1" />
          <button
            data-testid="settings-close"
            onClick={() => dispatch({ type: "TOGGLE_SETTINGS" })}
            className="mx-4 mb-2 px-3 py-1 text-sm rounded"
            style={{
              backgroundColor: "var(--btn-primary-bg)",
              color: "var(--btn-primary-fg)",
            }}
          >
            Close
          </button>
        </div>

        {/* Right content */}
        <div className="flex-1 p-6 overflow-auto">
          {/* EDITOR */}
          {activeSection === "editor" && (
            <div className="flex flex-col gap-4">
              <SectionHeading>Editor</SectionHeading>

              <SettingRow
                label="Font Size"
                tooltip="Sets the Monaco editor text size in pixels."
              >
                <NumberInput
                  min={8}
                  max={72}
                  value={state.settings.fontSize}
                  onChange={(v) => updateSetting("fontSize", v)}
                  error={validationErrors.fontSize}
                  width="w-20"
                />
              </SettingRow>

              <SettingRow
                label="Font Family"
                tooltip="Comma-separated font fallback list for the script editor."
              >
                <TextInput
                  value={state.settings.fontFamily}
                  onChange={(v) => updateSetting("fontFamily", v)}
                  placeholder="Cascadia Code, Consolas, monospace"
                  error={validationErrors.fontFamily}
                  width="w-72"
                />
              </SettingRow>

              <SettingRow
                label="Word Wrap"
                tooltip="Wraps long lines visually in the editor without changing file content."
              >
                <Toggle
                  checked={state.settings.wordWrap}
                  onChange={(v) => updateSetting("wordWrap", v)}
                  label="Wrap long lines in the editor"
                />
              </SettingRow>

              <SettingRow
                label="Tab Size"
                tooltip="Number of spaces Monaco uses for each indentation level."
              >
                <NumberInput
                  min={1}
                  max={16}
                  value={state.settings.tabSize ?? 4}
                  onChange={(v) => updateSetting("tabSize", v)}
                  error={validationErrors.tabSize}
                  width="w-20"
                />
              </SettingRow>

              <SettingRow
                label="Indentation"
                tooltip="When enabled, pressing Tab inserts spaces instead of a tab character."
              >
                <Toggle
                  checked={state.settings.insertSpaces !== false}
                  onChange={(v) => updateSetting("insertSpaces", v)}
                  label="Insert spaces instead of tab characters"
                />
              </SettingRow>

              <SettingRow
                label="Line Numbers"
                tooltip="Controls whether line numbers are shown, hidden, or relative."
              >
                <select
                  data-testid="settings-line-numbers"
                  value={state.settings.lineNumbers ?? "on"}
                  onChange={(e) =>
                    updateSetting(
                      "lineNumbers",
                      e.target.value as "on" | "off" | "relative",
                    )
                  }
                  className="w-40 text-sm"
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                  <option value="relative">Relative</option>
                </select>
              </SettingRow>

              <SettingRow
                label="Minimap"
                tooltip="Shows a miniature overview of the full script at the right edge."
              >
                <Toggle
                  checked={state.settings.showMinimap === true}
                  onChange={(v) => updateSetting("showMinimap", v)}
                  label="Show minimap on the right edge"
                />
              </SettingRow>

              <SettingRow
                label="Indent Guides"
                tooltip="Displays vertical guide lines to show indentation blocks."
              >
                <Toggle
                  checked={state.settings.showIndentGuides !== false}
                  onChange={(v) => updateSetting("showIndentGuides", v)}
                  label="Show indentation guide lines"
                />
              </SettingRow>

              <SettingRow
                label="Sticky Scroll"
                tooltip="Pins the current scope header near the top while you scroll."
              >
                <Toggle
                  checked={state.settings.stickyScroll === true}
                  onChange={(v) => updateSetting("stickyScroll", v)}
                  label="Pin active function/class headers while scrolling"
                />
              </SettingRow>

              <SettingRow
                label="Render Whitespace"
                tooltip="Controls how whitespace characters are visually marked in the editor."
              >
                <select
                  data-testid="settings-render-whitespace"
                  value={state.settings.renderWhitespace ?? "selection"}
                  onChange={(e) =>
                    updateSetting(
                      "renderWhitespace",
                      e.target.value as
                        | "none"
                        | "selection"
                        | "boundary"
                        | "all",
                    )
                  }
                  className="w-48 text-sm"
                >
                  <option value="none">None</option>
                  <option value="selection">Selection only</option>
                  <option value="boundary">Boundary only</option>
                  <option value="all">All</option>
                </select>
              </SettingRow>

              <SettingRow
                label="Welcome Page"
                tooltip="Reopen the PSForge Welcome page tab at any time."
              >
                <button
                  data-testid="settings-open-welcome"
                  onClick={() => {
                    const fn = (window as unknown as Record<string, unknown>)
                      .__psforge_openWelcome as (() => void) | undefined;
                    fn?.();
                  }}
                  className="px-3 py-1 text-sm rounded"
                  style={{
                    backgroundColor: "var(--btn-primary-bg)",
                    color: "var(--btn-primary-fg)",
                  }}
                >
                  Open Welcome Page
                </button>
              </SettingRow>
            </div>
          )}

          {/* INTELLISENSE */}
          {activeSection === "intellisense" && (
            <div className="flex flex-col gap-4">
              <SectionHeading>IntelliSense</SectionHeading>

              <InfoBox>
                IntelliSense uses PowerShell&apos;s built-in TabExpansion2 to
                provide context-aware completions for commands, parameters,
                variables, and paths. PSScriptAnalyzer provides inline
                diagnostics (squiggles) as you type.
              </InfoBox>

              <SettingRow
                label="Enable IntelliSense"
                tooltip="Enables PowerShell completion suggestions while typing."
              >
                <Toggle
                  checked={state.settings.enableIntelliSense !== false}
                  onChange={(v) => updateSetting("enableIntelliSense", v)}
                  label="Show completion suggestions (TabExpansion2)"
                />
              </SettingRow>

              <SettingRow
                label="Enable PSSA Analysis"
                tooltip="Runs PSScriptAnalyzer in the editor and shows squiggle diagnostics."
              >
                <Toggle
                  checked={state.settings.enablePssa !== false}
                  onChange={(v) => updateSetting("enablePssa", v)}
                  label="Show PSScriptAnalyzer squiggles as you type"
                />
              </SettingRow>

              {!state.settings.enablePssa && (
                <InfoBox>
                  PSScriptAnalyzer squiggles are disabled. Existing markers will
                  be cleared from the editor on the next change.
                </InfoBox>
              )}
            </div>
          )}

          {/* EXECUTION */}
          {activeSection === "execution" && (
            <div className="flex flex-col gap-4">
              <SectionHeading>Execution</SectionHeading>

              <SettingRow
                label="Default PowerShell"
                tooltip="Chooses which discovered PowerShell executable PSForge uses by default."
              >
                <div className="flex flex-col gap-1">
                  <select
                    data-testid="settings-default-ps"
                    value={state.settings.defaultPsVersion}
                    onChange={(e) => handleDefaultPsChange(e.target.value)}
                    className="w-72 text-sm"
                  >
                    <option value="auto">Auto-detect</option>
                    {state.psVersions.map((v) => (
                      <option key={v.path} value={v.path}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    The PowerShell version selected in the toolbar is saved and
                    restored on next launch.
                  </p>
                </div>
              </SettingRow>

              <SettingRow
                label="PowerShell 7 Recommendation"
                tooltip="When enabled, PSForge shows a non-blocking banner if only Windows PowerShell 5.1 is detected."
              >
                <Toggle
                  checked={state.settings.showPs7InstallReminder !== false}
                  onChange={(v) => updateSetting("showPs7InstallReminder", v)}
                  label="Show PS7 install recommendation when PS7 is missing"
                />
              </SettingRow>

              <SettingRow
                label="Application Updates"
                tooltip="Checks the public GitHub Releases feed for signed PSForge updates when the app starts."
              >
                <div className="flex flex-col gap-1">
                  <Toggle
                    checked={state.settings.checkForUpdatesOnStartup !== false}
                    onChange={(v) =>
                      updateSetting("checkForUpdatesOnStartup", v)
                    }
                    label="Check for application updates on startup"
                  />
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Automatic checks are silent unless an update is found. You
                    can still trigger a manual check from the status bar at any
                    time.
                  </p>
                </div>
              </SettingRow>

              <SettingRow
                label="Auto-Save on Run"
                tooltip="Automatically saves the active file before F5 execution."
              >
                <Toggle
                  checked={state.settings.autoSaveOnRun === true}
                  onChange={(v) => updateSetting("autoSaveOnRun", v)}
                  label="Save the active file before running (F5)"
                />
              </SettingRow>

              <SettingRow
                label="Clear Output on Run"
                tooltip="Clears previous output before each script run."
              >
                <Toggle
                  checked={state.settings.clearOutputOnRun !== false}
                  onChange={(v) => updateSetting("clearOutputOnRun", v)}
                  label="Clear the terminal before each run"
                />
              </SettingRow>

              <SettingRow
                label="Runspace Persistence"
                tooltip="Controls whether script/debug runs reuse one backend runspace or start from a fresh runspace each time."
              >
                <div className="flex flex-col gap-1">
                  <Toggle
                    checked={
                      state.settings.persistRunspaceBetweenRuns !== false
                    }
                    onChange={(v) =>
                      updateSetting("persistRunspaceBetweenRuns", v)
                    }
                    label="Persist runspace state between runs"
                  />
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Off means each run/debug starts from a clean PowerShell
                    session. On means globals/modules/location can carry over.
                  </p>
                </div>
              </SettingRow>

              <SettingRow
                label="Working Directory"
                tooltip="Sets the current directory used for script execution and relative paths."
              >
                <div className="flex flex-col gap-2">
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="workingDirMode"
                        value="file"
                        checked={
                          (state.settings.workingDirMode ?? "file") === "file"
                        }
                        onChange={() => updateSetting("workingDirMode", "file")}
                      />
                      Use file&apos;s directory
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="workingDirMode"
                        value="custom"
                        checked={state.settings.workingDirMode === "custom"}
                        onChange={() =>
                          updateSetting("workingDirMode", "custom")
                        }
                      />
                      Custom path
                    </label>
                  </div>

                  {state.settings.workingDirMode === "custom" && (
                    <TextInput
                      value={state.settings.customWorkingDir ?? ""}
                      onChange={(v) => updateSetting("customWorkingDir", v)}
                      placeholder="C:\Scripts"
                      error={validationErrors.customWorkingDir}
                      width="w-72"
                    />
                  )}
                </div>
              </SettingRow>

              <SettingRow
                label="Execution Policy"
                tooltip="Selects the CurrentUser PowerShell execution policy override."
              >
                <div className="flex flex-col gap-2">
                  <InfoBox warn>
                    This calls{" "}
                    <span className="font-mono">
                      Set-ExecutionPolicy -Scope CurrentUser
                    </span>
                    . It affects how PowerShell treats unsigned scripts.
                    &quot;Default&quot; leaves your existing policy unchanged.
                  </InfoBox>

                  <select
                    data-testid="settings-execution-policy"
                    value={state.settings.executionPolicy ?? "Default"}
                    onChange={(e) =>
                      updateSetting("executionPolicy", e.target.value)
                    }
                    className="w-48 text-sm"
                  >
                    {EXECUTION_POLICIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>

                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                    {
                      POLICY_DESCRIPTIONS[
                        state.settings.executionPolicy ?? "Default"
                      ]
                    }
                  </p>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => void applyExecutionPolicy()}
                      disabled={
                        applyingPolicy ||
                        !state.selectedPsPath ||
                        isDefaultPolicy
                      }
                      className="px-3 py-1 text-sm rounded"
                      style={{
                        backgroundColor: "var(--btn-primary-bg)",
                        color: "var(--btn-primary-fg)",
                        opacity:
                          applyingPolicy ||
                          !state.selectedPsPath ||
                          isDefaultPolicy
                            ? 0.5
                            : 1,
                        cursor:
                          applyingPolicy ||
                          !state.selectedPsPath ||
                          isDefaultPolicy
                            ? "not-allowed"
                            : "pointer",
                      }}
                      title={
                        isDefaultPolicy
                          ? "Select a policy other than Default to apply"
                          : "Apply this policy to CurrentUser scope (no admin required)"
                      }
                    >
                      {applyingPolicy ? "Applying..." : "Apply Policy"}
                    </button>

                    {execPolicyFeedback && (
                      <span
                        className="text-sm"
                        style={{
                          color:
                            execPolicyFeedback.type === "success"
                              ? "var(--type-string)"
                              : "var(--stream-stderr)",
                        }}
                      >
                        {execPolicyFeedback.message}
                      </span>
                    )}
                  </div>
                </div>
              </SettingRow>
            </div>
          )}

          {/* OUTPUT */}
          {activeSection === "output" && (
            <div className="flex flex-col gap-4">
              <SectionHeading>Output &amp; Terminal</SectionHeading>

              <SettingRow
                label="Terminal Profile Loading"
                tooltip="Loads PowerShell profile scripts when opening the integrated terminal."
              >
                <div className="flex flex-col gap-1">
                  <Toggle
                    checked={state.settings.terminalLoadProfile === true}
                    onChange={(v) => updateSetting("terminalLoadProfile", v)}
                    label="Load PowerShell profile scripts when terminal starts"
                  />
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Enables profile-based customizations (for example
                    command-not-found addons) but may slow startup or run
                    profile side effects.
                  </p>
                </div>
              </SettingRow>

              <SettingRow
                label="Show Timestamps"
                tooltip="Prepends local-time timestamps to script output lines when PSForge captures them."
              >
                <Toggle
                  checked={state.settings.showTimestamps === true}
                  onChange={(v) => updateSetting("showTimestamps", v)}
                  label="Show timestamps on captured script output"
                />
              </SettingRow>

              <SettingRow
                label="Output Word Wrap"
                tooltip="Wraps long lines in PSForge bottom-pane text views."
              >
                <Toggle
                  checked={state.settings.outputWordWrap === true}
                  onChange={(v) => updateSetting("outputWordWrap", v)}
                  label="Wrap long output lines"
                />
              </SettingRow>

              <SettingRow
                label="Output Font Size"
                tooltip="Sets font size for Variables, Debugger, Help, and terminal text."
              >
                <NumberInput
                  min={8}
                  max={72}
                  value={state.settings.outputFontSize ?? 13}
                  onChange={(v) => updateSetting("outputFontSize", v)}
                  error={validationErrors.outputFontSize}
                  width="w-20"
                />
              </SettingRow>

              <SettingRow
                label="Output Font Family"
                tooltip="Font stack used for Variables, Debugger, Help, and terminal panes."
              >
                <TextInput
                  value={
                    state.settings.outputFontFamily ??
                    "Cascadia Code, Consolas, monospace"
                  }
                  onChange={(v) => updateSetting("outputFontFamily", v)}
                  placeholder="Cascadia Code, Consolas, monospace"
                  error={validationErrors.outputFontFamily}
                  width="w-72"
                />
              </SettingRow>

              <SettingRow
                label="Max Recent Files"
                tooltip="Maximum number of file paths kept in the Recent Files menu."
              >
                <NumberInput
                  min={1}
                  max={50}
                  value={state.settings.maxRecentFiles ?? 20}
                  onChange={(v) => updateSetting("maxRecentFiles", v)}
                  error={validationErrors.maxRecentFiles}
                  width="w-20"
                />
              </SettingRow>
            </div>
          )}

          {/* APPEARANCE */}
          {activeSection === "appearance" && (
            <div className="flex flex-col gap-4">
              <SectionHeading>Appearance</SectionHeading>

              <SettingRow
                label="Theme"
                tooltip="Applies the global PSForge color theme."
              >
                <select
                  data-testid="settings-theme"
                  value={state.settings.theme}
                  onChange={(e) => {
                    const theme = e.target.value as ThemeName;
                    document.documentElement.setAttribute("data-theme", theme);
                    updateSetting("theme", theme);
                  }}
                  className="w-48 text-sm"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="ise-classic">PS ISE Classic</option>
                </select>
              </SettingRow>

              <SettingRow
                label="Split Position"
                tooltip="Sets the editor/output vertical split ratio."
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={20}
                    max={80}
                    value={state.settings.splitPosition}
                    onChange={(e) =>
                      updateSetting("splitPosition", parseInt(e.target.value))
                    }
                    className="w-48"
                  />
                  <span
                    className="text-sm"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {Math.round(state.settings.splitPosition)}%
                  </span>
                </div>
              </SettingRow>

              <SectionHeading>UI Chrome Font</SectionHeading>

              <SettingRow
                label="Font Family"
                tooltip="Font stack for application chrome such as toolbar, status bar, and dialogs."
              >
                <TextInput
                  value={state.settings.uiFontFamily}
                  onChange={(v) => updateSetting("uiFontFamily", v)}
                  placeholder="-apple-system, Segoe UI, sans-serif"
                  error={validationErrors.uiFontFamily}
                  width="w-72"
                />
              </SettingRow>

              <SettingRow
                label="Font Size"
                tooltip="Font size for application chrome elements."
              >
                <NumberInput
                  min={8}
                  max={24}
                  value={state.settings.uiFontSize ?? 13}
                  onChange={(v) => updateSetting("uiFontSize", v)}
                  error={validationErrors.uiFontSize}
                  width="w-20"
                />
              </SettingRow>

              <SectionHeading>Modules List Font</SectionHeading>

              <SettingRow
                label="Font Family"
                tooltip="Font stack used in the modules/sidebar list."
              >
                <TextInput
                  value={state.settings.sidebarFontFamily}
                  onChange={(v) => updateSetting("sidebarFontFamily", v)}
                  placeholder="-apple-system, Segoe UI, sans-serif"
                  error={validationErrors.sidebarFontFamily}
                  width="w-72"
                />
              </SettingRow>

              <SettingRow
                label="Font Size"
                tooltip="Font size used in the modules/sidebar list."
              >
                <NumberInput
                  min={8}
                  max={24}
                  value={state.settings.sidebarFontSize ?? 12}
                  onChange={(v) => updateSetting("sidebarFontSize", v)}
                  error={validationErrors.sidebarFontSize}
                  width="w-20"
                />
              </SettingRow>
            </div>
          )}

          {/* FILE ASSOCIATIONS */}
          {activeSection === "associations" && (
            <div className="flex flex-col gap-4">
              <SectionHeading>File Associations</SectionHeading>

              <InfoBox warn>
                Associating .ps1 files with an editor bypasses Windows&apos;
                built-in security prompt for PowerShell scripts. Scripts will
                open in PSForge instead of showing a security dialog.
              </InfoBox>

              <div className="flex gap-2">
                <button
                  onClick={registerAll}
                  disabled={assocBusy}
                  className="px-3 py-1 text-sm rounded"
                  style={{
                    backgroundColor: "var(--btn-primary-bg)",
                    color: "var(--btn-primary-fg)",
                    opacity: assocBusy ? 0.5 : 1,
                  }}
                >
                  {assocBusy ? "Working..." : "Register All"}
                </button>
                <button
                  onClick={unregisterAll}
                  disabled={assocBusy}
                  className="px-3 py-1 text-sm rounded"
                  style={{
                    backgroundColor: "var(--btn-danger-bg)",
                    color: "var(--btn-danger-fg)",
                    opacity: assocBusy ? 0.5 : 1,
                  }}
                >
                  {assocBusy ? "Working..." : "Unregister All"}
                </button>
              </div>

              {assocLoading ? (
                <div
                  className="animate-pulse text-sm"
                  style={{ color: "var(--text-muted)" }}
                >
                  Loading...
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      style={{
                        borderBottom: "1px solid var(--border-primary)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <th className="text-left py-1 px-2">Extension</th>
                      <th className="text-left py-1 px-2">Current Handler</th>
                      <th className="text-left py-1 px-2">Status</th>
                      <th className="text-right py-1 px-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {associations.map((a) => (
                      <tr
                        key={a.extension}
                        style={{
                          borderBottom: "1px solid var(--border-primary)",
                        }}
                      >
                        <td
                          className="py-1 px-2 font-mono"
                          style={{ color: "var(--text-accent)" }}
                        >
                          {a.extension}
                        </td>
                        <td
                          className="py-1 px-2"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {a.currentHandler}
                        </td>
                        <td className="py-1 px-2">
                          {a.isPsforge ? (
                            <span style={{ color: "var(--type-string)" }}>
                              PSForge
                            </span>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>
                              Other
                            </span>
                          )}
                        </td>
                        <td className="py-1 px-2 text-right">
                          {a.isPsforge ? (
                            <button
                              onClick={() => handleUnregister(a.extension)}
                              disabled={assocBusy}
                              className="px-2 py-0.5 rounded"
                              style={{
                                backgroundColor: "var(--btn-danger-bg)",
                                color: "var(--btn-danger-fg)",
                                fontSize: "var(--ui-font-size-xs)",
                                opacity: assocBusy ? 0.5 : 1,
                              }}
                            >
                              Unregister
                            </button>
                          ) : (
                            <button
                              onClick={() => handleRegister(a.extension)}
                              disabled={assocBusy}
                              className="px-2 py-0.5 rounded"
                              style={{
                                backgroundColor: "var(--btn-primary-bg)",
                                color: "var(--btn-primary-fg)",
                                fontSize: "var(--ui-font-size-xs)",
                                opacity: assocBusy ? 0.5 : 1,
                              }}
                            >
                              Register
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="text-sm font-semibold uppercase tracking-wider mb-1 pb-1"
      style={{
        color: "var(--text-secondary)",
        borderBottom: "1px solid var(--border-primary)",
      }}
    >
      {children}
    </h3>
  );
}

function SettingRow({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        className="text-sm font-medium flex items-center gap-1"
        style={{ color: "var(--text-primary)" }}
      >
        {label}
        {tooltip && (
          <span
            title={tooltip}
            aria-label={tooltip}
            className="inline-flex items-center justify-center text-[10px] font-bold rounded-full cursor-help select-none"
            style={{
              width: "14px",
              height: "14px",
              border: "1px solid var(--border-primary)",
              color: "var(--text-muted)",
              backgroundColor: "var(--bg-tertiary)",
            }}
          >
            i
          </span>
        )}
      </label>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
    </label>
  );
}

function NumberInput({
  min,
  max,
  value,
  onChange,
  error,
  width,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  error?: string;
  width?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value);
          if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
        className={`${width ?? "w-20"} text-sm`}
        style={{
          borderColor: error ? "var(--stream-stderr)" : undefined,
        }}
      />
      {error && (
        <p className="text-sm" style={{ color: "var(--stream-stderr)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  error,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  width?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${width ?? "w-64"} text-sm`}
        style={{
          borderColor: error ? "var(--stream-stderr)" : undefined,
        }}
      />
      {error && (
        <p className="text-sm" style={{ color: "var(--stream-stderr)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function InfoBox({
  children,
  warn,
}: {
  children: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div
      className="text-sm p-3 rounded"
      style={{
        backgroundColor: "var(--bg-tertiary)",
        border: "1px solid var(--border-primary)",
        color: warn ? "var(--stream-warning)" : "var(--text-secondary)",
      }}
    >
      {children}
    </div>
  );
}
