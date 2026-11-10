/**
 * Audits Mastra's Observational Memory through the fold-audit harness.
 *
 * Run:
 *   cd /home/matt/fold-audit && node --experimental-strip-types tests/mastra.test.ts
 * Controls:
 *   ... --sync                      observation without async buffering (bufferTokens: false)
 *   ... --turns 400 --window 40000
 *   ... --report results/mastra.json
 * Exits 0 only if all six properties pass.
 */

import { writeFileSync } from "node:fs";
import { Recorder } from "../src/engine.ts";
import { audit } from "../src/suite.ts";
import { format, score } from "../src/spec.ts";
import type { AuditReport } from "../src/spec.ts";
import { MastraObservationalMemoryBackend } from "../src/adapters/mastra.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

const TURNS = Number(arg("turns", "200"));
const TURN_TOKENS = Number(arg("turnTokens", "1000"));
const WINDOW = Number(arg("window", "20000"));
const SYNC = arg("sync", "false") === "true";
const SHARE_BUDGET = arg("share-budget", "false") === "true";
const REFLECT_TOKENS = Number(arg("reflect", "0")) || undefined;
const REPORT = arg("report", "");

let backend: MastraObservationalMemoryBackend | null = null;
let rec: Recorder | null = null;

const report: AuditReport = await audit(
  (r, _counter, window) => {
    rec = r;
    backend = new MastraObservationalMemoryBackend(r, {
      window,
      // explicit: OM's observation trigger is the declared window
      messageTokens: window,
      retrieval: true,
      bufferTokens: SYNC ? false : Math.floor(window * 0.2),
      reflectionTokens: REFLECT_TOKENS,
    });
    return backend;
  },
  { window: WINDOW, turns: TURNS, turnTokens: TURN_TOKENS }
);

console.log("=== mastra observational memory audit ===");
console.log("versions: @mastra/core 1.82.0, @mastra/memory 1.41.0 | storage InMemoryStore (supportsObservationalMemory=" + (await backend!.verifyStorage()) + ")");
console.log("config: turns=" + TURNS + " turnTokens=" + TURN_TOKENS + " window=" + WINDOW + " observation.messageTokens=" + WINDOW + " bufferTokens=" + (SYNC ? "false" : Math.floor(WINDOW * 0.2)));
console.log("");
console.log(format(report));
console.log("");

if (backend && rec) {
  const coverage = backend.coverage();
  const detail = backend.detail();
  const composition = backend.promptComposition();
  const mainPrompts = rec.prompts.filter((p) => p.kind === "main");
  const peak = mainPrompts.reduce((a, p) => (p.tokens > a.tokens ? p : a), mainPrompts[0]);

  const anatomy = (msgs: { role: string; content: string }[]) => {
    let raw = 0, obs = 0, instr = 0;
    for (const m of msgs) {
      const t = rec.counter.count(m.content);
      if (m.content.includes("<observations>") || m.content.includes("## Group `")) obs += t;
      else if (m.role === "system") instr += t;
      else raw += t;
    }
    return { raw, obs, instr };
  };

  const snapshot = backend.peakSnapshot();

  console.log("coverage: total=%d verbatim=%d folded=%d lost=%d doubleCounted=%d",
    coverage.total, coverage.verbatim, coverage.folded, coverage.lost, coverage.doubleCounted);
  console.log("OM internals: observationCycles=%d reflectionCycles=%d generations=%d observationGroups=%d",
    detail.observationCycles, detail.reflectionCycles, detail.generations, detail.observationGroups);
  console.log("model calls: actor=%d observer=%d reflector=%d", detail.actorCalls, detail.observerCalls, detail.reflectorCalls);
  const aux = rec.prompts.filter((p) => p.kind !== "main");
  console.log("aux prompt tokens: total=%d peak=%d mean=%d",
    aux.reduce((a, p) => a + p.tokens, 0), aux.reduce((a, p) => Math.max(a, p.tokens), 0), aux.length ? Math.round(aux.reduce((a, p) => a + p.tokens, 0) / aux.length) : 0);
  console.log("prompt sizes: peak main=%d peak aux=%d final=%d window=%d", report.peakPromptTokens, report.peakAuxPromptTokens, report.finalPromptTokens, WINDOW);
  console.log("peak prompt anatomy: raw messages=%d observation block=%d instructions=%d",
    anatomy(peak.messages).raw, anatomy(peak.messages).obs, anatomy(peak.messages).instr);
  console.log("peak prompt in Mastra's own units (tokenx): %d tokens (threshold %d)",
    await backend.mastraTokens(peak.messages), WINDOW);
  console.log("final prompt in Mastra's own units (tokenx): %d tokens",
    await backend.mastraTokens(backend.prompt()));
  console.log("final prompt composition: instruction=%d observations=%d raw tail=%d messages=%d",
    composition.instruction, composition.observations, composition.rawTail, composition.messages);
  console.log("");
  console.log("first 300 chars of the last actor prompt:");
  console.log(backend.prompt().map((m) => `[${m.role}] ${m.content.slice(0, 120)}`).join("\n").slice(0, 600));
  const ledger = backend.foldLedger();
  const sum = (k: string) => ledger.reduce((a, f) => a + (f[k] as number), 0);
  console.log("fold ledger: rows=%d originalTokens=%d compactedTokens=%d cacheBustTokens=%d",
    ledger.length, sum("originalTokens"), sum("compactedTokens"), sum("cacheBustTokens"));
  const pres = backend.preservation();
  console.log("preservation of folded messages: rawStillInTable=%d contentInSummary=%d unrecoverable=%d of %d folded",
    pres.rawStillInTable, pres.contentInSummary, pres.unrecoverable, pres.folded);
  const ledgerImplied = sum("originalTokens") - sum("compactedTokens");
  console.log("ledger-implied saving (sum original - sum compacted)=%d vs measured prompt shrink=%d; delta=%d (instructions and the growing observation block are not in the ledger)",
    ledgerImplied, report.tokensSaved, ledgerImplied - report.tokensSaved);
  console.log("observation ranges that could not be mapped to a turn: %d", backend.rangeResolutionGaps());
  const ov = backend.overlapDetail();
  console.log("range overlap detail: ranges=%d messagesClaimedTwice=%d ofWhichAlsoVerbatim=%d",
    ov.distinctRanges, ov.claimedTwice, ov.claimedTwiceAndVerbatim);
  console.log("");
  console.log("UNIT MISMATCH (report both, do not conflate): OM thresholds are in Mastra's tokenx units, the audit counts len/4.");
  console.log("  at the peak turn: harness-counted prompt=%d tokens, of which raw messages=%d; Mastra's own pending estimate=%d (threshold %d)",
    snapshot.harness, snapshot.rawTail, snapshot.mastraPending, snapshot.threshold);
  console.log("tokensSaved (context removed by folds, fixture definition)=%d", report.tokensSaved);
  console.log("tokensNeverSent (cumulative raw history absent from prompts; NOT comparable to fixtures)=%d", backend.tokensNeverSent());
  console.log("rePrefillTokens=%d newContentTokens=%d cacheReadTokens=%d", report.rePrefillTokens, report.newContentTokens, report.cacheReadTokens);
}

