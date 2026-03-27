/** PSForge Editor Pane - Monaco Editor integration.
 *  Renders the Monaco editor for the active tab, syncing content and theme.
 *  When the active tab is a "welcome" tab, renders the WelcomePane instead.
 *
 *  Window globals set by this component:
 *  - window.__psforge_triggerFindReplace()  -- opens Monaco Find & Replace widget
 *  - window.__psforge_triggerGoToLine()     -- opens Monaco Go To Line widget
 *  - window.__psforge_getRunText()          -- returns selection, or current line
 *
 *  Editor enhancements wired here:
 *  - Cursor position tracking (dispatched to store -> displayed in StatusBar).
 *  - PSScriptAnalyzer squiggles (debounced 800 ms, degrades gracefully when not installed).
 *  - PowerShell IntelliSense via TabExpansion2 (registered as a Monaco completion provider).
 */

import React, { useRef, useCallback, useEffect } from "react";
import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import type {
  editor as MonacoEditor,
  Position as MonacoPosition,
  languages as MonacoLanguages,
} from "monaco-editor";
import { useAppState } from "../store";
import { getMonacoThemeData, monacoThemeName } from "../themes";
import { getPsMonarchGrammar } from "../ps-grammar";
import type { DebugBreakpoint, PsCompletion, ThemeName } from "../types";
import { WelcomePane } from "./WelcomePane";
import { analyzeScript, getCompletions } from "../commands";

// ---------------------------------------------------------------------------
// Helpers — kept module-level so they are not recreated on every render.
// ---------------------------------------------------------------------------

