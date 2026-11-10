/**
 * Unit tests for the measurement primitives. These matter: if the prefix
 * comparison is wrong, every number in the report is wrong.
 *
 * Run: node --experimental-strip-types tests/engine.test.ts
 */
import { Counter, Recorder, rewriteCost } from "../src/engine.ts";

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!ok) fails++;
}

const c = new Counter();

check("empty text counts zero", c.count(""), 0);
check("ascii scales by /4", c.count("a".repeat(400)), 100);
check("cjk is NOT counted as /4", c.count("中文中文中文中文"), Math.round(0 + 8 * 1.2));

const rec = new Recorder(c);
rec.record([{ role: "system", content: "A".repeat(400) }, { role: "user", content: "B".repeat(400) }], "main");
rec.record([{ role: "system", content: "A".repeat(400) }, { role: "user", content: "B".repeat(400) }, { role: "assistant", content: "C".repeat(400) }], "main");
check("second call caches the shared prefix", rec.prompts[1].cached, 200);
check("second call re-prefills only the new message", rec.prompts[1].rePrefill, 100);

// A rewrite that changes the middle of the prefix busts everything after it.
rec.record([{ role: "system", content: "A".repeat(400) }, { role: "user", content: "X".repeat(400) }, { role: "assistant", content: "C".repeat(400) }], "main");
check("a mid-prefix change busts the suffix", rec.prompts[2].cached, 100);
check("and the bust is counted as re-prefill", rec.prompts[2].rePrefill, 200);

check("peak is per-kind", rec.peak("main"), 300);
check("peak over everything", rec.peak(), 300);

check("rewrite cost clamps at zero", rewriteCost({ rePrefillTokens: 100, newContentTokens: 500 } as any), 0);
check("rewrite cost subtracts new content", rewriteCost({ rePrefillTokens: 1000, newContentTokens: 500 } as any), 500);

if (fails) {
  console.error(`\n${fails} measurement tests failed`);
  process.exit(1);
}
console.log("\nmeasurement primitives verified");
