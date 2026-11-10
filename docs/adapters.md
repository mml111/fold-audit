# Writing an adapter

An adapter is any compaction backend that can be made to route its model calls
through the `Recorder`. Nothing about the backend's internals is trusted.

```ts
export interface Backend {
  name: string;
  turn(content: string): Promise<string>;
  coverage(): Coverage;           // { total, verbatim, folded, lost, doubleCounted }
  foldLedger(): FoldRecord[];     // per-fold evidence: span, tokens, cost, preservation
  promptRecords(): PromptRecord[]; // every prompt actually sent, with cache arithmetic
  recall(query: string): string[];
  prompt(): Message[];            // what the model would actually receive
  folds(): number;
  reflections(): number;
  tokensSaved(): number;
  settled(): Promise<void>;       // drain in-flight fold jobs
}
```

Two rules make the audit portable:

1. **`prompt()` is the truth, not the backend's own counters.** The Recorder
   intercepts the actual message list handed to the model and computes prefix
   cache reuse by comparing it against the last three prompts seen. A backend
   that reports `tokensObserved: 0` while sending 200,000 tokens is caught.

2. **`coverage()` must account for every turn.** `total = verbatim + folded + lost`.
   If a backend cannot tell you which of its turns are covered, it is not
   lossless — it is unmeasured. The audit records that as loss.

## Worked example: Mastra

`src/adapters/mastra.ts` wraps `@mastra/memory`'s Observational Memory with a
deterministic `LanguageModelV2` mock. Every `doGenerate`/`doStream` call records
the exact prompt Mastra built. No API key is needed, so the numbers are
reproducible on any machine.

The adapter is deliberately paranoid: it checks that observation actually
happened (`folds() > 0`) rather than assuming a configured threshold means the
mechanism ran.

## What is not yet written

DSH, Claude Code, Codex CLI, pi, and opencode adapters. Each is a different
integration problem:

| system | seam | difficulty |
|---|---|---|
| DSH (DeepSeek Harness) | `CompactionEngine` subclass + the `compaction/summary` bracket | low — `summarize()` is the documented hook |
| Claude Code | no public compaction API; audit by counting tokens in the transcript | medium |
| Codex CLI | event log contains the rolled context | medium |
| opencode / pi | plugin hooks around the message list | low |

See `docs/dsh-integration.md` for the DSH seam in detail.
