#!/usr/bin/env node
/**
 * Run the fold audit over every stored DSH session log on this machine.
 *
 * This is the only part of the project that measures a *shipping* compactor
 * rather than a fixture. It replays the durable event log exactly as the Host
 * does, folds the plugin's projection over it, and reports per-session and
 * corpus-wide numbers.
 *
 *   node scripts/corpus-audit.mjs --sessions /home/matt/.dsh/sessions --report results/corpus.json
 *
 * Requires `unzstd` on PATH.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { apply, Config } from "../dsh-plugin/index.js";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const sessionsRoot = arg("sessions", "/home/matt/.dsh/sessions");
const reportPath = arg("report", "");

/** The harness's own fixed-density estimator, copied so the stub matches the Host. */
function estimateMessage(message) {
  const blocks = message?.content ?? [];
  let tokens = 0;
  for (const block of blocks) {
    if (block.type === "text" || block.type === "reasoning") tokens += Math.ceil(block.text.length / 4) + 4;
    else if (block.type === "tool-call") tokens += Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4) + 4;
    else tokens += 4 + Math.ceil(JSON.stringify(block).length / 4);
  }
  return tokens + 4;
}

function logFiles(root) {
  const out = [];
  for (const dir of fs.readdirSync(root)) {
    const sub = path.join(root, dir);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const s of fs.readdirSync(sub)) {
      const p = path.join(sub, s, "session.v4.jsonl.zstd");
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

async function auditOne(file) {
  let text;
  try {
    text = execFileSync("unzstd", ["-c", file], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
  } catch (e) {
    return { file, error: `could not decompress: ${e.message}` };
  }

  const lines = text.split("\n").filter(Boolean);
  if (lines.length < 2) return { file, error: "empty log" };
  const header = JSON.parse(lines[0]);
  const events = lines.slice(1).map((l) => JSON.parse(l));

  // Replay the surface the same way the Session engine does.
  const surface = [];
  for (const e of events) {
    if (e.surfaceOp === "append") surface.push(e.seq);
    else if (e.surfaceOp?.op === "replace") {
      const i = surface.indexOf(e.surfaceOp.startSeq);
      const j = surface.indexOf(e.surfaceOp.endSeq);
      if (i >= 0 && j >= 0) surface.splice(i, j - i + 1, e.seq);
    }
  }

  const session = {
    id: header.id,
    header,
    inheritedEventCount: header.inheritedEventCount ?? 0,
    surface: { nodes: surface },
    snapshotEvents: () => events,
  };

  const registrations = {};
  const tools = {};
  const ctx = {
    sessionProjections: {
      register: (d) => { registrations[d.key] = d; },
      stateOf: (target, key) => {
        const d = registrations[key];
        if (!d) return undefined;
        let state = d.init(target.header, target.inheritedEventCount);
        for (const e of target.snapshotEvents()) state = d.apply(state, e);
        return state;
      },
    },
    tools: { register: (d) => { tools[d.name] = d; } },
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    tokenMeter: { estimateMessage },
  };

  apply(ctx, Config["~standard"].validate({}).value);
  const result = await tools.fold_audit.execute({}, { agent: { id: session.id } });
  if (!result.ok) return { file, error: result.error };

  // The plugin's cache cost charges a fold for the *whole* next request's fresh
  // input. That is an upper bound: content appended between requests would have
  // been sent anyway. Compute the marginal version by subtracting the surface
  // tokens added since the previous request. Only user/tool events grow the
  // request input; the assistant's own reply is output, not input.
  const usages = [];
  for (const e of events) {
    const u = e.data?.usage;
    if (u && typeof u.inputTokens === "number") {
      usages.push({ seq: e.seq, rePrefill: u.inputTokens + (u.cacheWriteTokens ?? 0) });
    }
  }
  let cumulative = 0;
  const appendedAt = new Map();
  for (const e of events) {
    if (e.surfaceOp === "append" && e.data?.message?.role !== "assistant") cumulative += estimateMessage(e.data.message);
    appendedAt.set(e.seq, cumulative);
  }
  const marginalByRequest = new Map();
  let prevSeq = -1;
  for (const u of usages) {
    const grown = (appendedAt.get(u.seq) ?? 0) - (prevSeq < 0 ? 0 : (appendedAt.get(prevSeq) ?? 0));
    marginalByRequest.set(u.seq, Math.max(0, u.rePrefill - grown));
    prevSeq = u.seq;
  }

  const seenRequests = new Set();
  let marginalTotal = 0;
  let marginalFoldsAtCost = 0;
  for (const fold of result.ledger) {
    if (fold.cacheRequestSeq === null) continue;
    const m = marginalByRequest.get(fold.cacheRequestSeq) ?? 0;
    if (!seenRequests.has(fold.cacheRequestSeq)) {
      seenRequests.add(fold.cacheRequestSeq);
      marginalTotal += m;
    }
    if (m >= fold.netSaving) marginalFoldsAtCost += 1;
  }

  return {
    file,
    sessionId: header.id,
    events: events.length,
    folds: result.netSaving.folds,
    shadowedNodes: result.coverage.surfaceNodesShadowedByFolds,
    everPlaced: result.coverage.surfaceNodesEverPlaced,
    unaccountedNodes: result.coverage.surfaceNodesUnaccounted,
    netSaving: result.netSaving.totalNetSaving,
    distinctRePrefill: result.cacheCost.distinctCacheCost,
    foldsAtOrAboveCost: result.nestedPasses.count,
    marginalRePrefill: marginalTotal,
    marginalFoldsAtCost: marginalFoldsAtCost,
    costMeasured: result.costHonesty.measured,
    usageRecords: result.ledgerLimits.usageRecords,
    ledgerDetailDropped: result.ledgerLimits.detailDropped,
    provider: (events.find((e) => e.type === "request/header")?.data?.header?.config?.provider) ?? "unknown",
  };
}

const files = logFiles(sessionsRoot);
const audited = [];
const failed = [];
for (const f of files) {
  const r = await auditOne(f);
  if (r.error) failed.push(r);
  else audited.push(r);
}

const withFolds = audited.filter((r) => r.folds > 0);
const withCostEvidence = withFolds.filter((r) => r.costMeasured);

const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

console.log(`session logs found:        ${files.length}`);
console.log(`audited successfully:      ${audited.length}`);
console.log(`could not audit:           ${failed.length}`);
console.log(`sessions containing folds: ${withFolds.length}`);
console.log(`sessions with usage data:  ${withCostEvidence.length}`);
console.log("");
console.log(`total fold operations:     ${sum(withFolds, "folds").toLocaleString()}`);
console.log(`net tokens removed:        ${sum(withFolds, "netSaving").toLocaleString()}`);
console.log("");
console.log("UPPER BOUND (charge a fold for the whole next request's fresh input):");
console.log(`  distinct re-prefill:         ${sum(withCostEvidence, "distinctRePrefill").toLocaleString()}`);
console.log(`  folds costing >= saving:   ${sum(withCostEvidence, "foldsAtOrAboveCost").toLocaleString()} of ${sum(withCostEvidence, "folds").toLocaleString()} (${(100 * sum(withCostEvidence, "foldsAtOrAboveCost") / Math.max(1, sum(withCostEvidence, "folds"))).toFixed(1)}%)`);
console.log(`  sessions net-negative:     ${withCostEvidence.filter((r) => r.netSaving < r.distinctRePrefill).length} of ${withCostEvidence.length}`);
console.log("");
console.log("MARGINAL (subtract content that was appended between requests anyway):");
console.log(`  fold-attributable re-prefill: ${sum(withCostEvidence, "marginalRePrefill").toLocaleString()}`);
console.log(`  folds costing >= saving:   ${sum(withCostEvidence, "marginalFoldsAtCost").toLocaleString()} of ${sum(withCostEvidence, "folds").toLocaleString()} (${(100 * sum(withCostEvidence, "marginalFoldsAtCost") / Math.max(1, sum(withCostEvidence, "folds"))).toFixed(1)}%)`);
console.log(`  sessions net-negative:     ${withCostEvidence.filter((r) => r.netSaving < r.marginalRePrefill).length} of ${withCostEvidence.length}`);
console.log("");
console.log(`surface nodes removed with no fold claiming them: ${sum(withFolds, "unaccountedNodes").toLocaleString()}`);

if (reportPath) {
  fs.writeFileSync(reportPath, JSON.stringify({
    generated: new Date().toISOString(),
    sessionsRoot,
    counts: {
      logsFound: files.length,
      audited: audited.length,
      withFolds: withFolds.length,
      withCostEvidence: withCostEvidence.length,
    },
    corpus: {
      foldOperations: sum(withFolds, "folds"),
      netTokensRemoved: sum(withFolds, "netSaving"),
      distinctRePrefill: sum(withCostEvidence, "distinctRePrefill"),
      foldsAtOrAboveCost: sum(withCostEvidence, "foldsAtOrAboveCost"),
      sessionsNetNegative: withCostEvidence.filter((r) => r.netSaving < r.distinctRePrefill).length,
      unaccountedSurfaceNodes: sum(withFolds, "unaccountedNodes"),
    },
    sessions: withFolds,
    caveats: [
      "distinctRePrefill charges a fold for the entire fresh input of the next request, not the fold's isolated increment. It is an upper bound on the fold's cost, never an exact one.",
      "sessions whose logs contain no usage records are excluded from cost totals and reported as unmeasured, never as zero cost.",
      "these are mock-free but single-machine logs: provider, model and workload differ across sessions, so the corpus is descriptive, not a controlled comparison.",
    ],
  }, null, 2));
  console.log(`\nwrote ${reportPath}`);
}
