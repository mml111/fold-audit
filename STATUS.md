# Status: what is verified, what is not

Read this before quoting any number from this repository.

## Verified by execution

| claim | how it was verified | where |
|---|---|---|
| The naive pattern loses 161 of 6,002 turns | coverage ledger over a deterministic session | `results/matrix.json` |
| The same failure appears at 400- and 1,200-turn scales, at 60k and 128k windows | three scenario runs | `results/{small-window,tight-window}.json` |
| Prefix-reusing the summariser call cuts fold overhead 4.6× | recorded prompts compared by common prefix | `results/matrix.json`, `results/small-window.json` |
| Fold granularity is a cost dial (0.35 → 0.04 overhead/savings) | `scripts/sweep.ts` across 7 chunk sizes | printed by the sweep |
| A backend that does nothing exceeds the window | peak prompt intercepted at the model boundary | `results/matrix.json` |
| The harness detects failure | `tests/suite.test.ts` asserts the control fails and the reference passes | 8 assertions |
| The measurement primitives are correct | `tests/engine.test.ts` | 11 assertions |
| Mastra OM accounts for every message and loses none | coverage ledger from intercepted model prompts: 400 messages = 24 verbatim + 376 folded + **0 lost**, 0 double-counted; 229/229 anchors survive | `results/mastra.json` |
| Mastra OM **does not** bound the rendered prompt | peak prompt 32,004 audit tokens against a configured 20,000-token `observation.messageTokens` (160%); Mastra's own tokenx count of the same prompt at that instant was 23,223, with 19,345 pending unobserved messages | `results/mastra.json` |
| "Folded" in Mastra really is recoverable, not just named | all 376 folded messages are still readable in the live message table, and the 35 group ranges tile the thread exactly — union of spans = 400 of 400 messages, contiguous, 0 overlapping messages, 0 unresolvable ranges. The mock summary carries none of their text, so recovery comes from the table | `preservation`, `overlapDetail` in `results/mastra.json` |
| The ledger's compaction rules compute correctly | 71 acceptance tests against a SQLite mirror | `ledger/test/compaction.js` |
| An audit report can be ingested into the ledger turn-by-turn | end-to-end run: 6,002 turns, 7 folds (naive) / 1,089 folds (reference), 7,654 anchors | `ledger/src/compaction-ingest.js` |

## Two definitions of loss, deliberately kept apart

The harness and the ledger disagree about "lost", and that is a finding rather than
a bug:

- **unaccounted** — a turn that is neither in the tail nor inside any fold range.
  The naive fixture: 161.
- **unpreserved** — a turn inside a fold whose record carries no way to get it
  back (`preservedBy: null`). The naive fixture: 5,219.

A fold that summarises a span and provides no archive pointer has removed
information even though the span is "named". The reference fixture keeps a full
archive and `recall()` queries it, so its unpreserved count is 0.

Any report that quotes one number without saying which definition it used is
making an unmeasured claim.

## Written but not executed

- `ledger/migrations/004_compaction.sql` against Postgres. No Postgres server was
  reachable. The logic ran against a SQLite mirror; Postgres-only constructs
  (plpgsql triggers, `make_interval`, `count(*) filter`, `string_agg` with
  `ORDER BY`, generated identity) are unverified syntax assumptions.
- `dsh-plugin/` — the Host plugin that reads the harness's own
  `compaction/summary` events is authored and syntax-checked, but **not
  installed**, so its behaviour is unverified.
- Adapters for Claude Code, Codex CLI, pi, and opencode: described, not written.

- `ledger/migrations/004_compaction.sql` — Postgres syntax is unverified: no Postgres server was reachable from the machine that wrote it. The logic was executed against a SQLite mirror; statements with no SQLite equivalent (plpgsql triggers, `make_interval`, `count(*) filter`, `string_agg` with `ORDER BY`, generated identity columns) are unverified assumptions. See `ledger/docs/compaction.md` for the exact list.
- Adapters for DSH, Claude Code, Codex CLI, pi, opencode — described, not built.

