/**
 * The corpus artifact is a snapshot of real sessions on one machine, so its
 * absolute numbers will move every time it is regenerated. What must NOT move
 * is internal consistency: the aggregate has to equal the sum of the rows, the
 * percentages have to follow from the counts, and the coverage invariant has to
 * hold for every session. If any of those fail, the artifact is wrong no matter
 * which machine produced it.
 */
import { readFileSync } from "node:fs";

const raw = readFileSync("results/corpus.json", "utf8");
const corpus = JSON.parse(raw);

const fail = (msg: string): never => {
  console.error("corpus integrity FAILED:", msg);
  process.exit(1);
};

const sessions = corpus.sessions ?? [];
if (sessions.length === 0) fail("no session rows in the artifact");

// 1. Row count matches the declared count.
if (sessions.length !== corpus.counts.withFolds) {
  fail(`artifact has ${sessions.length} rows but counts.withFolds says ${corpus.counts.withFolds}`);
}

// 2. Aggregates are the sum of the rows, not separately asserted numbers.
// Aggregate names differ from row field names, so the mapping is explicit.
const AGGREGATE_TO_ROW = {
  foldOperations: "folds",
  netTokensRemoved: "netSaving",
  distinctRePrefill: "distinctRePrefill",
  foldsAtOrAboveCost: "foldsAtOrAboveCost",
  unaccountedSurfaceNodes: "unaccountedNodes",
  windowRequestsJudged: "windowJudged",
  windowHardViolations: "windowHardViolations",
  windowBudgetMisses: "windowBudgetMisses",
};
for (const [aggregate, field] of Object.entries(AGGREGATE_TO_ROW)) {
  const computed = sessions.reduce((a, s) => a + (s[field] ?? 0), 0);
  if (corpus.corpus[aggregate] !== computed) {
    fail(`${aggregate}: aggregate ${corpus.corpus[aggregate]} != sum of rows ${computed}`);
  }
}

// sessionsNetNegative is a count of sessions, not a sum.
const netNegative = sessions.filter((s) => s.netSaving < s.distinctRePrefill).length;
if (corpus.corpus.sessionsNetNegative !== netNegative) {
  fail(`sessionsNetNegative: ${corpus.corpus.sessionsNetNegative} != ${netNegative} rows below their cost`);
}

// The largest prompt share is a max over rows, not a sum.
const maxShare = Math.max(...sessions.map((s) => s.maxPromptShareOfWindow ?? 0));
if (Math.abs(corpus.corpus.largestPromptShareOfWindow - maxShare) > 1e-9) {
  fail(`largestPromptShareOfWindow: ${corpus.corpus.largestPromptShareOfWindow} != max of rows ${maxShare}`);
}

// The window histogram must account for every judged request, in both
// directions: per row and corpus-wide.
for (const s of sessions) {
  const b = s.windowShares ?? [];
  if (b.reduce((a, v) => a + v, 0) !== s.windowJudged) {
    fail(`${s.ref}: window histogram sums to ${b.reduce((a, v) => a + v, 0)} but ${s.windowJudged} requests were judged`);
  }
}
const histogramTotal = (corpus.corpus.windowShareHistogram ?? []).reduce((a, v) => a + v, 0);
if (histogramTotal !== corpus.corpus.windowRequestsJudged) {
  fail(`windowShareHistogram sums to ${histogramTotal} but ${corpus.corpus.windowRequestsJudged} requests were judged`);
}

// 3. Every session row is internally consistent.
for (const s of sessions) {
  if (s.shadowedNodes > s.everPlaced) {
    fail(`${s.ref}: shadowed ${s.shadowedNodes} exceeds ever placed ${s.everPlaced}`);
  }
  if (s.unaccountedNodes !== 0) {
    fail(`${s.ref}: ${s.unaccountedNodes} turns are neither on the surface nor inside a fold span`);
  }
  if (s.summariserInput > 0 && s.totalTokenCost < s.summariserInput) {
    fail(`${s.ref}: total cost ${s.totalTokenCost} is smaller than its own summariser input ${s.summariserInput}`);
  }
  if (s.marginalRePrefill > s.distinctRePrefill) {
    fail(`${s.ref}: marginal re-prefill ${s.marginalRePrefill} exceeds the upper bound ${s.distinctRePrefill}`);
  }
  if (s.ledgerDetailDropped > 0 && s.foldsAtOrAboveCost > s.folds - s.ledgerDetailDropped) {
    fail(`${s.ref}: nested count exceeds the retained ledger detail`);
  }
}

// 4. Privacy: the artifact must not carry host paths.
if (raw.includes("/home/")) fail("artifact contains an absolute host path");

console.log(
  `corpus integrity OK: ${sessions.length} sessions, ` +
  `${corpus.corpus.foldOperations.toLocaleString()} fold operations, ` +
  `${corpus.corpus.unaccountedSurfaceNodes} unaccounted turns, ` +
  `aggregations reconcile with row sums`
);
