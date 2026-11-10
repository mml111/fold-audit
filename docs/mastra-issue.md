# Draft issue for mastra-ai/mastra

Mastra disables pull requests for outside contributors. The accepted path is a
detailed issue with a minimal reproduction hosted in a public repo. This is that
draft. Fill the `[CONFIRM]` markers only with numbers you have actually
reproduced.

---

## Title

**Observational Memory exposes no coverage accounting: nothing in the API lets a caller prove every message was either retained or observed**

## Body

### What I am asking for

OM has a `workingMemory`, a `retrieval` tool, and lifecycle hooks. It does not
expose a **coverage invariant**: a caller cannot ask "of the N messages in this
thread, how many are (a) verbatim in the prompt, (b) covered by an observation
group, (c) unaccounted for?"

That number exists internally — `observedMessageIds`, buffered chunks,
`pendingMessageTokens` — but it is not assembled into a single, checkable
statement. Without it, "no message is silently dropped" is a claim a user can
neither verify in production nor test in CI.

### Why it matters

Compaction correctness is not about summary quality. It is about accounting. A
backend can produce excellent summaries and still lose a message that never
reached the Observer. The failure is invisible precisely because the API does
not report it.

I built an external harness that measures this from the model boundary —
intercepting the actual prompts, comparing their common prefix against the
previous prompt, and computing retained / folded / lost. It runs with a mock
model, so it needs no API key and can run in CI.

### Reproduction

Repo: local — `/home/matt/fold-audit` (not yet published; the reproduction
is two files: `src/adapters/mastra.ts` and `tests/mastra.test.ts`, both in this
repo).

```bash
npm install
node --experimental-strip-types tests/mastra.test.ts
```

`@mastra/core` 1.82.0, `@mastra/memory` 1.41.0,
`InMemoryStore`, a deterministic `LanguageModelV2` mock. No network.

### What the harness reports

200 turns of ~1,000 tokens, `observation.messageTokens = 20000`, `bufferTokens = 4000` (the 0.2 default):

```
backend: mastra-observational-memory
  window 20,000 | turns 400
  peak prompt 32,004 | folds 37
  PASS  no_silent_loss    0 (limit 0) — 0 of 400 turns are neither verbatim, folded, nor addressable
  FAIL  window_discipline 32,004 (limit 20,000)
  FAIL  convergence       16,207 (limit 15,000)
  PASS  race_safety       0 (limit 0)
  PASS  anchor_retention  229 (limit 229)
  FAIL  cost_honesty      629,559 (limit 179,135)
  score: 3/6

coverage: total=400 verbatim=24 folded=376 lost=0 doubleCounted=0
OM internals: observationCycles=37 reflectionCycles=0 generations=0 observationGroups=35
fold ledger: rows=37 originalTokens=200792 compactedTokens=870 cacheBustTokens=42174
preservation of folded messages: rawStillInTable=376 unrecoverable=0 of 376 folded
```

Repeated runs produce two modes depending on when the async buffer flushed relative to
the turn loop: 37 cycles / peak 32,004, or 36 cycles / peak 32,005. `lost` is 0 and
the score is 3/6 in every run.

The headline number this issue asks for — `unaccounted` — measured **0** in this
fixture: every message is either verbatim in the prompt or named by a committed
range, and every folded message is still readable in the message table. That is a
good result for OM. The point of the issue is that this number is only obtainable
by intercepting the prompts the library sends to the model; nothing in the API
states it.

Note the units: OM's thresholds are in its own `tokenx` estimate. The same prompt
that the harness measures at 32,004 tokens is measured by Mastra at 23,221, with
19,346 pending unobserved tokens — just under the 20,000 threshold. So the
threshold is respected by Mastra's own accounting and still breached by the
rendered prompt. Both numbers are printed by the test so they cannot be conflated.

Fields I would like the API to expose directly, so this does not have to be
reverse-engineered from intercepted prompts:

```ts
memory.getObservationalMemoryStatus(threadId, resourceId): {
  messages: number;              // total in the thread
  verbatim: number;              // still in the rendered prompt
  observed: number;              // covered by observation groups
  unaccounted: number;           // total - verbatim - observed  (must be 0)
  doubleCovered: number;         // messages in more than one group
  pendingTokens: number;         // already exposed
}
```

`unaccounted` is the number that matters. If it is non-zero, something was lost.

### Related, already known

- #27261 / #27295 — cursor-millisecond tie dropping unobserved messages. Their
  lifecycle fuzz test already computes coverage and loss internally; this issue
  is about making that number part of the public contract, not a test fixture.
- #29184 — thresholds are relative to `messageTokens`, not to the model's actual
  window. Same root cause: a threshold is not a cap.
- #29522 / #29559 — `ObservationalMemoryInspector`. If that lands, the coverage
  fields above are a small addition to it.

### Not claimed

I am not claiming OM drops messages in production. I am claiming that whether it
does is currently unobservable from outside, and that a four-field status object
makes it observable.

---

## Before filing, verify

1. Run the reproduction against a **real** model, not the mock. Report both.
2. Check `ObservationalMemoryInspector` (PR #29522) — if it already exposes
   `notYetObservedMessages`, scope this issue to the arithmetic it lacks
   (`verbatim + observed + unaccounted == total`) rather than to the data.
3. Confirm the versions in the repro match the current release, not the ones in
   this repo's lockfile.

If any of those come back as "already handled", do not file it. A duplicate
issue is worse than no issue.
