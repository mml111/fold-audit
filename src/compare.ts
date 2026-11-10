#!/usr/bin/env node
/**
 * Compare two AuditReport JSON files.
 *
 *   node --experimental-strip-types src/compare.ts results/matrix.json results/mastra.json
 *   node --experimental-strip-types src/compare.ts --pair naive reference
 */
import { readFileSync } from "node:fs";
import { format, score } from "./spec.ts";
import { rewriteCost } from "./engine.ts";

const argv = process.argv.slice(2);

function load(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return raw.reports ?? [raw];
}

function table(reports: any[]) {
  const rows = reports.map((r) => ({
    backend: r.backend,
    score: `${score(r)}/6`,
    peak: r.peakPromptTokens.toLocaleString(),
    loss: r.silentLoss.toLocaleString(),
    anchors: `${r.anchorsSurviving}/${r.anchorsSeeded}`,
    folds: r.foldCount.toLocaleString(),
    saved: (r.tokensSaved ?? 0).toLocaleString(),
    overhead: rewriteCost(r).toLocaleString(),
  }));
  const head = ["backend", "score", "peak prompt", "silent loss", "anchors", "folds", "saved", "overhead"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => Object.values(r)[i].length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(Object.values(r)));
}

if (argv[0] === "--pair") {
  const reports = load(argv[1] ?? "results/matrix.json").filter((r) => r.backend.includes(argv[2]));
  table(reports);
} else {
  for (const p of argv) table(load(p));
}
