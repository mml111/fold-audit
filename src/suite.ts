import { Counter, Recorder, buildSession, seedAnchors, anchorSurvives, evaluate } from "./engine.ts";
import type { Backend } from "./backend.ts";
import type { AuditReport } from "./spec.ts";

export interface AuditOptions {
  window: number;
  turns: number;
  turnTokens: number;
  /** A single oversized tool result dropped in without warning. */
  giantTurn?: number;
}

/**
 * Simulated wall time. Every request costs (re-prefill + output) tokens; the
 * cached prefix is free. This is how the audit turns "background compaction is
 * free because it runs in parallel" into a number.
 */
function simulatedSeconds(rec: Recorder, tps = 60): number {
  let s = 0;
  for (const p of rec.prompts) s += p.rePrefill / tps;
  return s;
}

export async function audit(
  make: (rec: Recorder, counter: Counter, window: number) => Backend,
  opts: AuditOptions
): Promise<AuditReport> {
  const counter = new Counter();
  const rec = new Recorder(counter);
  const backend = make(rec, counter, opts.window);
  const session = buildSession({ turns: opts.turns, turnTokens: opts.turnTokens, anchorEvery: 7 });
  const anchors = seedAnchors(session);

  let newContent = 0;
  for (let i = 0; i < session.length; i++) {
    newContent += counter.count(session[i].user);
    await backend.turn(session[i].user);
    newContent += 20; // the actor's reply, which the backend generates
    // Yield to the timer queue. Without this, a loop of immediately-resolving
    // promises starves setTimeout and background fold jobs never run — an
    // artifact of the harness, not of the backend. The naive control must fail
    // for its own reason, not because we starved it.
    await new Promise((r) => setImmediate(r));
    if (opts.giantTurn && i === Math.floor(session.length / 2)) {
      const giant = "y".repeat(opts.giantTurn * 4);
      newContent += counter.count(giant);
      await backend.turn(giant);
    }
  }
  await backend.settled();

  const final = backend.prompt();
  const surviving = anchors.filter((a) => anchorSurvives(final, a, (q) => backend.recall(q)));
  const cov = backend.coverage();

  let rewrites = 0;
  let prevMain = 0;
  let observedSavings = 0;
  for (const p of rec.prompts) {
    if (p.kind !== "main") continue;
    if (prevMain > 0 && p.cached < prevMain) rewrites++;
    if (prevMain > p.tokens) observedSavings += prevMain - p.tokens;
    prevMain = p.tokens;
  }

  const report: AuditReport = {
    backend: backend.name,
    runs: session.length,
    window: opts.window,
    turnUnits: cov.total,
    peakPromptTokens: rec.peak("main"),
    peakAuxPromptTokens: Math.max(0, rec.peak("observer"), rec.peak("reflector")),
    finalPromptTokens: counter.countMessages(final),
    foldCount: typeof backend.foldLedger === "function" ? backend.foldLedger().length : backend.folds(),
    foldCountClaimed: backend.folds(),
    foldRecords: typeof backend.foldLedger === "function" ? backend.foldLedger() : [],
    promptRecords: typeof backend.promptRecords === "function" ? backend.promptRecords() : [],
    reflections: backend.reflections(),
    observerCalls: rec.prompts.filter((p) => p.kind !== "main").length,
    silentLoss: cov.lost,
    doubleCounted: cov.doubleCounted,
    anchorsSeeded: anchors.length,
    anchorsSurviving: surviving.length,
    prefixRewrites: rewrites,
    rePrefillTokens: rec.totalRePrefill,
    cacheReadTokens: rec.totalCacheRead,
    newContentTokens: newContent,
    // Savings are measured from the rendered prompts, not reported by the
    // backend: the reduction in main-request size at each step. A backend that
    // claims savings it did not produce is caught here.
    tokensSaved: observedSavings,
    tokensSavedClaimed: backend.tokensSaved(),
    wallSeconds: simulatedSeconds(rec),
    effectiveTps: 0,
    properties: [],
  };
  const totalWork = report.rePrefillTokens + counter.countMessages(final) * 0;
  report.effectiveTps = report.wallSeconds ? Math.round((report.rePrefillTokens + 40 * rec.calls) / report.wallSeconds) : 0;
  void totalWork;
  report.properties = evaluate(report);
  return report;
}
