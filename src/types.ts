/** PSForge shared TypeScript types */

/** A tab in the editor representing an open file or unsaved buffer. */
export interface EditorTab {
  /** Unique identifier for this tab. */
  id: string;
  /** Display title (filename or "Untitled-N"). */
  title: string;
  /** Full file path on disk, or empty for unsaved. */
  filePath: string;
  /** Current editor content. */
  content: string;
  /** Content as last saved to disk (for dirty detection). */
  savedContent: string;
  /** File encoding. */
  encoding: string;
  /** Monaco editor language id. */
  language: string;
  /** Whether the content has been modified since last save. */
  isDirty: boolean;
  /**
   * Tab role. "welcome" renders the welcome pane instead of Monaco.
   * Omitting this field (or setting "code") gives standard editor behaviour.
   */
  tabType?: "code" | "welcome";
}

/** A discovered PowerShell installation. */
export interface PsVersion {
  name: string;
  path: string;
  version: string;
}

/** A line of output from a running script. */
export interface OutputLine {
  stream: "stdout" | "stderr" | "verbose" | "warning";
  text: string;
  timestamp: string;
}

/** A diagnostic problem item parsed from script output or static analysis. */
export interface ProblemItem {
  /** Severity level. */
  severity: "error" | "warning" | "info";
  /** Human-readable problem description. */
  message: string;
  /** Source that produced this diagnostic (e.g. "PowerShell"). */
  source: string;
  /** Line number (1-indexed) where the problem occurred, if known. */
  line?: number;
  /** Column number (1-indexed) where the problem occurred, if known. */
  column?: number;
}

/** An installed PowerShell module. */
export interface ModuleInfo {
  name: string;
  version: string;
  moduleType: string;
  path: string;
}

/** An exported command from a module. */
export interface CommandInfo {
  name: string;
  commandType: string;
}

/** Metadata for a PowerShell command parameter. */
export interface CommandParameterInfo {
  /** Parameter name without leading `-`. */
  name: string;
  /** .NET type name (for example "System.String"). */
  typeName: string;
  /** True when at least one ParameterAttribute marks this argument mandatory. */
  isMandatory: boolean;
  /** Positional index, or null when non-positional/named-only. */
  position: number | null;
  /** Alternative parameter names accepted by PowerShell. */
  aliases: string[];
  /** True when PowerShell accepts pipeline input for this parameter. */
  acceptsPipelineInput: boolean;
  /** True when parameter type is SwitchParameter. */
  isSwitch: boolean;
}

/** Context-sensitive help content for a PowerShell command. */
export interface CommandHelpInfo {
  /** Resolved command/topic name. */
  name: string;
  /** Short synopsis text from Get-Help. */
  synopsis: string;
  /** Rendered syntax section. */
  syntax: string;
  /** Full help body text. */
  fullText: string;
  /** Best-effort online help URL when available. */
  onlineUri: string;
}

/** A variable from the scope inspector. */
export interface VariableInfo {
  name: string;
  value: string;
  typeName: string;
}

/** A variable visible in the current debugger scope. */
export interface DebugLocal {
  /** Variable name without leading '$'. */
  name: string;
  /** Runtime type name when known. */
  typeName: string;
  /** String-rendered value preview. */
  value: string;
  /** Scope/options descriptor from PowerShell (best-effort). */
  scope: string;
}

/** A single frame in the current PowerShell call stack. */
export interface DebugStackFrame {
  /** Function/cmdlet name when available. */
  functionName: string;
  /** Script path + line or "Interactive". */
  location: string;
  /** Command text associated with the frame. */
  command: string;
}

/** A user-defined watch expression and its latest evaluation result. */
export interface DebugWatch {
  expression: string;
  value: string;
  /** Non-empty when the expression evaluation failed. */
  error: string;
}

/** Breakpoint definition for line/variable breakpoints in the debugger. */
export interface DebugBreakpoint {
  /** 1-indexed source line for line breakpoints. */
  line?: number;
  /** Variable name (without `$`) for variable breakpoints. */
  variable?: string;
  /** Command/cmdlet name for command breakpoints. */
  targetCommand?: string;
  /** Variable breakpoint mode. */
  mode?: "Read" | "Write" | "ReadWrite";
  /** Expression condition that must evaluate truthy before breaking. */
  condition?: string;
  /** Break only on/after this hit count (1-based). */
  hitCount?: number;
  /** Optional action script executed when the breakpoint triggers. */
  command?: string;
}

