# fold-audit

## What this is, in plain words

A chat model can only hold so much at once. When a chat gets too long, the
program cuts it down. It reads the old messages. It writes a short note about
them. Then it drops the old messages. We call each cut a **fold**.

Programs that fold chats make three promises:

1. Nothing is lost.
2. No room is wasted.
3. The chat stays fast.

Nobody checks these promises. This tool checks them.

## How it works

The tool does four things.

1. It builds a **fake chat** with thousands of messages. It plants small details
   on purpose: file names, error text, numbers like `0x1b58`.
2. It runs a folding program on that chat.
3. It looks at every piece of text that leaves the door.
4. It counts six things and gives a score out of six.

That is all. It is just counting.

## The six counts

| The question | What we count |
|---|---|
| Was anything dropped with no note? | messages that are gone, not in a fold, and not stored |
| Did the text ever get too big? | the largest message we saw go out |
| Did it end up small enough? | the size of the final message |
| Did the same message get folded twice? | folds that overlap |
| Do the small details still live? | we plant 3,429 and see how many are left |
| Did saving room cost more room? | extra text the model had to read again |

The last one needs a small explanation.

The model **remembers the start of the chat**. A fold changes that start. So the
memory is no longer good, and the model must read it all again. That costs room.

A fold that saves 1,000 words but makes the model re-read 5,000 words is a
**bad fold**. It saved room, but it cost more.

## What we found

### 1. The careless way really does lose messages

A common pattern looks like this:

- When the chat gets big, take a copy of it.
- Send the copy to be turned into a note. Do this in the background.
- When the note comes back, cut the chat.

The bug is time. The copy is made at one moment. The cut happens later. In
between, new messages arrive. Those messages are in neither the copy nor the
kept part. They are just gone.

We counted it. Out of 6,002 messages, **161 were lost**. Of 3,429 planted
details, only **355** were still there. Nothing warned anyone.

This is not a rare edge case. It is what the pattern does by design.

### 2. The careful way loses nothing

The fix is simple. Keep a marker. The marker says: "everything up to here has
been folded." A fold may only move the marker forward.

If a fold arrives out of order, it has two choices. It fills the hole, or it is
counted as a wasted cut. It is never hidden.

With that rule: **0 messages lost. 3,429 of 3,429 details survive. Score 6/6.**

### 3. How you write the note matters a lot

Say the note request starts with the chat the model already knows. Then the
memory stays good.

Say the note request is brand new, with no shared start. Then the memory is
thrown away, and the model must read it all again.

Same fold. Same savings. Four and a half times the cost:

| how the note is written | extra cost | saved | was it worth it? |
|---|---|---|---|
| reuses the start of the chat | 721,457 | 2,879,215 | yes |
| starts fresh | 3,328,655 | 2,879,215 | **no. It cost more than it saved** |

### 4. A few big folds beat many small ones

We changed the fold size and watched the cost fall.

| fold size | number of folds | extra cost | cost per word saved |
|---|---|---|---|
| very small | 1,984 | 1,053,899 | 0.53 |
| medium | 1,088 | 721,483 | 0.28 |
| large | 179 | 117,640 | 0.04 |

Nine times less extra cost. And it saved **more**, not less. The catch is that
the chat gets bigger in between folds. You cannot make folds huge forever.

### 5. Waiting for the model to complain is too late

The "do nothing" test hit **3,320,137** tokens on a 600,000-token budget. If your
plan is "only fold when the model says stop," you already lost.

## Are the numbers safe to trust?

Yes, in a repeatable way. The same command gives the exact same numbers every
time. There is no internet, no key, and no real model. The model is a fake one
that always answers the same way.

The point is not that our fake chat is real life. The point is that the counts
are just math. The same math works on real logs. We ran it on a real session
with 290 folds. It said: **209 of the 290 folds saved less than they cost.**

## Run it

```bash
npm install
node --experimental-strip-types tests/engine.test.ts
node --experimental-strip-types tests/suite.test.ts
node --experimental-strip-types src/cli.ts --backends baseline,naive,reference,reference-cold --report results/matrix.json
node --experimental-strip-types src/compare.ts results/matrix.json
```

The second test matters most. It checks that the tool can tell good from bad. If
the broken program passed, the tool would be useless.

## Full results

**3,000 messages × ~1,000 tokens each. One huge tool result dropped in the
middle. Budget: 600,000 tokens.**

| folding program | score | biggest message | lost | details left | folds | saved | extra cost |
|---|---|---|---|---|---|---|---|
| do nothing | 4/6 | 3,320,137 | 0 | 3429/3429 | 0 | 0 | 0 |
| careless | **2/6** | **632,313** | **161** | **355/3429** | 7 | 2,999,903 | 2,617,647 |
| careful | **6/6** | 331,888 | 0 | 3429/3429 | 1,088 | 2,879,215 | 721,457 |
| careful, but new note | 5/6 | 331,888 | 0 | 3429/3429 | 1,088 | 2,879,215 | 3,328,655 |

Two more budget sizes, same story:

| test | careless | careful | careful, new note |
|---|---|---|---|
| 600 messages, 60k budget | 3/6 — 299 lost, 17/686 details, peak 50,321 | 5/6 — 0 lost, 686/686, peak 7,522 | 5/6 — cost 656,568, saved 107,345 |
| 1,200 messages, 128k budget | 3/6 — 138 lost, 199/1372 details, peak 89,106 | 6/6 — 0 lost, 1372/1372, peak 13,616 | 5/6 — cost 615,598, saved 436,505 |

## The six counts, stated exactly

Full definitions: [docs/properties.md](docs/properties.md).