/** Maps a PSScriptAnalyzer severity string to the Monaco MarkerSeverity number. */
function pssaSeverity(
  monaco: typeof import("monaco-editor"),
  severity: string,
): number {
  switch (severity) {
    case "Error":
    case "ParseError":
      return monaco.MarkerSeverity.Error;
    case "Warning":
      return monaco.MarkerSeverity.Warning;
    case "Information":
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

/** Maps a PS TabExpansion2 ResultType string to a Monaco CompletionItemKind. */
function completionKind(
  monaco: typeof import("monaco-editor"),
  resultType: string,
): number {
  switch (resultType) {
    case "Command":
      return monaco.languages.CompletionItemKind.Function;
    case "Parameter":
    case "ParameterName":
      return monaco.languages.CompletionItemKind.Property;
    case "Variable":
      return monaco.languages.CompletionItemKind.Variable;
    case "ParameterValue":
      return monaco.languages.CompletionItemKind.Value;
    case "Keyword":
    case "DynamicKeyword":
      return monaco.languages.CompletionItemKind.Keyword;
    case "Property":
      return monaco.languages.CompletionItemKind.Field;
    case "Method":
      return monaco.languages.CompletionItemKind.Method;
    case "Type":
      return monaco.languages.CompletionItemKind.Class;
    case "Namespace":
      return monaco.languages.CompletionItemKind.Module;
    case "File":
    case "ProviderItem":
      return monaco.languages.CompletionItemKind.File;
    case "Folder":
    case "ProviderContainer":
      return monaco.languages.CompletionItemKind.Folder;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
}

/** Token boundary characters for PowerShell completion range detection. */
const PS_TOKEN_BOUNDARY_RE = /[\s,;|(){}\[\]`"'<>@#%&*!?+^]/;

/** Finds the start offset (0-based) of the token that ends at `offset`. */
function findTokenStart(scriptContent: string, offset: number): number {
  let tokenStart = offset;
  while (
    tokenStart > 0 &&
    !PS_TOKEN_BOUNDARY_RE.test(scriptContent[tokenStart - 1])
  ) {
    tokenStart--;
  }
  return tokenStart;
}

/** Adjusts the cursor offset for TabExpansion2 in parameter-name contexts. */
function completionCursorOffset(
  scriptContent: string,
  offset: number,
  tokenStart: number,
): number {
  // TabExpansion2 returns file/provider candidates at "Get-Command -" when
  // using the raw cursor index. Nudging by +1 for dash-prefixed tokens keeps
  // parameter completions stable while preserving other contexts.
  if (scriptContent[tokenStart] === "-") {
    // Normalize to at least one character past "-" so TabExpansion2 enters
    // parameter-name completion mode instead of provider path completion.
    return Math.max(offset, tokenStart + 2);
  }
  return offset;
}

/** Sort bucket so parameter candidates appear first in mixed suggestion lists. */
function completionSortWeight(resultType: string): string {
  switch (resultType) {
    case "Parameter":
    case "ParameterName":
      return "0";
    case "Command":
      return "1";
    case "Variable":
      return "2";
    case "Keyword":
    case "DynamicKeyword":
      return "3";
    case "Type":
    case "Namespace":
      return "4";
    case "File":
    case "Folder":
    case "ProviderItem":
    case "ProviderContainer":
      return "5";
    default:
      return "9";
  }
}

/** Result types that represent parameter-name completions. */
const PARAM_RESULT_TYPES = new Set(["Parameter", "ParameterName"]);

/** Result types that represent filesystem/provider path value completions. */
const PATHLIKE_RESULT_TYPES = new Set([
  "File",
  "Folder",
  "ProviderItem",
  "ProviderContainer",
]);

/** True when at least one completion candidate is a parameter name. */
function hasParameterCandidates(items: PsCompletion[]): boolean {
  return items.some((item) => PARAM_RESULT_TYPES.has(item.resultType));
}

/** True when all candidates are path/provider completions (or list is empty). */
function onlyPathLikeCandidates(items: PsCompletion[]): boolean {
  return items.length > 0 && items.every((item) => PATHLIKE_RESULT_TYPES.has(item.resultType));
}

/**
 * Fetch completions and retry nearby offsets in dash-prefixed parameter
 * contexts when TabExpansion2 returns only provider/file candidates.
 */
async function fetchCompletionsForContext(
  psPath: string,
  scriptContent: string,
  offset: number,
  tokenStart: number,
  completionOffset: number,
): Promise<PsCompletion[]> {
  const base = await getCompletions(psPath, scriptContent, completionOffset);
  if (scriptContent[tokenStart] !== "-") return base;
  if (hasParameterCandidates(base)) return base;
  if (!onlyPathLikeCandidates(base)) return base;

  const retryOffsets = Array.from(
    new Set([offset, tokenStart + 1, tokenStart + 2]),
  ).filter((candidate) => candidate >= 0 && candidate <= scriptContent.length);

  let best = base;
  for (const retryOffset of retryOffsets) {
    if (retryOffset === completionOffset) continue;
    try {
      const retried = await getCompletions(psPath, scriptContent, retryOffset);
      if (hasParameterCandidates(retried)) {
        return retried;
      }
      if (retried.length > best.length) {
        best = retried;
      }
    } catch {
      // Ignore retry failures and keep the best-known completion set.
    }
  }

  return best;
}

export function EditorPane() {
  const { state, dispatch, activeTab } = useAppState();
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

  // Ref that always holds the latest selected PS path so that async callbacks
  // (completions, PSSA) never capture a stale closure value.
  const psPathRef = useRef<string>(state.selectedPsPath);
  useEffect(() => {
    psPathRef.current = state.selectedPsPath;
  }, [state.selectedPsPath]);

  // Timer ref for debouncing PSScriptAnalyzer invocations on each keystroke.
  const pssaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear stale PSSA debounce timer whenever the active tab changes so a
  // pending analysis from the previous tab does not fire after the switch,
  // wasting a PS process spawn (the captured model mitigates stale-marker
  // application per BUG-NEW-1 fix, but skipping the spawn is still valuable).
  useEffect(() => {
    if (pssaTimerRef.current !== null) {
      clearTimeout(pssaTimerRef.current);
      pssaTimerRef.current = null;
    }
  }, [activeTab?.id]);

  // Disposable for the registered completion provider (kept so we can clean
  // up when the editor unmounts or a new provider is registered).
  const completionDisposableRef = useRef<{ dispose(): void } | null>(null);
  const breakpointDecorationsRef = useRef<string[]>([]);
  const contextMenuLineRef = useRef<number | null>(null);

  // Dispose the completion provider when the component unmounts.
  useEffect(() => {
    return () => {
      completionDisposableRef.current?.dispose();
      if (pssaTimerRef.current !== null) clearTimeout(pssaTimerRef.current);
      if (editorRef.current) {
        breakpointDecorationsRef.current = editorRef.current.deltaDecorations(
          breakpointDecorationsRef.current,
          [],
        );
      }
    };
  }, []);

  // Listen for snippet / command insertion from CommandPalette and Sidebar.
  // Both dispatch a `psforge-insert` CustomEvent with the code text in `detail`.
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (!text || !editorRef.current) return;
      const editor = editorRef.current;
      editor.focus();
      const selection = editor.getSelection();
      if (selection) {
        // Insert at cursor, replacing any current selection.
        editor.executeEdits("psforge-insert", [
          { range: selection, text, forceMoveMarkers: true },
        ]);
      }
    };
    window.addEventListener("psforge-insert", handler);
    return () => window.removeEventListener("psforge-insert", handler);
  }, []);

  // Expose editor action triggers as window globals so App.tsx keyboard
  // handlers (Ctrl+H, Ctrl+G) can fire them regardless of which element has focus.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__psforge_triggerFindReplace = () => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      editorRef.current
        .getAction("editor.action.startFindReplaceAction")
        ?.run();
    };
    w.__psforge_triggerGoToLine = () => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      editorRef.current.getAction("editor.action.gotoLine")?.run();
    };
    // Navigate to a specific line/column -- called by the Problems panel when
    // the user clicks a diagnostic entry to jump to the error location.
    w.__psforge_navigateTo = (line: number, column: number) => {
      if (!editorRef.current) return;
      editorRef.current.revealLineInCenter(line);
      editorRef.current.setPosition({ lineNumber: line, column: Math.max(1, column) });
      editorRef.current.focus();
    };
    // Returns the currently selected text, or the full current line when
    // selection is empty (PowerShell ISE F8 semantics).
    w.__psforge_getRunText = () => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return "";

      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) {
        return model.getValueInRange(selection);
      }

      const pos = editor.getPosition();
      if (!pos) return "";
      return model.getLineContent(pos.lineNumber);
    };
    return () => {
      delete w.__psforge_triggerFindReplace;
      delete w.__psforge_triggerGoToLine;
      delete w.__psforge_navigateTo;
      delete w.__psforge_getRunText;
    };
  }, []);

  // Register all custom themes BEFORE the editor instance is created.
  // This must be done in beforeMount (not handleEditorMount) so that the
  // initial `theme` prop passed to <Editor> resolves immediately without
  // falling back to the base vs-dark theme.
  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    // Register extended PS grammar (adds cmdlet + parameter token types) before
    // defining themes so that theme token rules match the new token names.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monaco.languages.setMonarchTokensProvider(
      "powershell",
      getPsMonarchGrammar() as any,
    );

    const themes: ThemeName[] = ["dark", "light", "ise-classic"];
    themes.forEach((t) => {
      monaco.editor.defineTheme(monacoThemeName(t), getMonacoThemeData(t));
    });
  }, []);

  const refreshBreakpointDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !activeTab || activeTab.tabType === "welcome") {
      return;
    }
    const model = editor.getModel();
    if (!model) return;

    const maxLine = model.getLineCount();
    const lineBreakpoints = (state.breakpoints[activeTab.id] ?? [])
      .filter(
        (bp): bp is DebugBreakpoint & { line: number } =>
          typeof bp.line === "number" && bp.line >= 1 && bp.line <= maxLine,
      )
      .sort((a, b) => a.line - b.line);
    const decorations: MonacoEditor.IModelDeltaDecoration[] = lineBreakpoints.map(
      (bp) => ({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName:
            bp.condition || bp.hitCount || bp.command
              ? "psforge-breakpoint-glyph-conditional"
              : "psforge-breakpoint-glyph",
          glyphMarginHoverMessage: {
            value:
              `Breakpoint (line ${bp.line})` +
              (bp.condition ? `\nCondition: ${bp.condition}` : "") +
              (bp.hitCount ? `\nHit Count: ${bp.hitCount}` : "") +
              (bp.command ? "\nAction: configured" : ""),
          },
          linesDecorationsClassName: "psforge-breakpoint-line",
        },
      }),
    );
    breakpointDecorationsRef.current = editor.deltaDecorations(
      breakpointDecorationsRef.current,
      decorations,
    );
  }, [activeTab, state.breakpoints]);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // Track selection for F8 legacy fallback consumers.
      editor.onDidChangeCursorSelection(() => {
        const model = editor.getModel();
        const selection = editor.getSelection();
        if (!model || !selection || selection.isEmpty()) {
          (window as unknown as Record<string, unknown>).__psforge_selection =
            "";
          return;
        }
        (window as unknown as Record<string, unknown>).__psforge_selection =
          model.getValueInRange(selection);
      });

      // --- Feature 1: Cursor position for status bar ---
      editor.onDidChangeCursorPosition((e) => {
        dispatch({
          type: "SET_CURSOR_POSITION",
          line: e.position.lineNumber,
          column: e.position.column,
        });
      });

      // Toggle breakpoints by clicking the gutter glyph margin or line numbers.
      editor.onMouseDown((e) => {
        if (!activeTab || activeTab.tabType === "welcome") return;
        if (!e.target.position) return;
        if (
          e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
          e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        ) {
          return;
        }
        dispatch({
          type: "TOGGLE_BREAKPOINT",
          tabId: activeTab.id,
          line: e.target.position.lineNumber,
        });
      });

      // Track the line where context menu is opened so custom actions can
      // target that line even if cursor position differs.
      editor.onContextMenu((e) => {
        if (e.target.position) {
          contextMenuLineRef.current = e.target.position.lineNumber;
          editor.setPosition(e.target.position);
        } else {
          contextMenuLineRef.current = null;
        }
      });

      const getTargetLine = (): number | null => {
        const lineFromContext = contextMenuLineRef.current;
        contextMenuLineRef.current = null;
        if (lineFromContext && lineFromContext >= 1) return lineFromContext;
        const pos = editor.getPosition();
        return pos?.lineNumber && pos.lineNumber >= 1 ? pos.lineNumber : null;
      };

      editor.addAction({
        id: "psforge-toggle-breakpoint",
        label: "Toggle Breakpoint",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.5,
        run: () => {
          if (!activeTab || activeTab.tabType === "welcome") return;
          const line = getTargetLine();
          if (!line) return;
          dispatch({
            type: "TOGGLE_BREAKPOINT",
            tabId: activeTab.id,
            line,
          });
          dispatch({ type: "SET_BOTTOM_TAB", tab: "debugger" });
        },
      });

      editor.addAction({
        id: "psforge-edit-breakpoint",
        label: "Add/Edit Breakpoint...",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.6,
        run: () => {
          if (!activeTab || activeTab.tabType === "welcome") return;
          const line = getTargetLine();
          if (!line) return;
          dispatch({ type: "SET_BOTTOM_TAB", tab: "debugger" });
          window.dispatchEvent(
            new CustomEvent("psforge-edit-breakpoint", {
              detail: { line },
            }),
          );
        },
      });

      // --- Feature 3: PowerShell IntelliSense via TabExpansion2 ---
      // Disposed when enable_intellisense is toggled off; re-registered when turned back on.
      // The outer useEffect below handles toggling; this block registers on first mount.
      if (state.settings.enableIntelliSense) {
        completionDisposableRef.current?.dispose();
        completionDisposableRef.current =
          monaco.languages.registerCompletionItemProvider("powershell", {
            // Trigger on common PS prefix characters so the list appears contextually.
            // Note: space (" ") fires the provider so that file-path completions
            // appear after a cmdlet name (e.g. "Get-ChildItem ").  The provider
            // also fires for "-" to show parameter completions.
            triggerCharacters: ["-", "$", "\\", " ", "."],
            provideCompletionItems: async (
              model: MonacoEditor.ITextModel,
              position: MonacoPosition,
              context: MonacoLanguages.CompletionContext,
            ) => {
              const psPath = psPathRef.current;
              if (!psPath) return { suggestions: [] };

              let scriptContent = model.getValue();
              // Monaco getOffsetAt gives a 0-based character offset, which is
              // what TabExpansion2 expects for -cursorColumn.
              let offset = model.getOffsetAt(position);

              // Monaco fires the completion provider when a trigger character is
              // typed, but may call provideCompletionItems before the trigger
              // character has been committed to the model (i.e. model.getValue()
              // may return content that does not yet include the trigger char).
              // If the context carries a trigger character that is absent from
              // the model at the cursor position, splice it in so that PS
              // receives the correct script content for TabExpansion2.
              if (
                context.triggerCharacter &&
                (offset === 0 ||
                  scriptContent[offset - 1] !== context.triggerCharacter)
              ) {
                scriptContent =
                  scriptContent.slice(0, offset) +
                  context.triggerCharacter +
                  scriptContent.slice(offset);
                offset += context.triggerCharacter.length;
              }

              const tokenStart = findTokenStart(scriptContent, offset);
              const completionOffset = completionCursorOffset(
                scriptContent,
                offset,
                tokenStart,
              );

              try {
                const items = await fetchCompletionsForContext(
                  psPath,
                  scriptContent,
                  offset,
                  tokenStart,
                  completionOffset,
                );
                const tokenStartPos = model.getPositionAt(tokenStart);
                const completionRange = {
                  startLineNumber: tokenStartPos.lineNumber,
                  startColumn: tokenStartPos.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                };

                const suggestions = items.map((c) => ({
                  label: c.listItemText || c.completionText,
                  kind: completionKind(monaco, c.resultType),
                  insertText: c.completionText,
                  // filterText ensures Monaco matches against the full completion
                  // text (e.g. "-Path") rather than just the display label
                  // (e.g. "Path"), which would cause parameter suggestions to be
                  // hidden when the trigger character "-" is already in the range.
                  filterText: c.completionText,
                  sortText: `${completionSortWeight(c.resultType)}_${(
                    c.listItemText || c.completionText
                  ).toLowerCase()}`,
                  detail: c.resultType,
                  documentation: c.toolTip || undefined,
                  range: completionRange,
                }));
                return { suggestions };
              } catch {
                return { suggestions: [] };
              }
            },
          });
      }

      // Focus editor
      editor.focus();
      refreshBreakpointDecorations();
    },
    [
      activeTab,
      state.settings.theme,
      state.settings.enableIntelliSense,
      dispatch,
      refreshBreakpointDecorations,
    ],
  );

  // Sync Monaco theme when app theme changes
  useEffect(() => {
    if (monacoRef.current) {
      const themeName = monacoThemeName(
        (state.settings.theme as ThemeName) || "dark",
      );
      monacoRef.current.editor.setTheme(themeName);
    }
  }, [state.settings.theme]);

  useEffect(() => {
    refreshBreakpointDecorations();
  }, [refreshBreakpointDecorations]);

  // Manage IntelliSense provider lifecycle when the setting is toggled post-mount.
  // On disable: dispose the registered provider so completions no longer fire.
  // On enable: re-register to restore functionality without requiring a remount.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (!state.settings.enableIntelliSense) {
      completionDisposableRef.current?.dispose();
      completionDisposableRef.current = null;
      return;
    }

    // Re-register only when not already registered.
    if (completionDisposableRef.current) return;

    completionDisposableRef.current =
      monaco.languages.registerCompletionItemProvider("powershell", {
        triggerCharacters: ["-", "$", "\\", " ", "."],
        provideCompletionItems: async (
          model: MonacoEditor.ITextModel,
          position: MonacoPosition,
          context: MonacoLanguages.CompletionContext,
        ) => {
          const psPath = psPathRef.current;
          if (!psPath) return { suggestions: [] };
          let scriptContent = model.getValue();
          let offset = model.getOffsetAt(position);
          // Monaco may fire the provider before the trigger character is
          // committed to the model.  Splice it in if absent at cursor-1.
          if (
            context.triggerCharacter &&
            (offset === 0 ||
              scriptContent[offset - 1] !== context.triggerCharacter)
          ) {
            scriptContent =
              scriptContent.slice(0, offset) +
              context.triggerCharacter +
              scriptContent.slice(offset);
            offset += context.triggerCharacter.length;
          }
          const tokenStart = findTokenStart(scriptContent, offset);
          const completionOffset = completionCursorOffset(
            scriptContent,
            offset,
            tokenStart,
          );
          try {
            const items = await fetchCompletionsForContext(
              psPath,
              scriptContent,
              offset,
              tokenStart,
              completionOffset,
            );
            const tokenStartPos = model.getPositionAt(tokenStart);
            const completionRange = {
              startLineNumber: tokenStartPos.lineNumber,
              startColumn: tokenStartPos.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            };
            return {
              suggestions: items.map((c) => ({
                label: c.listItemText || c.completionText,
                kind: completionKind(monaco, c.resultType),
                insertText: c.completionText,
                // filterText ensures Monaco matches against the full completion
                // text (e.g. "-Path") rather than just the display label
                // (e.g. "Path"), which would cause parameter suggestions to be
                // hidden when the trigger character "-" is already in the range.
                filterText: c.completionText,
                sortText: `${completionSortWeight(c.resultType)}_${(
                  c.listItemText || c.completionText
                ).toLowerCase()}`,
                detail: c.resultType,
                documentation: c.toolTip || undefined,
                range: completionRange,
              })),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      });
  }, [state.settings.enableIntelliSense]);

  // Handle content changes
  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!activeTab || value === undefined) return;
      const isDirty = value !== activeTab.savedContent;
      dispatch({
        type: "UPDATE_TAB",
        id: activeTab.id,
        changes: { content: value, isDirty },
      });

      // --- Feature 2: PSScriptAnalyzer squiggles (debounced 800 ms) ---
      if (pssaTimerRef.current !== null) clearTimeout(pssaTimerRef.current);

      // Clear any existing markers immediately when PSSA is disabled.
      if (!state.settings.enablePssa) {
        const ed = editorRef.current;
        const mon = monacoRef.current;
        if (ed && mon) {
          const model = ed.getModel();
          if (model) mon.editor.setModelMarkers(model, "pssa", []);
        }
        return;
      }

      // BUG-NEW-1 fix: capture editor, monaco instance, and model HERE (before the
      // timer fires) so a tab switch during the 800 ms debounce window cannot
      // cause this analysis result to be applied to a different tab's model.
      // Previously these refs were read inside the callback (at fire time), meaning
      // editorRef.current could already point to a newly-mounted editor for a
      // different tab by the time the async analysis completed.
      const ed = editorRef.current;
      const mon = monacoRef.current;
      const psPath = psPathRef.current;
      if (!ed || !mon || !psPath) return;
      const model = ed.getModel();
      if (!model) return;

      pssaTimerRef.current = setTimeout(() => {
        analyzeScript(psPath, value)
          .then((diags) => {
            const markers = diags.map((d) => ({
              severity: pssaSeverity(mon, d.severity),
              message: d.message,
              source: d.ruleName,
              startLineNumber: d.line,
              startColumn: d.column,
              endLineNumber: d.endLine > 0 ? d.endLine : d.line,
              endColumn: d.endColumn > 0 ? d.endColumn : d.column + 1,
            }));
            mon.editor.setModelMarkers(model, "pssa", markers);
          })
          .catch(() => {
            /* PSSA unavailable or script too complex -- ignore silently */
          });
      }, 800);
    },
    [activeTab, state.settings.enablePssa, dispatch],
  );

  if (!activeTab) {
    return (
      <div
        className="flex items-center justify-center h-full"
        style={{ color: "var(--text-muted)" }}
      >
        No file open. Press Ctrl+N to create a new file.
      </div>
    );
  }

  // Render the welcome screen for welcome tabs instead of Monaco.
  if (activeTab.tabType === "welcome") {
    return <WelcomePane />;
  }

  return (
    <Editor
      key={activeTab.id}
      height="100%"
      language={activeTab.language}
      value={activeTab.content}
      onChange={handleChange}
      beforeMount={handleBeforeMount}
      onMount={handleEditorMount}
      theme={monacoThemeName((state.settings.theme as ThemeName) || "dark")}
      options={{
        fontSize: state.settings.fontSize,
        fontFamily: state.settings.fontFamily,
        wordWrap: state.settings.wordWrap ? "on" : "off",
        minimap: { enabled: state.settings.showMinimap },
        lineNumbers: (state.settings.lineNumbers ?? "on") as
          | "on"
          | "off"
          | "relative",
        renderWhitespace: (state.settings.renderWhitespace ?? "selection") as
          | "none"
          | "selection"
          | "boundary"
          | "all",
        guides: { indentation: state.settings.showIndentGuides !== false },
        stickyScroll: { enabled: state.settings.stickyScroll === true },
        tabSize: state.settings.tabSize ?? 4,
        insertSpaces: state.settings.insertSpaces !== false,
        folding: true,
        bracketPairColorization: { enabled: true },
        renderLineHighlight: "line",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        smoothScrolling: true,
        // "phase" uses a CSS animation that shifts opacity in discrete steps
        // rather than a continuous transition.  In release-build WebView2 the
        // GPU compositor can suspend CSS transitions (breaking "smooth") and
        // can throttle rapid keyframe animations (breaking "blink"), but
        // step-based "phase" animations survive compositor throttling because
        // each step is a discrete paint rather than an interpolated one.
        cursorBlinking: "smooth",
        // Keep glyph margin enabled for line breakpoint toggles.
        glyphMargin: true,
        lineDecorationsWidth: 12,
        lineNumbersMinChars: 3,
        padding: { top: 8 },
        // Disable auto-accepting suggestions on commit characters (e.g. space).
        // Without this, typing "Get-ChildItem " would auto-insert the selected
        // cmdlet completion and close the suggest widget before the "-" trigger
        // fires, resulting in no parameter completions appearing.
        acceptSuggestionOnCommitCharacter: false,
      }}
      loading={
        <div
          className="flex items-center justify-center h-full"
          style={{ color: "var(--text-secondary)" }}
        >
          Loading editor...
        </div>
      }
    />
  );
}