/**
 * Metadata for a single parameter declared in a PowerShell script's param() block.
 * Returned by the `get_script_parameters` Tauri command.
 */
export interface ScriptParameter {
  /** Parameter name without the leading `$` (e.g. "Path", "Force"). */
  name: string;
  /** PowerShell type name (e.g. "String", "Int32", "Boolean", "SwitchParameter"). */
  typeName: string;
  /** True when the param carries `[Parameter(Mandatory)]` or `[Parameter(Mandatory=$true)]`. */
  isMandatory: boolean;
  /** True when the param declaration includes a default value expression. */
  hasDefault: boolean;
  /** Positional index from `[Parameter(Position=N)]`, or null if not positional. */
  position: number | null;
  /** Help text from `[Parameter(HelpMessage='...')]`, or empty string. */
  helpMessage: string;
}

/** File content result from the Rust backend. */
export interface FileContent {
  content: string;
  encoding: string;
  path: string;
}

/** File association status for a single extension. */
export interface AssociationStatus {
  extension: string;
  currentHandler: string;
  isPsforge: boolean;
}

/** A code snippet. */
export interface Snippet {
  name: string;
  category: string;
  description: string;
  code: string;
}

/** Application settings, synced with Rust backend. */
export interface AppSettings {
  // ---- Editor ----
  defaultPsVersion: string;
  theme: string;
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  /** Number of spaces per tab stop in the editor. */
  tabSize: number;
  /** When true the editor inserts spaces instead of tab characters. */
  insertSpaces: boolean;
  /** Whether to show the Monaco minimap on the right edge. */
  showMinimap: boolean;
  /** Line number display style: "on" | "off" | "relative". */
  lineNumbers: "on" | "off" | "relative";
  /** Which whitespace characters to render: "none" | "selection" | "boundary" | "all". */
  renderWhitespace: "none" | "selection" | "boundary" | "all";
  /** Show indent guides in the gutter. */
  showIndentGuides: boolean;
  /** Sticky scroll: pin active scope headers while scrolling. */
  stickyScroll: boolean;
  /** Whether PSScriptAnalyzer squiggles are enabled. */
  enablePssa: boolean;
  /** Whether PowerShell IntelliSense (TabExpansion2) is enabled. */
  enableIntelliSense: boolean;

  // ---- Execution ----
  /** Save the active file automatically before running (F5). */
  autoSaveOnRun: boolean;
  /** Clear the output pane before each run. */
  clearOutputOnRun: boolean;
  /** Keep script/debug runspace state between runs in the backend host process. */
  persistRunspaceBetweenRuns: boolean;
  /** PowerShell execution policy override ("Default" means no override). */
  executionPolicy: string;
  /** Working directory mode: "file" = use file's folder, "custom" = use customWorkingDir. */
  workingDirMode: "file" | "custom";
  /** Custom working directory path when workingDirMode is "custom". */
  customWorkingDir: string;

  // ---- Output ----
  /** Load PowerShell profiles when starting the integrated terminal. */
  terminalLoadProfile: boolean;
  showTimestamps: boolean;
  /** Font size for the output/terminal pane (may differ from editor). */
  outputFontSize: number;
  /** Font family for the output/terminal pane. */
  outputFontFamily: string;
  /** Wrap long lines in the output pane. */
  outputWordWrap: boolean;
  /** Font family for the UI chrome (buttons, labels, status bar, etc.). */
  uiFontFamily: string;
  /** Font size for the UI chrome in pixels. */
  uiFontSize: number;
  /** Font family for the sidebar modules list. */
  sidebarFontFamily: string;
  /** Font size for the sidebar modules list in pixels. */
  sidebarFontSize: number;
  /** Maximum recent files in dropdown. */
  maxRecentFiles: number;

  // ---- Layout ----
  splitPosition: number;
  recentFiles: string[];
  fileAssociations: Record<string, boolean>;
  /** Whether the module browser sidebar is visible. */
  sidebarVisible: boolean;
  /** Which side of the editor the module browser is docked to. */
  sidebarPosition: "left" | "right";
}

