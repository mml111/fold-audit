#!/usr/bin/env node
/**
 * Fold-granularity sweep.
 *
 * How often you fold is a cost dial, and the cost is not monotonic: fold too
 * often and every activation busts the prefix cache; fold too rarely and the
 * context grows. This prints the curve.
 *
 *   node --experimental-strip-types scripts/sweep.ts --window 600000 --turns 3000
 */
import { Counter, Recorder } from "../src/engine.ts";
import { audit } from "../src/suite.ts";
import { BufferedStitcher } from "../src/fixtures/reference.ts";
import { rewriteCost } from "../src/engine.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const window = Number(arg("window", "600000"));
const turns = Number(arg("turns", "3000"));
const turnTokens = Number(arg("turnTokens", "1000"));

const rows: string[] = [];
rows.push("bufferFraction  foldOps  ledgerEntries  saved        overhead     overhead/saved  peak");
for (const bf of [0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8]) {
  const counter = new Counter();
  const rec = new Recorder(counter);
  const r = await audit((rc, cc, w) => new BufferedStitcher(rc, cc, w, false, bf), { window, turns, turnTokens });
  const cost = rewriteCost(r);
  // `foldOps` is how many times a fold actually fired. `ledgerEntries` is how
  // many rows survive in the ledger: a reflection collapses its inputs into one
  // row, so these two are not the same number and must not be conflated.
  rows.push(
    `${String(bf).padEnd(15)}  ${String(r.foldCountClaimed).padEnd(7)}  ${String(r.foldCount).padEnd(14)}  ${r.tokensSaved.toLocaleString().padEnd(10)}  ${cost.toLocaleString().padEnd(12)}  ${(cost / Math.max(1, r.tokensSaved)).toFixed(2).padEnd(15)}  ${r.peakPromptTokens.toLocaleString()}`
  );
}
console.log(rows.join("\n"));
