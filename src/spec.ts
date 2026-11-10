/**
 * The six properties. Each is a load-bearing adjective used by context
 * compaction systems, turned into arithmetic.
 *
 * A backend passes a property only if the measurement proves it. There are no
 * partial credit rules: a system that loses 3 turns out of 8,000 fails
 * "no silent loss" exactly as one that loses 1,326 does.
 */

export type PropertyId =
  | "no_silent_loss"
  | "window_discipline"
  | "convergence"
  | "race_safety"
  | "anchor_retention"
  | "cost_honesty";

export interface PropertyResult {
  id: PropertyId;
  name: string;
  passed: boolean;
  measured: number;
  threshold: number;
  detail: string;
}

export interface FoldRecord {
  id: string;
  kind: "observation" | "reflection" | "truncation";
  startSeq: number;
  endSeq: number;
  originalTokens: number;
  compactedTokens: number;
  /** Tokens re-prefilled on the next request because this fold moved the prefix. */
  cacheBustTokens: number;
  anchors: string[];
  /** How the removed content stays reachable. null means it is not. */
  preservedBy: "verbatim-tail" | "named-span" | "archive-pointer" | null;
  /** Where to look it up. A preservation claim without a pointer is unproven. */
  archivePointer: string | null;
  /** Hash of the exact span removed. Lets a ledger verify the claim externally. */
  spanDigest: string | null;
  trigger: string;
  actor: "background" | "synchronous";
}

export interface AuditReport {
  backend: string;
  runs: number;
  window: number;
  /** Coverage units. One unit is one conversation step placed on the surface
   *  (a user turn and its reply), so a run of 3,000 turns yields ~6,000 units.
   *  Named `turnUnits`, not `turns`, so the number is never read as a turn count. */
  turnUnits: number;
  peakPromptTokens: number;
  peakAuxPromptTokens: number;
  finalPromptTokens: number;
  foldCount: number;
  /** What the backend itself says it folded. Kept separate from the ledger
   *  length so a disagreement is visible instead of silently reconciled. */
  foldCountClaimed: number;
  foldRecords: FoldRecord[];
  /** Every prompt the backend actually sent, with its prefix-cache accounting. */
  promptRecords: { kind: string; tokens: number; cached: number; rePrefill: number }[];
  reflections: number;
  observerCalls: number;
  silentLoss: number;
  doubleCounted: number;
  anchorsSeeded: number;
  anchorsSurviving: number;
  prefixRewrites: number;
  rePrefillTokens: number;
  cacheReadTokens: number;
  newContentTokens: number;
  tokensSaved: number;
  tokensSavedClaimed: number;
  wallSeconds: number;
  effectiveTps: number;
  properties: PropertyResult[];
  score: number; // passed / 6
}

export const PROPERTY_NAMES: Record<PropertyId, string> = {
  no_silent_loss: "No silent loss — every turn is verbatim, inside a named fold, or addressable in an archive",
  window_discipline: "Window discipline — no request is ever constructed over the declared window",
  convergence: "Convergence — a fold actually reduces pressure below the trigger",
  race_safety: "Race safety — turns appended while a fold is in flight are neither lost nor duplicated",
  anchor_retention: "Anchor retention — seeded verbatim facts survive the fold",
  cost_honesty: "Cost honesty — tokens saved exceed the prefix rewrites the fold caused",
};

export function score(report: AuditReport): number {
  return report.properties.filter((p) => p.passed).length;
}

export function format(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`backend: ${report.backend}`);
  lines.push(`  window ${report.window.toLocaleString()} | units ${report.turnUnits.toLocaleString()}`);
  lines.push(`  peak prompt ${report.peakPromptTokens.toLocaleString()} | folds ${report.foldCount}`);
  for (const p of report.properties) {
    lines.push(
      `  ${p.passed ? "PASS" : "FAIL"}  ${p.id.padEnd(17)} ${p.measured.toLocaleString()} (limit ${p.threshold.toLocaleString()}) — ${p.detail}`
    );
  }
  lines.push(`  score: ${score(report)}/6`);
  return lines.join("\n");
}
