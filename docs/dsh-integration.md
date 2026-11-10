# Integrating the audit with DeepSeek Harness

DSH already emits more of the data this audit needs than any other harness
checked here. The gap is not instrumentation; it is aggregation.

## What DSH already records

`@deepseek-ai/dsh-compaction` declares the compaction event vocabulary. From
`lib/types/types.d.ts`:

```ts
'compaction/start':  { compactionId, sourceCommandId?, turn }
'compaction/summary': {
  compactionId,
  summary: ContentBlock[],
  shadowedRange: { start: SessionSeq, end: SessionSeq },
  shadowedSeqs: SessionSeq[],          // authoritative set, in surface order
  shadowedTokenCount: number,          // heuristic price of the shadowed content
  provider: string,
  model: string,
  maxTokens?: number,
  usage?: TokenUsage,                  // provider-reported usage of the summarise call
  rawOutput?: ContentBlock[],
  llmStreamCall?: true
}
'compaction/end':   { compactionId, sourceCommandId?, turn, error? }
'compaction/prune': { shadowedRange, shadowedSeqs, shadowedTokenCount }
```

`CompactionResult` carries the same fields plus `startSeq`, `summarySeq`,
`endSeq`.

Three things are already here that most harnesses do not have:

1. **an authoritative shadowed set** (`shadowedSeqs`), not a range guess;
2. **the token price of what was removed** (`shadowedTokenCount`);
3. **provider-reported usage of the summarisation call itself** (`usage`).

`dsh-compaction-basic` sets `DEFAULT_THRESHOLD_RATIO = .8` and
`DEFAULT_RETAIN_RATIO = .16`, and sends `COMPACTION_INSTRUCTION` as the final
user message so the summariser's request is a genuine prefix of the last routed
request — the exact prefix-cache property property 6 measures.

## What is missing

| property | DSH status |
|---|---|
| coverage ledger | `shadowedSeqs` gives removed turns; nothing asserts the union covers everything |
| verbatim anchors | none — the summary is free prose |
| fold cost | `usage` exists for the summarise call, but the re-prefill of the *next* main request is never compared against it |
| nested folds | nothing detects a fold that saved less than it cost |

DSH shadows rather than deletes, so history stays addressable in the log. That
makes "no silent loss" trivially satisfiable in the archive sense — but it does
not make the *visible* context complete, which is what the model actually sees.

## The plugin shape

A read-only plugin mounted in the profile, no changes to the compaction engine:

```ts
ctx.on("compaction/summary", (ev) => {
  ledger.folds.push({
    id: ev.compactionId,
    seqs: ev.shadowedSeqs,
    originalTokens: ev.shadowedTokenCount,
    compactedTokens: countTokens(ev.summary),
    usage: ev.usage,
  });
});
```

Then, at the end of a turn, the plugin reads `ctx.tokenMeter.measure(session)`
(`totalTokens`, `surfaceTokens`, `nodes[].tokens`, `nodes[].heuristicTokens`) and
the `tokenUsage` projection (`uncachedInputTokens`, `cacheReadTokens`,
`cacheWriteTokens`) and computes:

```
savings   = Σ (originalTokens − compactedTokens)
cost      = uncachedInputTokens on the request immediately after each fold
```

If `cost > savings`, that fold is a **nested pass** in ledger terms: it covers
area that was already covered.

The one genuinely upstream change worth proposing to DSH is a model-facing
`compact_now` tool. The compaction README lists a model-facing compaction tool
as explicitly undecided; an audit that reports "13 folds saved nothing" is the
evidence that decides it.

## Why this is the easiest adapter to build

Every number the audit needs is already in the session log. No mock model, no
synthetic session, no interception. It is a query.