/** Default settings used when none are loaded. */
export const DEFAULT_SETTINGS: AppSettings = {
  defaultPsVersion: "auto",
  theme: "dark",
  fontSize: 14,
  fontFamily: "Cascadia Code, Consolas, monospace",
  wordWrap: false,
  tabSize: 4,
  insertSpaces: true,
  showMinimap: false,
  lineNumbers: "on",
  renderWhitespace: "selection",
  showIndentGuides: true,
  stickyScroll: false,
  enablePssa: true,
  enableIntelliSense: true,
  autoSaveOnRun: false,
  clearOutputOnRun: true,
  persistRunspaceBetweenRuns: true,
  executionPolicy: "Default",
  workingDirMode: "file",
  customWorkingDir: "",
  terminalLoadProfile: false,
  showTimestamps: false,
  outputFontSize: 13,
  outputFontFamily: "Cascadia Code, Consolas, monospace",
  outputWordWrap: false,
  uiFontFamily: "Segoe UI, sans-serif",
  uiFontSize: 14,
  sidebarFontFamily: "Segoe UI, sans-serif",
  sidebarFontSize: 13,
  maxRecentFiles: 20,
  splitPosition: 65,
  recentFiles: [],
  fileAssociations: {},
  sidebarVisible: true,
  sidebarPosition: "left",
};

/** Theme names. */
export type ThemeName = "dark" | "light" | "ise-classic";

/** A per-item error within a batch operation. */
export interface BatchError {
  /** Identifies the input that caused the failure (e.g. the file extension). */
  item: string;
  /** Machine-readable error code. */
  code: string;
  /** Human-readable failure reason. */
  message: string;
}

/** Result of a batch operation: successfully processed items plus accumulated errors.
 *  The operation continues even when individual items fail (Rule 11). */
export interface BatchResult<T> {
  /** Items processed successfully. */
  items: T[];
  /** Per-item errors, capped at MAX_BATCH_ERRORS (100) on the backend. */
  errors: BatchError[];
}

/**
 * A diagnostic produced by PSScriptAnalyzer static analysis.
 * Returned by the `analyze_script` Tauri command.
 * Line/column numbers are 1-indexed, matching Monaco conventions.
 */
export interface PssaDiagnostic {
  /** Friendly description of the issue. */
  message: string;
  /** PSSA severity level. "ParseError" maps to Error in the editor. */
  severity: "Error" | "Warning" | "Information" | "ParseError";
  /** The PSSA rule that fired (e.g. "PSAvoidUsingWriteHost"). */
  ruleName: string;
  /** Start line of the problematic range (1-indexed). */
  line: number;
  /** Start column of the problematic range (1-indexed). */
  column: number;
  /** End line of the problematic range (1-indexed). */
  endLine: number;
  /** End column of the problematic range (1-indexed). */
  endColumn: number;
}

/**
 * A single PowerShell completion candidate returned by TabExpansion2 via
 * the `get_completions` Tauri command.
 */
export interface PsCompletion {
  /** Full text to insert when selected. */
  completionText: string;
  /** Short label shown in the completion list. */
  listItemText: string;
  /** Tooltip / synopsis text for the completion. */
  toolTip: string;
  /**
   * PowerShell completion result type as a string
   * (e.g. "Command", "Parameter", "Variable", "Property", "Keyword", …).
   */
  resultType: string;
}

/**
 * Suggested module to install when a command is not available locally.
 * Returned by the `suggest_modules_for_command` Tauri command.
 */
export interface ModuleInstallSuggestion {
  /** Module/package name to install. */
  name: string;
  /** Version string from the repository metadata, if available. */
  version: string;
  /** Source repository name (for example "PSGallery"), if available. */
  repository: string;
  /** Ready-to-run install command for this module. */
  installCommand: string;
}

/** A code-signing certificate from the current user's certificate store. */
export interface CertInfo {
  /** 40-char hex thumbprint. */
  thumbprint: string;
  /** Full subject distinguished name. */
  subject: string;
  /** ISO-8601 expiry date string. */
  expiry: string;
  /** Human-readable certificate name (FriendlyName or extracted CN). */
  friendlyName: string;
}

/** All supported PS file extensions. */
export const PS_EXTENSIONS = [
  ".ps1",
  ".psm1",
  ".psd1",
  ".ps1xml",
  ".pssc",
  ".cdxml",
] as const;