if (REPORT) {
  const b = backend!;
  writeFileSync(REPORT, JSON.stringify({
    generated: new Date().toISOString(),
    window: WINDOW,
    turns: TURNS,
    turnTokens: TURN_TOKENS,
    config: {
      observationalMemory: true,
      messageTokens: WINDOW,
      bufferTokens: SYNC ? false : Math.floor(WINDOW * 0.2),
      mockModel: true,
      storage: "InMemoryStore",
    },
    notes: [
      "fixture-limited: the Observer and Reflector are deterministic mock LanguageModelV2 models with no real summarisation. This measures Mastra's observation/activation plumbing and its context arithmetic, not the quality of OM's compression in production. Do not generalise it to 'Mastra loses context in production'.",
      "coverage() is derived from the prompts captured at the model boundary by the Recorder, not from Mastra's internal counters. The unit is a message (user turn + actor reply), the same unit the naive/reference fixtures use.",
      "a turn is folded when it is absent from the rendered prompt but still accounted for by an observation group range Mastra exposes or still present in Mastra's message table; lost only when neither is true. `preservation` separates 'has a pointer' from 'the original bytes are still retrievable': in this fixture every folded message was still readable in the live message table, and none of its content appeared in the (mock) summary text.",
      "doubleCounted counts messages that are verbatim in the prompt AND inside an observation group range. Measured at 0 here: the raw retention tail and the committed observation ranges do not overlap in this fixture.",
      "tokensSaved uses the fixtures' definition: the sum of observed reductions in rendered prompt size at fold moments. tokensNeverSent is a different, much larger quantity and is reported separately, never used in the score.",
      "window_discipline is measured in the audit's token units (len/4). Mastra's own tokenx estimate for the same prompt at the same instant is reported separately; the two differ by ~0.73x and must not be conflated.",
    ],
    mastraCounters: { ...b.detail(), perTurnPrompts: undefined },
    auxPromptTokens: rec.prompts.filter((p) => p.kind !== "main").reduce((a, p) => a + p.tokens, 0),
    promptComposition: b.promptComposition(),
    preservation: b.preservation(),
    rangeResolutionGaps: b.rangeResolutionGaps(),
    tokensNeverSent: b.tokensNeverSent(),
    reports: [report],
  }, null, 2));
  console.log("wrote " + REPORT);
}

if (backend!.folds() === 0) {
  console.error("\nFAIL: observational memory never ran (folds == 0)");
  process.exit(1);
}

const failed = report.properties.filter((p) => !p.passed);
if (failed.length > 0) {
  console.error("\nFAILED PROPERTIES: " + failed.map((p) => p.id).join(", "));
  process.exit(1);
}
console.log("\nall six properties passed");
