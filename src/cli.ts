#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { Counter, Recorder } from "./engine.ts";
import { audit } from "./suite.ts";
import { format, score } from "./spec.ts";
import type { Backend } from "./backend.ts";
import { NaiveStitcher } from "./fixtures/naive.ts";
import { BufferedStitcher } from "./fixtures/reference.ts";
import { NoCompaction } from "./fixtures/none.ts";

type Maker = (rec: Recorder, counter: Counter, window: number) => Backend;

const registry: Record<string, Maker> = {
  naive: (rec, c, w) => new NaiveStitcher(rec, c, w),
  reference: (rec, c, w) => new BufferedStitcher(rec, c, w),
  "reference-cold": (rec, c, w) => {
    const b = new BufferedStitcher(rec, c, w, true);
    b.name = "buffered-stitcher, cold prefix (variant)";
    return b;
  },
  baseline: (rec, c, w) => new NoCompaction(rec, c, w),
};

// The Mastra adapter is optional: it requires @mastra/core + @mastra/memory.
try {
  const mod = await import("./adapters/mastra.ts");
  const Cls = mod.MastraObservationalMemoryBackend ?? mod.MastraBackend;
  if (Cls) {
    registry.mastra = (rec, c, w) => new Cls(rec, { window: w }) as Backend;
  }
} catch {
  // adapter not present yet
}

function parse(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = "true";
    }
  }
  return out;
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const window = Number(a.window ?? 600_000);
  const turns = Number(a.turns ?? 1200);
  const turnTokens = Number(a.turnTokens ?? 1000);
  const giant = a.giant === "false" || a.giant === undefined ? undefined : Number(a.giant);
  const names = (a.backends ?? "naive,reference").split(",");

  const reports = [];
  for (const name of names) {
    const make = registry[name];
    if (!make) {
      console.error(`unknown backend: ${name}. Available: ${Object.keys(registry).join(", ")}`);
      process.exit(2);
    }
    const report = await audit(make, { window, turns, turnTokens, giantTurn: giant });
    reports.push(report);
    console.log(format(report));
    console.log("");
  }

  if (a.report) {
    writeFileSync(a.report, JSON.stringify({ generated: new Date().toISOString(), window, turns, turnTokens, reports }, null, 2));
    console.log(`wrote ${a.report}`);
  }

  const failed = reports.filter((r) => score(r) < 6);
  // The naive control is EXPECTED to fail; a run where it passes means the suite is broken.
  const referenceFailed = failed.filter((r) => r.backend.includes("reference"));
  if (referenceFailed.length) {
    console.error("reference implementation failed the audit");
    process.exit(1);
  }
  const naivePassed = reports.find((r) => r.backend.includes("naive") && score(r) === 6);
  if (naivePassed) {
    console.error("negative control passed — the suite cannot detect failure");
    process.exit(1);
  }
  console.log("suite self-check: reference passes, negative control fails");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
