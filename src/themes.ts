/** PSForge theme utilities.
 *  Maps our CSS variable themes to Monaco editor themes. */

import type { ThemeName } from "./types";
import type { editor } from "monaco-editor";

/** Defines a Monaco theme that matches our CSS variable theme. */
export function getMonacoThemeData(
  theme: ThemeName,
): editor.IStandaloneThemeData {
  switch (theme) {
    case "light":
      return {
        base: "vs",
        inherit: true,
        rules: [
          // PowerShell token colours matching VS Code Light+ defaults.
          // Monaco PS grammar uses tokenPostfix ".ps1" and generates compound keyword
          // token names like "keyword.if.ps1" (3 segments: keyword → if → ps1).
          // Monaco's trie walks each segment in order; since there is no "if" child
          // under "keyword" in our rule set, the walk stops at "keyword".  We must
          // therefore use token:"keyword" (not "keyword.ps1") to override keyword colours.
          // Other token types are 2-segment ("variable.ps1", "string.ps1", etc.) and
          // can be matched exactly by their full dotted name.
          { token: "keyword", foreground: "0000ff" }, // blue (overrides vs base keyword rule)
          { token: "support.function", foreground: "795e26" }, // brown  – cmdlet Verb-Noun
          { token: "parameter.ps1", foreground: "0070c1" }, // blue  – -Parameter / -operator
          { token: "string.ps1", foreground: "a31515" }, // dark red
          { token: "comment.ps1", foreground: "008000" }, // green
          { token: "variable.ps1", foreground: "0070c1" }, // medium blue
          { token: "number.ps1", foreground: "098658" }, // dark green
          { token: "type.ps1", foreground: "267f99" }, // teal
        ],
        colors: {
          "editor.background": "#ffffff",
          "editor.foreground": "#333333",
          "editorLineNumber.foreground": "#999999",
          "editorCursor.foreground": "#0066b8",
          "editor.selectionBackground": "#add6ff",
          "editor.lineHighlightBackground": "#f5f5f5",
          "editorWidget.background": "#f3f3f3",
          "editorWidget.border": "#cecece",
        },
      };

    case "ise-classic":
      return {
        base: "vs-dark",
        inherit: true,
        rules: [
          // Monaco PS grammar produces compound keyword tokens like "keyword.if.ps1";
          // see dark theme comment for why "keyword" (not "keyword.ps1") is used.
          // Monaco PS grammar produces compound keyword tokens like "keyword.if.ps1";
          // see dark theme comment for why "keyword" (not "keyword.ps1") is used.
          { token: "keyword", foreground: "ffff00" }, // yellow (overrides vs-dark keyword rule)
          { token: "support.function", foreground: "ffffff" }, // white  – cmdlet Verb-Noun (ISE)
          { token: "parameter.ps1", foreground: "9bdedf" }, // pale cyan – -Parameter / -operator
          { token: "string.ps1", foreground: "00ffff" }, // cyan
          { token: "comment.ps1", foreground: "00aa00" }, // green
          { token: "variable.ps1", foreground: "ff8000" }, // orange
          { token: "number.ps1", foreground: "e000e0" }, // magenta
          { token: "type.ps1", foreground: "8080ff" }, // light blue
        ],
        colors: {
          "editor.background": "#012456",
          "editor.foreground": "#eeedf0",
          "editorLineNumber.foreground": "#7070a0",
          "editorCursor.foreground": "#ffff00",
          "editor.selectionBackground": "#264f78",
          "editor.lineHighlightBackground": "#01356e",
          "editorWidget.background": "#01184a",
          "editorWidget.border": "#01356e",
        },
      };

    case "dark":
    default:
      return {
        base: "vs-dark",
        inherit: true,
        rules: [
          // PowerShell token colours matching VS Code Dark+ defaults.
          // Monaco PS grammar produces compound keyword tokens like "keyword.if.ps1";
          // the trie walk for "keyword.if.ps1" (segments: keyword → if → ps1) stops
          // at "keyword" because there is no "if" child.  Use token:"keyword" to
          // override keyword colours at that node.  Other PS1 tokens are 2-segment
          // ("variable.ps1", etc.) and match exactly.
          // PowerShell token colours matching VS Code Dark+ defaults.
          // Monaco PS grammar produces compound keyword tokens like "keyword.if.ps1";
          // the trie walk for "keyword.if.ps1" (segments: keyword → if → ps1) stops
          // at "keyword" because there is no "if" child.  Use token:"keyword" to
          // override keyword colours at that node.  Other PS1 tokens are 2-segment
          // ("variable.ps1", etc.) and match exactly.
          { token: "keyword", foreground: "569cd6" }, // blue        #569cd6
          { token: "support.function", foreground: "dcdcaa" }, // yellow     #dcdcaa – cmdlet Verb-Noun
          { token: "parameter.ps1", foreground: "9cdcfe" }, // light blue #9cdcfe – -Parameter / -operator
          { token: "string.ps1", foreground: "ce9178" }, // orange     #ce9178
          { token: "comment.ps1", foreground: "6a9955" }, // green      #6a9955
          { token: "variable.ps1", foreground: "9cdcfe" }, // light blue #9cdcfe
          { token: "number.ps1", foreground: "b5cea8" }, // light green #b5cea8
          { token: "type.ps1", foreground: "4ec9b0" }, // teal       #4ec9b0
        ],
        colors: {
          "editor.background": "#1e1e1e",
          "editor.foreground": "#d4d4d4",
          "editorLineNumber.foreground": "#858585",
          "editorCursor.foreground": "#d4d4d4",
          "editor.selectionBackground": "#264f78",
          "editor.lineHighlightBackground": "#2a2d2e",
          "editorWidget.background": "#252526",
          "editorWidget.border": "#3c3c3c",
        },
      };
  }
}

/** Returns the Monaco theme name string for our theme. */
export function monacoThemeName(theme: ThemeName): string {
  return `psforge-${theme}`;
}
