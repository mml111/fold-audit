# fold-audit — DSH Host plugin

A read-only plugin that turns the harness's **own compaction log** into a fold
audit ledger and exposes it to the model as the `fold_audit` tool.

It does not change compaction. It reads what compaction already wrote.

## Why no instrumentation is needed

`@deepseek-ai/dsh-compaction` already records, as durable session events:

```ts
'compaction/summary': { compactionId, summary, shadowedRange, shadowedSeqs,
                        shadowedTokenCount, provider, model, maxTokens?, usage? }
'compaction/prune':  { shadowedRange, shadowedSeqs, shadowedTokenCount }
```

`shadowedSeqs` is the authoritative set of surface nodes a fold removed,
`shadowedTokenCount` is the heuristic price of that content, and `usage` is the
provider-reported cost of the summarisation call. The audit is a query over the
log, not an interception of the model.

One implementation constraint: the Host Event catalogue has **no**
`compaction/summary` listener — only `compaction/summary-error`. So the plugin
registers a `ctx.sessionProjections` unit (key `foldAudit`), which the framework
drives from `session/event` over every committed event. Cells build lazily, so
a session that compacted before the plugin was installed still folds from the
start of its log.

## Files

```
package.json       bundle manifest, dsh.bundle.patch (no dependencies)
cordis.patch.yml   inserts the fold-audit row with config
index.js           the plugin: projection unit + fold_audit tool
locale/en.json     display title and description
locale/zh.json     same, Chinese
icon.svg           original bundle icon
README.md          this file
```

Verification scripts (outside the bundle):

```
scripts/fold-audit-selftest.mjs        four synthetic scenarios, two negative controls
scripts/fold-audit-real-session.mjs    builds a real Session object and folds over it
scripts/fold-audit-from-log.mjs        audits an actual stored session log
```

## Configuration

On the `fold-audit` row in the profile patch:

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | register the ledger and the tool at all |
| `threshold` | `1` | nested-pass ratio, see below |

`Config` is declared as a JSON Schema object with a `~standard.validate` face, so
the bundle needs no schema library. The Loader reports its projection status as
`unsupported` (it is not a native schemastery schema), which means the Settings
page cannot render an editable form for it; the patch config still validates and
applies.

## What the tool reports

### 1. Coverage

Every surface event places exactly one node; every node a fold shadows is removed
from the surface. So:

```
nodesEverPlaced - nodesPresent == distinct nodes claimed shadowed
```

iff nothing vanished silently. Reported:

- `surfaceNodesEverPlaced`, `surfaceNodesPresent`
- `surfaceNodesShadowedByFolds` — nodes a fold named
- `surfaceNodesRewrittenWithoutShadowPrice` — nodes replaced by a surface event
  that carried no shadow-price event (system-prompt updates land here); counted,
  not treated as loss
- `surfaceNodesUnaccounted` — nodes removed with no claim at all. This is the
  silent-loss number.
- `overlappingShadowedClaims` — nodes claimed by two folds (the race-safety
  signal)
- `shadowedSeqsStillOnSurface` — a fold claimed to shadow a node that is still
  on the surface
- turn level: `turnsPresent`, `turnsShadowedOnly`, `turnsRewrittenOnly`,
  `turnsNeitherPresentNorCovered`

A turn is present if any node it placed is still on the surface; covered-only if
every node it placed was shadowed; unaccounted otherwise. Events with no `turn`
field (plain user messages) group under turn 0.

Coverage is recomputed from the log at call time, so it stays exact even when the
stored ledger is capped.

### 2. Net saving, per fold

```
netSaving = shadowedTokenCount - replacementTokens
```

`replacementTokens` is measured from the **actual replacement event** paired with
the metering event (the contract requires it to be appended immediately after):
the checkpoint `user/message` for a summary, the rewritten `tool/result` for a
prune.

### 3. Cache cost, per fold

`inputTokens - cacheReadTokens` of the first `assistant/message` usage committed
after the fold. If no assistant usage has committed after a fold yet, the cost is
`null` — unknown, never zero.

Several folds can precede one request. `perFoldCacheCost` counts each fold
separately; `distinctCacheCost` counts each request once. Compare the saving
against the distinct number.

### 4. Nested passes

A fold is a nested pass when:

```
cacheCost >= netSaving * threshold
```

`threshold` defaults to `1`, i.e. the fold saved no more than it cost.

### 5. Cost honesty (aggregate)

`costHonesty.honest` is true when total net saving covers the distinct re-prefill
the folds caused.

## A caveat on `cacheReadTokens`

Not every provider usage record carries `cacheReadTokens`. In the session this
plugin was first tested on, 193 of 202 assistant usages had it; the rest did not.
When it is absent the audit treats the entire `inputTokens` as re-prefill, which
is an **upper bound**, not a measurement. The tool does not hide this: the fold
still reports `cacheCost`, and `method.tokenEstimator` says where the numbers come
from. A fold flagged `nested` on a usage record with no cache field is a
"possibly nested" fold, not a proven one.