| property | measured as |
|---|---|
| no silent loss | `turns − (verbatim ∪ folded) == 0` |
| window discipline | peak prompt intercepted at the model boundary ≤ window |
| convergence | final prompt ≤ 75% of window |
| race safety | no turn covered by two fold ranges |
| anchor retention | seeded verbatim facts still present or recallable |
| cost honesty | `tokensSaved ≥ rePrefill − newContent` |

Savings come from the **text we saw leave the door**, not from what a program
claims. We store both. Where they disagree, that is the finding.

## The one rule that makes loss impossible

> A fold may only extend the ledger **contiguously**. The tail is, by
> construction, every turn at or above the pointer. A fold that arrives out of
> order fills the gap or is counted as a wasted cycle. It is never silently
> absorbed.

In plain words: keep a straight line of what has been folded. If a fold lands
out of order, count it. Do not hide it. Full statement:
[docs/coverage-invariant.md](docs/coverage-invariant.md).

## Real sessions, not just fake ones

We ran the counts on every chat log saved on one machine. There were 308 logs.
119 of them had folds. In those 119:

```
5,503 fold operations removed 68,255,718 tokens net.
The next requests had to re-read 217,133,383 tokens.
88.2% of folds cost at least as much as they saved.
96 of 118 chats ended up worse off than if they had never folded.
0 pieces of chat vanished without a fold saying it was gone.
```

These numbers move a little each time you run them, because the logs are live:
the machine keeps having conversations while you measure it. Run the script and
it prints whatever is there right now. The percentages are what stay stable.

That last line is the good news. Nothing went missing. The problem is cost. The
program folds a lot, and most folds cost more in re-reading than they save in
room.

There is a second cost people forget. To write a summary, the program has to
send the old text to a model first. On this machine those summary calls read
119,037,520 tokens. Add them to the re-reading and the true bill is
336,170,903 tokens against 68,255,718 saved. On that fuller count, 108 of 118
chats paid more than they got back.

One chat log, 26,595 events and 290 folds, up close:

```
290 folds shadowed 10,391 surface nodes of 10,460 ever placed,
removing 8,395,668 tokens and leaving 756,747 (net 7,638,921).
209 of 290 folds saved no more than they cost.
```

A shorter live session, 19 folds:

```
302 of 590 surface nodes shadowed, 292,089 removed, 27,855 left (net 264,234).
Re-prefill across the 4 distinct requests that followed: 1,209,900.
19 of 19 folds are nested passes. Batched: honest = false.
```

Every fold in that session cost more than it saved. The folds that removed
about 2,000 tokens each forced a re-read tens of times larger.

Read the cost number as a **safe upper bound**. We charge a fold for the whole
next request that had to be re-read. Some of that re-read would have happened
any way. The tool prints this warning instead of hiding it.

## Adapters

`src/adapters/mastra.ts` runs `@mastra/memory` 1.41.0 / `@mastra/core` 1.82.0
Observational Memory with a fake model. No key. Measured: 200 messages of about
1,000 tokens, with a 20,000-token note threshold. Runs land in two modes (37 or
36 note cycles). Nothing is lost in either.

| | value |
|---|---|
| score | **3/6** |
| coverage | 400 messages = 24 in full + 376 folded, **0 lost** |
| note cycles / active groups | 37 / 35 |
| final prompt | 16,207 tokens |
| biggest prompt | **32,004 tokens against a 20,000 limit** |
| details left | 229 / 229 |
| saved vs cost | 179,135 saved, 629,541 extra cost |

The lesson: the limit sets when folding **starts**. It does not set how big the
prompt can get. That is the gap issue #29184 asks about, with a runnable
example.

This is measured on a fake summariser, not on real Mastra in production. The
token units also differ. Mastra counts with tokenx; we count with `len/4`. The
adapter prints both so nobody mixes them up. See
[docs/adapters.md](docs/adapters.md) and the draft report in
[docs/mastra-issue.md](docs/mastra-issue.md).

DSH is the easiest target. Its log already has `compaction/summary`, with the
node lists, the token counts, and the usage. There the audit is a query, not a
hook. Details in [docs/dsh-integration.md](docs/dsh-integration.md).

## Layout

```
src/
  spec.ts          the six properties, the report shape
  engine.ts        token counter, prefix-cache recorder, session generator
  backend.ts       adapter interface
  suite.ts         runner
  cli.ts           entry point
  compare.ts       side-by-side report table
  fixtures/
    naive.ts       negative control — must fail
    reference.ts   buffered stitcher — must pass
    none.ts        baseline: do nothing
  adapters/
    mastra.ts      @mastra/memory Observational Memory
tests/
  engine.test.ts   the measurement primitives are correct
  suite.test.ts    the harness can tell pass from fail
  mastra.test.ts   drives Mastra OM
scripts/
  sweep.ts         fold-granularity curve
  publish.sh       GitHub launch
docs/
  properties.md
  coverage-invariant.md
  adapters.md
  dsh-integration.md
  mastra-issue.md
results/
  matrix.json      committed, reproducible output
STATUS.md          what was run, and what was not
```

## Where the idea came from

This comes from a corroboration ledger. The trick is simple: take a word a
system leans on, and turn it into a count.

There, the word was "independent." The count was
`count(distinct coalesce(upstream_id, id))`. Twenty places claimed three
independent sources. They had zero.

Here the word is "lossless." The count is a set difference. It fails at every
size we tested.

We checked other tools first. Some keep saved text in full:
`planning-with-files`, `fast-jev-compaction`, `agentic-compaction`,
`context-attachment-manager`. None of them report coverage, detail survival, or
cache cost. Measuring fold safety is the open gap.

## License

MIT
