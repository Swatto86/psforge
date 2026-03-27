/** PSForge Tauri IPC bridge - wraps all invoke() calls with proper typing. */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AssociationStatus,
  BatchResult,
  CertInfo,
  CommandInfo,
  FileContent,
  ModuleInfo,
  ModuleInstallSuggestion,
  PsCompletion,
  PssaDiagnostic,
  PsVersion,
  ScriptParameter,
  Snippet,
  VariableInfo,
} from "./types";

/** Execute a complete PowerShell script. Output streamed via 'ps-output' events. */
export async function executeScript(
  psPath: string,
  script: string,
  workingDir: string,
  execPolicy: string,
  scriptArgs: string[] = [],
): Promise<number> {
  return invoke<number>("execute_script", {
    psPath,
    script,
    workingDir,
    execPolicy,
    scriptArgs,
  });
}

/** Execute selected text (F8 behaviour). */
export async function executeSelection(
  psPath: string,
  selection: string,
  workingDir: string,
  execPolicy: string,
): Promise<number> {
  return invoke<number>("execute_selection", {
    psPath,
    selection,
    workingDir,
    execPolicy,
  });
}

/** Stop the currently running script. */
export async function stopScript(): Promise<void> {
  return invoke("stop_script");
}

/**
 * Inspect a PowerShell script's param() block and return metadata for each
 * declared parameter.  Used to detect mandatory parameters before running so
 * PSForge can prompt the user rather than letting the script error out.
 *
 * Returns an empty array when the script has no param() block, when
 * parameter inspection fails (graceful degradation), or when the script
 * content is empty.
 */
export async function getScriptParameters(
  psPath: string,
  script: string,
): Promise<ScriptParameter[]> {
  return invoke<ScriptParameter[]>("get_script_parameters", { psPath, script });
}

/** Send stdin input to the running process. */
export async function sendStdin(input: string): Promise<void> {
  return invoke("send_stdin", { input });
}

/** Discover all installed PowerShell versions. */
export async function getPsVersions(): Promise<PsVersion[]> {
  return invoke<PsVersion[]>("get_ps_versions");
}

/**
 * Returns the file path passed as a CLI argument when the app was launched
 * via a file-type association (e.g. double-click in Explorer).  Returns
 * null when the app was launched normally with no file argument.
 */
export async function getLaunchPath(): Promise<string | null> {
  return invoke<string | null>("get_launch_path");
}

/** Get all installed modules for a given PS binary. */
export async function getInstalledModules(
  psPath: string,
): Promise<ModuleInfo[]> {
  return invoke<ModuleInfo[]>("get_installed_modules", { psPath });
}

/** Get exported commands for a specific module. */
export async function getModuleCommands(
  psPath: string,
  moduleName: string,
): Promise<CommandInfo[]> {
  return invoke<CommandInfo[]>("get_module_commands", { psPath, moduleName });
}

/** Get variables after running a script. */
export async function getVariablesAfterRun(
  psPath: string,
  script: string,
  workingDir: string,
): Promise<VariableInfo[]> {
  return invoke<VariableInfo[]>("get_variables_after_run", {
    psPath,
    script,
    workingDir,
  });
}

/** Read a file with encoding detection. */
export async function readFileContent(path: string): Promise<FileContent> {
  return invoke<FileContent>("read_file_content", { path });
}

/** Save file content with specified encoding. */
export async function saveFileContent(
  path: string,
  content: string,
  encoding: string,
): Promise<void> {
  return invoke("save_file_content", { path, content, encoding });
}

/** Load user settings. */
export async function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

/** Save user settings. */
export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke("save_settings", { settings });
}

/** Register a file association for an extension. */
export async function registerFileAssociation(
  extension: string,
): Promise<void> {
  return invoke("register_file_association", { extension });
}

/** Unregister a file association for an extension. */
export async function unregisterFileAssociation(
  extension: string,
): Promise<void> {
  return invoke("unregister_file_association", { extension });
}

/** Open a file's containing folder in the OS file manager, selecting the file. */
export async function revealInExplorer(path: string): Promise<void> {
  return invoke("reveal_in_explorer", { path });
}

/** Get current file association status for all PS extensions. */
export async function getFileAssociationStatus(): Promise<AssociationStatus[]> {
  return invoke<AssociationStatus[]>("get_file_association_status");
}

/** Register multiple file extensions as a batch operation.
 *  Returns successes and per-item errors rather than failing on the first error (Rule 11). */
export async function batchRegisterFileAssociations(
  extensions: string[],
): Promise<BatchResult<string>> {
  return invoke<BatchResult<string>>("batch_register_file_associations", {
    extensions,
  });
}

/** Unregister multiple file extensions as a batch operation.
 *  Returns successes and per-item errors rather than failing on the first error (Rule 11). */
export async function batchUnregisterFileAssociations(
  extensions: string[],
): Promise<BatchResult<string>> {
  return invoke<BatchResult<string>>("batch_unregister_file_associations", {
    extensions,
  });
}

/** Get all snippets (built-in + user). */
export async function getSnippets(): Promise<Snippet[]> {
  return invoke<Snippet[]>("get_snippets");
}