## Fixture-limited

- `src/adapters/mastra.ts` drives `@mastra/core` 1.82.0 / `@mastra/memory` 1.41.0
  with a deterministic mock `LanguageModelV2`. Storage is `InMemoryStore`, which
  was checked directly: `supportsObservationalMemory === true`, so no pg/libsql
  is required.
- What is real: 200 turns at a 20,000-token observation threshold produce 37
  Observer cycles, 35 activated observation groups, coverage over the 400
  messages in the thread = `24 verbatim / 376 folded / 0 lost / 0 double-counted`,
  peak prompt 32,004 tokens, final prompt 16,207 tokens. Every number is measured
  at the model boundary by the Recorder, not reported by Mastra. Repeated runs land in exactly two modes, determined by when the
  async buffer flushed relative to the turn loop: 37 cycles / peak 32,004 /
  verbatim 24 (most common), or 36 cycles / peak 32,005 / verbatim 22. Lost is 0
  and the score is 3/6 in every run. Quote the mode, not a single number.
- "Folded" here means recoverable, not merely named. Mastra attaches
  `data-om-buffering` marker parts to messages, so whole-message text is not
  byte-identical to the turn that was sent; containment against the live message
  table is the correct test. Measured after `settled()`: all 376 folded messages
  are still readable in the table, and 0 of them are recoverable from the
  observation text itself — the mock summary carries none of their content. So the
  recovery path in this fixture is Mastra's message table, reachable through
  `memory.recall()`. Every one of the 29 seeded anchor paths (including the oldest,
  `src/hooks/stitch_0.py`, which is no longer in the prompt) returned a hit.
- Mastra's own thresholds at that configuration: `messageTokens` 20,000,
  `bufferTokens` 4,000, `bufferActivation` 0.8, `blockAfter` 24,000, reflection
  trigger `observationTokens` 40,000. OM's cap applies to the *unobserved message
  pool*, which stayed at 19,345 tokenx under the 20,000 threshold. The rendered
  prompt — pool + observation block + instructions — is never bounded.
- What is not real: the summaries. The mock Observer emits a fixed ~23-token line
  per cycle, so the observation block reaches 1,829 tokens and the Reflector
  never crosses its default 40,000-token trigger — `reflections() == 0` is a
  property of the mock, not of OM. Forcing `reflection.observationTokens = 3000`
  does fire the Reflector (1 cycle, 37 fold-ledger rows), which is what proves the
  zero is a threshold artifact rather than dead code.
- Token units differ, and the finding survives both. OM thresholds are in Mastra's
  `tokenx` estimate; the audit counts `len/4`. At the peak the same prompt measured
  32,005 audit tokens and 23,233 Mastra tokens; Mastra's own unobserved-message
  count at that instant was 19,332, i.e. just under its 20,000 threshold. So the
  overshoot is not a tokenizer artifact: `messageTokens` bounds the *unobserved
  message pool*, never the rendered prompt. The two numbers must never be quoted
  as if they were the same one.
- The earlier run reporting "174 Observer calls, 0 activations, 202,570-token
  prompt" was a bug in this adapter, not in Mastra: the mock's `doStream` emitted
  `{type:"text-delta", text}`, while `convertFullStreamChunkToMastra`
  (`@mastra/core/dist/stream-GSsXnWy3.js:7360`) reads `value.delta`. The chunk was
  dropped, the Observer returned an empty string,
  `assertNonEmptyObserverOutput` (`@mastra/memory/dist/src-BncFunCW.js:27792`)
  threw `OmEmptyResponseError`, and every cycle failed before committing. A/B
  test with only that field changed: `text` → 0 active observation characters,
  `delta` → 5,577 active characters. Fixed by emitting `delta`.

## Not measured

- Real provider cache behaviour. The audit models prefix caching structurally (longest common prefix across the last three prompts). To measure actual `cached_tokens`, run an adapter against a real provider; the recorder is already wired for it.
- Quality of summaries. The audit measures whether facts survive, not whether the summary is good.
