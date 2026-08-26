/** Fix All — one diagnostic per AI call, re-analyze between passes. */

import type { AppSettings, PssaDiagnostic } from "./types";
import { analyzeScript } from "./commands";
import {
  applyAiFix,
  buildFixProblemQuestion,
  diagnosticToTarget,
  prioritizeDiagnostics,
  type ApplyAiFixRequest,
  type ApplyAiFixResult,
} from "./fix-problem";

/** Stable identity for a problem across re-analysis (line numbers move). */
export function diagnosticKey(diagnostic: PssaDiagnostic): string {
  return `${diagnostic.severity}\0${diagnostic.ruleName}\0${diagnostic.message}`;
}

/** Hard cap so Fix All cannot loop forever against stubborn diagnostics. */
export const MAX_FIX_ALL_PASSES = 25;

export interface FixAllSequentialProgress {
  pass: number;
  maxPasses: number;
  problemLabel: string;
  fixedSoFar: number;
  skippedSoFar: number;
  remainingEstimate: number;
}

export interface FixAllSequentialResult {
  script: string;
  fixedCount: number;
  skippedCount: number;
  remainingCount: number;
  cancelled: boolean;
  lastToast: string;
}

export interface FixAllSequentialDeps {
  applyFix: (request: ApplyAiFixRequest) => Promise<ApplyAiFixResult>;
  analyze: (psPath: string, script: string) => Promise<PssaDiagnostic[]>;
}

/**
 * Fix All one diagnostic at a time (highest priority first), re-analyzing after
 * each successful edit. Avoids one huge AI call that times out or overflows.
 */
export async function fixAllProblemsSequentially(args: {
  diagnostics: PssaDiagnostic[];
  script: string;
  scriptPath: string;
  psPath: string;
  settings: AppSettings;
  terminalOutput?: string;
  maxPasses?: number;
  shouldCancel?: () => boolean;
  onProgress?: (progress: FixAllSequentialProgress) => void;
  onScriptUpdated?: (script: string) => void;
  deps?: Partial<FixAllSequentialDeps>;
}): Promise<FixAllSequentialResult> {
  const applyFix = args.deps?.applyFix ?? applyAiFix;
  const analyze = args.deps?.analyze ?? analyzeScript;
  const maxPasses = Math.max(
    1,
    Math.min(args.maxPasses ?? MAX_FIX_ALL_PASSES, MAX_FIX_ALL_PASSES),
  );

  let script = args.script;
  let remaining = prioritizeDiagnostics(args.diagnostics);
  const skipped = new Set<string>();
  let fixedCount = 0;
  let skippedCount = 0;
  let lastToast = "";
  let cancelled = false;

  const nextOpen = (): PssaDiagnostic | undefined =>
    remaining.find((d) => !skipped.has(diagnosticKey(d)));

  for (let pass = 1; pass <= maxPasses; pass++) {
    if (args.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const target = nextOpen();
    if (!target) break;

    const key = diagnosticKey(target);
    const label = `line ${target.line}: ${target.message.slice(0, 80)}`;
    args.onProgress?.({
      pass,
      maxPasses,
      problemLabel: label,
      fixedSoFar: fixedCount,
      skippedSoFar: skippedCount,
      remainingEstimate: remaining.filter((d) => !skipped.has(diagnosticKey(d)))
        .length,
    });

    const { question, diagnostics } = buildFixProblemQuestion(
      diagnosticToTarget(target),
    );
    const result = await applyFix({
      settings: args.settings,
      question,
      diagnostics,
      script,
      scriptPath: args.scriptPath,
      terminalOutput: args.terminalOutput ?? "",
    });
    lastToast = result.toast;

    if (args.shouldCancel?.()) {
      cancelled = true;
      break;
    }

    if (!result.ok || !result.code) {
      skipped.add(key);
      skippedCount += 1;
      continue;
    }

    script = result.code;
    args.onScriptUpdated?.(script);

    let after: PssaDiagnostic[];
    try {
      after = prioritizeDiagnostics(await analyze(args.psPath, script));
    } catch {
      // Analyzer failure: keep the edit; stop looping so we do not thrash.
      remaining = [];
      fixedCount += 1;
      break;
    }

    const stillPresent = after.some((d) => diagnosticKey(d) === key);
    if (stillPresent) {
      skipped.add(key);
      skippedCount += 1;
    } else {
      fixedCount += 1;
    }
    remaining = after;
  }

  const remainingCount = remaining.filter(
    (d) => !skipped.has(diagnosticKey(d)),
  ).length;

  return {
    script,
    fixedCount,
    skippedCount,
    remainingCount,
    cancelled,
    lastToast,
  };
}

/** Short status line for toasts / AI pane after a sequential Fix All. */
export function formatFixAllSequentialSummary(
  result: FixAllSequentialResult,
): string {
  const parts = [`Fixed ${result.fixedCount}`];
  if (result.skippedCount > 0) parts.push(`skipped ${result.skippedCount}`);
  if (result.remainingCount > 0) parts.push(`${result.remainingCount} left`);
  if (result.cancelled) parts.push("cancelled");
  return parts.join(" · ");
}