## Verified output

Live in the session that installed it (`1b7423b8-…`, 19 folds: 18 prunes and one
summary):

```
19 fold(s) shadowed 302 surface node(s) of 521 ever placed, removing 292089 and
leaving 27855 heuristic tokens (net 264234). 19 of the 19 recorded folds have a
measurable next-request cache cost: 6085171 summed per fold, 1160748 across 4
distinct requests; 18 folds saved no more than they cost. Compaction costs more
than it removes overall: 1160748 re-prefill against 264234 saved. No coverage
gap: every turn is either present or covered by a fold.
```

Cross-checked against the raw zstd session log replayed independently: the
invariant `surfaceEvents - presentNodes == distinctShadowedSeqs` holds
(535 − 233 = 302 at that snapshot; the surface grows as the session continues, so
the absolute numbers move between calls while the identity stays true). Zero
overlapping claims, zero shadowed seqs still on the surface.

The interesting part is the split by kind, which is exactly what the audit is for:

| fold | shadowed | replacement | net saving | cache cost | nested |
|---|---|---|---|---|---|
| 18 prunes | 119,538 | 23,364 | 96,174 | 995,347 (3 requests) | all 18 |
| 1 summary | 172,551 | 4,491 | 168,060 | 165,401 (1 request) | no |

A prune removes a 12,491-token tool result and leaves a 1,298-token stub, saving
11,193 tokens — but the next request re-prefills 326,449 uncached tokens. The
prune is not the whole cause of that prefill, and the tool does not claim it is;
it says the fold's saving did not cover the re-prefill that followed it. The
summary, which removes 284 nodes at once, is the only fold in this session whose
saving is in the same order of magnitude as its cost.

Against a second real stored session (`3b384f50-…`, 26,595 events, 290 folds):

```
290 fold(s) shadowed 10391 surface node(s) of 10460 ever placed, removing
8395668 and leaving 756747 heuristic tokens (net 7638921). 290 folds have a
measurable next-request cache cost: 16919470 summed per fold, 10049246 across
193 distinct requests; 218 folds saved no more than they cost. Compaction costs
more than it removes overall: 10049246 re-prefill against 7638921 saved.
5 surface node(s) were rewritten without a shadow-price event (prompt updates);
they are not counted as losses. No coverage gap: every turn is either present
or covered by a fold.
```

Zero unaccounted nodes, zero overlapping claims: the harness's own shadowing is
exact. The cost is where it fails — 218 of 290 folds, and the session as a whole,
paid more in re-prefill than it removed.

## What it cannot measure

- **Token counts are heuristic except where the provider reports them.**
  `shadowedTokenCount` and the replacement size come from the harness's
  fixed-density estimator (`ceil(chars/4)` plus 4 tokens of block framing), not a
  real tokenizer. The cache cost is the only provider-exact number.
- **Anchor retention.** The summary is free prose; nothing records which seeded
  facts survived it. The audit can say how many tokens were removed, not whether
  a specific fact was.
- **Window discipline and convergence.** The plugin reports surface node counts,
  not peak prompt size sampled over time.
- **Cache cost is attributed to the fold, not isolated to it.** The number is
  `inputTokens - cacheReadTokens` for the whole next request, which includes all
  the other context in that request. It is the re-prefill the request needed, not
  the increment the fold caused. Comparing it against a single fold's saving is
  therefore conservative in the direction of finding nested passes: a fold that
  looks nested may have been paid for by unrelated churn.
- **Summariser cost is separate from fold cost.** `summariserInputTokens` is
  recorded but not folded into `cacheCost`, because providers count cached prefix
  reads differently per route. The honest total for a summary fold is
  `cacheCost + summariserInputTokens`; the tool reports the two apart.
- **The "next request" is a log-adjacency assumption.** Compaction is triggered
  mid-turn, so the assistant usage after a fold is normally the request carrying
  the summary. A fold at the very end of a session has no measurable cost.
- **Forks inherit the ledger of their source log.** The audit describes the log a
  session carries, not the lineage that produced it.
- **Detail caps.** Beyond 500 folds only running totals remain;
  `ledgerLimits.detailDropped` reports how many were dropped. Beyond 20,000 usage
  records, later folds get a null cache cost.

## Install

```
plugin_manager → install_bundle → /home/matt/fold-audit/dsh-plugin
```

Then confirm with `cordis_inspect_query` (provider `Tool`, method `listTools`)
that `fold_audit` is visible, and call it. Because the bundle is installed as a
link to this directory, edits to `index.js` need a reinstall
(`remove_bundle` then `install_bundle`) or a profile restart to reload the module
generation.