/** Save user-defined snippets. */
export async function saveUserSnippets(snippets: Snippet[]): Promise<void> {
  return invoke("save_user_snippets", { snippets });
}

// ---------------------------------------------------------------------------
// Integrated Terminal
// ---------------------------------------------------------------------------

/** Start an interactive PTY terminal session.
 *  Pass an empty string or "auto" to auto-detect the best available shell.
 *  Returns a session id used to correlate output/exit events.
 */
export async function startTerminal(
  shellPath: string,
  cols: number,
  rows: number,
): Promise<number> {
  return invoke<number>("start_terminal", { shellPath, cols, rows });
}

/** Writes raw terminal input bytes to the active PTY session. */
export async function terminalWrite(data: string): Promise<void> {
  return invoke("terminal_write", { data });
}

/** Execute a PS command in the active terminal session.
 *  Compatibility shim for callers that submit whole commands.
 */
export async function terminalExec(command: string): Promise<void> {
  return invoke("terminal_exec", { command });
}

/** Resize the active PTY terminal using xterm.js cols/rows. */
export async function terminalResize(
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { cols, rows });
}

/** Stop the active terminal session and clean up the child process. */
export async function stopTerminal(): Promise<void> {
  return invoke("stop_terminal");
}

// ---------------------------------------------------------------------------
// Static Analysis & IntelliSense
// ---------------------------------------------------------------------------

/**
 * Runs PSScriptAnalyzer on the given script content and returns diagnostics.
 * Returns an empty array when PSScriptAnalyzer is not installed or on any error
 * (Rule 11 graceful degradation — backend never propagates PSSA absence as a
 * user-visible error).
 */
export async function analyzeScript(
  psPath: string,
  scriptContent: string,
): Promise<PssaDiagnostic[]> {
  return invoke<PssaDiagnostic[]>("analyze_script", { psPath, scriptContent });
}

/**
 * Fetches PowerShell TabExpansion2 completions for the given script and
 * cursor column position.  Returns an empty array on any error so that Monaco
 * completion never crashes.
 */
export async function getCompletions(
  psPath: string,
  scriptContent: string,
  cursorColumn: number,
): Promise<PsCompletion[]> {
  return invoke<PsCompletion[]>("get_completions", {
    psPath,
    scriptContent,
    cursorColumn,
  });
}

/**
 * Suggests installable modules that provide `commandName`.
 * Returns an empty array when discovery tooling is unavailable or no matches exist.
 */
export async function suggestModulesForCommand(
  psPath: string,
  commandName: string,
): Promise<ModuleInstallSuggestion[]> {
  return invoke<ModuleInstallSuggestion[]>("suggest_modules_for_command", {
    psPath,
    commandName,
  });
}

// ---------------------------------------------------------------------------
// Execution Policy
// ---------------------------------------------------------------------------

/**
 * Returns the current PowerShell execution policy for the current user scope.
 * Returns "Unknown" when the query fails.
 */
export async function getExecutionPolicy(psPath: string): Promise<string> {
  return invoke<string>("get_execution_policy", { psPath });
}

/**
 * Sets the PowerShell execution policy for the current user scope (no admin required).
 * Pass "Default" to leave the system setting unchanged.
 * Throws AppError when an invalid policy name is supplied.
 */
export async function setExecutionPolicy(
  psPath: string,
  policy: string,
): Promise<void> {
  return invoke("set_execution_policy", { psPath, policy });
}
// ---------------------------------------------------------------------------
// Script Formatter
// ---------------------------------------------------------------------------

/**
 * Formats a PowerShell script using PSScriptAnalyzer Invoke-Formatter.
 * Returns the formatted content.  Falls back to the original content when
 * PSScriptAnalyzer is not installed or formatting fails (Rule 11 graceful degradation).
 */
export async function formatScript(
  psPath: string,
  scriptContent: string,
): Promise<string> {
  return invoke<string>("format_script", { psPath, scriptContent });
}

// ---------------------------------------------------------------------------
// PowerShell Profile
// ---------------------------------------------------------------------------

/**
 * Returns the path to the current user's PowerShell profile script
 * (CurrentUserCurrentHost scope).  Creates the parent directory if needed.
 * Throws AppError when the path cannot be determined.
 */
export async function getPsProfilePath(psPath: string): Promise<string> {
  return invoke<string>("get_ps_profile_path", { psPath });
}

// ---------------------------------------------------------------------------
// Script Signing
// ---------------------------------------------------------------------------

/**
 * Returns all code-signing certificates in the current user's certificate store.
 * Returns an empty array when no certificates are found (graceful degradation).
 */
export async function getSigningCertificates(
  psPath: string,
): Promise<CertInfo[]> {
  return invoke<CertInfo[]>("get_signing_certificates", { psPath });
}

/**
 * Signs a saved PowerShell script file with an Authenticode certificate.
 * The file at `scriptPath` must exist on disk before calling this.
 * Returns the SignatureStatus string (e.g. "Valid") on success.
 * Throws AppError when signing fails, the cert is not found, or the file is missing.
 */
export async function signScript(
  psPath: string,
  scriptPath: string,
  thumbprint: string,
): Promise<string> {
  return invoke<string>("sign_script", { psPath, scriptPath, thumbprint });
}
