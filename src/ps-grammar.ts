/** PSForge PowerShell Monarch grammar extension.
 *
 *  This module re-declares the Monaco built-in PowerShell Monarch grammar and
 *  adds two token types not present in the upstream grammar:
 *
 *   - `support.function`  cmdlet names (Verb-Noun identifiers, e.g. Write-Host)
 *   - `parameter`         named parameters (-Path, -Recurse, -eq, -like …)
 *
 *  The upstream grammar assigns an empty-string token to all non-keyword
 *  identifiers (they render in the editor foreground colour).  By intercepting
 *  Verb-Noun identifiers and -flag tokens before the generic identifier rule we
 *  can apply distinct colours to them.
 *
 *  The object returned here is passed directly to
 *  `monaco.languages.setMonarchTokensProvider("powershell", ...)` in
 *  EditorPane.tsx's beforeMount handler, replacing the built-in grammar.
 *
 *  IMPORTANT — keep in sync with:
 *    node_modules/monaco-editor/esm/vs/basic-languages/powershell/powershell.js
 *  The upstream grammar was last reviewed against monaco-editor@0.52.x.
 */

/**
 * Returns the extended PowerShell Monarch grammar suitable for passing to
 * `monaco.languages.setMonarchTokensProvider`.
 *
 * Returns a plain object so that Monaco can mutate it internally without
 * touching the module-level definition.
 */
export function getPsMonarchGrammar(): object {
  return {
    defaultToken: "",
    ignoreCase: true,
    tokenPostfix: ".ps1",

    brackets: [
      { token: "delimiter.curly", open: "{", close: "}" },
      { token: "delimiter.square", open: "[", close: "]" },
      { token: "delimiter.parenthesis", open: "(", close: ")" },
    ],

    // PS control-flow / structural keywords (identical to upstream list).
    keywords: [
      "begin",
      "break",
      "catch",
      "class",
      "continue",
      "data",
      "define",
      "do",
      "dynamicparam",
      "else",
      "elseif",
      "end",
      "exit",
      "filter",
      "finally",
      "for",
      "foreach",
      "from",
      "function",
      "if",
      "in",
      "param",
      "process",
      "return",
      "switch",
      "throw",
      "trap",
      "try",
      "until",
      "using",
      "var",
      "while",
      "workflow",
      "parallel",
      "sequence",
      "inlinescript",
      "configuration",
    ],

    // Regex for recognising .SYNOPSIS / .DESCRIPTION etc. inside block comments.
    helpKeywords:
      /SYNOPSIS|DESCRIPTION|PARAMETER|EXAMPLE|INPUTS|OUTPUTS|NOTES|LINK|COMPONENT|ROLE|FUNCTIONALITY|FORWARDHELPTARGETNAME|FORWARDHELPCATEGORY|REMOTEHELPRUNSPACE|EXTERNALHELP/,

    symbols: /[=><!~?&%|+\-*\/\^;\.,]+/,

    escapes:
      /`(?:[abfnrtv\\"'$]|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [
        // ── PSForge extensions ──────────────────────────────────────────────
        //
        // Parameters / operators: -Name, -eq, -like, -Path, etc.
        // Must come before @symbols so that the leading hyphen is consumed as
        // part of the parameter token rather than as a standalone delimiter.
        [/\-[a-zA-Z][a-zA-Z0-9]*/, "parameter"],

        // Cmdlet names: Verb-Noun pattern.  Must come before the generic
        // identifier rule so that e.g. "Write-Host" is captured here rather
        // than matched as a plain identifier.
        // Allows multi-segment names (New-NetFirewallRule, Out-GridView, etc.)
        // but stops before a trailing hyphen (handled by the parameter rule).
        [/[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z][a-zA-Z0-9]*)+/, "support.function"],

        // ── Upstream rules (unchanged) ──────────────────────────────────────

        // Keywords and plain identifiers.
        [
          /[a-zA-Z_][\w-]*/,
          { cases: { "@keywords": "keyword.$0", "@default": "" } },
        ],

        // Whitespace.
        [/[ \t\r\n]+/, ""],

        // Labels.
        [/^:\w*/, "metatag"],

        // Variables: $name, ${name}, ${scope:name}.
        [
          /\$(\{((global|local|private|script|using):)?[\w]+\}|((global|local|private|script|using):)?[\w]+)/,
          "variable",
        ],

        // Comments.
        [/<#/, "comment", "@comment"],
        [/#.*$/, "comment"],

        // Delimiters.
        [/[{}()\[\]]/, "@brackets"],
        [/@symbols/, "delimiter"],

        // Numbers.
        [/\d*\.\d+([eE][\-+]?\d+)?/, "number.float"],
        [/0[xX][0-9a-fA-F_]*[0-9a-fA-F]/, "number.hex"],
        [/\d+?/, "number"],

        // Delimiter after number (because of .\d floats above).
        [/[;,.]/, "delimiter"],

        // Strings.
        [/\@"/, "string", '@herestring."'],
        [/\@'/, "string", "@herestring.'"],
        [
          /"/,
          {
            cases: {
              "@eos": "string",
              "@default": { token: "string", next: '@string."' },
            },
          },
        ],
        [
          /'/,
          {
            cases: {
              "@eos": "string",
              "@default": { token: "string", next: "@string.'" },
            },
          },
        ],
      ],

      string: [
        [
          /[^"'\$`]+/,
          {
            cases: {
              "@eos": { token: "string", next: "@popall" },
              "@default": "string",
            },
          },
        ],
        [
          /@escapes/,
          {
            cases: {
              "@eos": { token: "string.escape", next: "@popall" },
              "@default": "string.escape",
            },
          },
        ],
        [
          /`./,
          {
            cases: {
              "@eos": { token: "string.escape.invalid", next: "@popall" },
              "@default": "string.escape.invalid",
            },
          },
        ],
        [
          /\$[\w]+$/,
          {
            cases: {
              '$S2=="': { token: "variable", next: "@popall" },
              "@default": { token: "string", next: "@popall" },
            },
          },
        ],
        [
          /\$[\w]+/,
          {
            cases: {
              '$S2=="': "variable",
              "@default": "string",
            },
          },
        ],
        [
          /["']/,
          {
            cases: {
              "$#==$S2": { token: "string", next: "@pop" },
              "@default": {
                cases: {
                  "@eos": { token: "string", next: "@popall" },
                  "@default": "string",
                },
              },
            },
          },
        ],
      ],

      herestring: [
        [
          /^\s*(["'])@/,
          {
            cases: {
              "$1==$S2": { token: "string", next: "@pop" },
              "@default": "string",
            },
          },
        ],
        [/[^\$`]+/, "string"],
        [/@escapes/, "string.escape"],
        [/`./, "string.escape.invalid"],
        [
          /\$[\w]+/,
          {
            cases: {
              '$S2=="': "variable",
              "@default": "string",
            },
          },
        ],
      ],

      comment: [
        [/[^#\.]+/, "comment"],
        [/#>/, "comment", "@pop"],
        [/(\.)(@helpKeywords)(?!\w)/, { token: "comment.keyword.$2" }],
        [/[\.#]/, "comment"],
      ],
    },
  };
}
