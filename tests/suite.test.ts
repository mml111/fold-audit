/**
 * Suite self-check. The point of this file is not to test the fixtures; it is
 * to prove the harness can tell a working backend from a broken one.
 *
 * Run: node --experimental-strip-types tests/suite.test.ts
 */
import { Counter, Recorder } from "../src/engine.ts";
import { audit } from "../src/suite.ts";
import { score, format } from "../src/spec.ts";
import { NaiveStitcher } from "../src/fixtures/naive.ts";
import { BufferedStitcher } from "../src/fixtures/reference.ts";
import { NoCompaction } from "../src/fixtures/none.ts";

let failures = 0;
function expect(name: string, cond: boolean, detail: string) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}  — ${detail}`);
  }
}

async function run(make, opts) {
  const counter = new Counter();
  const rec = new Recorder(counter);
  const b = make(rec, counter, opts.window);
  return audit(make, opts);
}

async function main() {
  const window = 600_000;
  const turns = 3000;
  const turnTokens = 1000;
  const giant = 300000;

  const naive = await run((r, c, w) => new NaiveStitcher(r, c, w), { window, turns, turnTokens, giantTurn: giant });
  const reference = await run((r, c, w) => new BufferedStitcher(r, c, w), { window, turns, turnTokens, giantTurn: giant });
  const cold = await run((r, c, w) => new BufferedStitcher(r, c, w, true), { window, turns, turnTokens, giantTurn: giant });
  const baseline = await run((r, c, w) => new NoCompaction(r, c, w), { window, turns, turnTokens, giantTurn: giant });

  console.log(format(naive));
  console.log("");
  console.log(format(reference));
  console.log("");

  console.log("=== harness self-check ===");
  expect("negative control fails", score(naive) < 6, `naive scored ${score(naive)}/6`);
  expect("negative control loses turns", naive.silentLoss > 0, `silentLoss = ${naive.silentLoss}`);
  expect("negative control busts the window", naive.peakPromptTokens > window, `peak = ${naive.peakPromptTokens}`);
  expect("reference passes all six", score(reference) === 6, `scored ${score(reference)}/6`);
  expect("reference stays inside the window", reference.peakPromptTokens <= window, `peak = ${reference.peakPromptTokens}`);
  expect("reference loses nothing", reference.silentLoss === 0, `silentLoss = ${reference.silentLoss}`);
  expect("baseline overflows the window", baseline.peakPromptTokens > window, `peak = ${baseline.peakPromptTokens}`);
  expect("prefix reuse is measurable", cold.rePrefillTokens > reference.rePrefillTokens,
    `cold ${cold.rePrefillTokens} vs warm ${reference.rePrefillTokens}`);

  if (failures) {
    console.error(`\n${failures} self-check assertions failed`);
    process.exit(1);
  }
  console.log("\nall self-check assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
