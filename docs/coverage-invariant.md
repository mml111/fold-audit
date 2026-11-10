# The coverage invariant

A formal statement, so it can be cited.

## Definitions

A **session** is an ordered set of turns `t_0 … t_n`, each with a sequence number.

A **ledger** is a set of fold ranges `[start_i, end_i]` over those sequence numbers.

A **tail** is the set of turns still present verbatim in the prompt.

A **pointer** `p` is the smallest sequence number not covered by the ledger.

## Invariant

```
{0 … n}  ==  {p … n}  ∪  ⋃_i [start_i, end_i]
```

and, additionally:

1. the ranges are non-overlapping: no sequence number appears in two ranges;
2. the ranges are contiguous with the tail: `start_i == p` for the next fold;
3. every turn not in the tail and not in a range is *lost*, and the count of such turns must be zero.

Property 2 is the load-bearing one. A fold may only extend the ledger contiguously. If a fold arrives out of order — which is exactly what happens when a background summariser finishes after the main loop has appended more turns — the gap must be filled or the fold must be discarded as a wasted cycle. It must never be silently absorbed.

## Why the naive pattern violates it

```python
snapshot = raw_history[:-10]          # taken at trigger time
asyncio.create_task(compact(snapshot)) # runs later
...
raw_history = raw_history[-10:]        # applied at completion time
```

Between the snapshot and the truncation, the main loop appends turns. Those turns are in neither the snapshot nor the retained tail. They are gone, and nothing records it.

Measured on a 6,002-turn session: **161 turns lost** across seven folds — exactly
the turns appended while the summariser was in flight.

## What the reference implementation does

```ts
activate(g: Group): void {
  if (g.end < this.nextUnobserved) { this.wastedCycles++; return; }
  if (g.start > this.nextUnobserved) { /* fill the gap explicitly */ }
  this.log.push(g);
  this.nextUnobserved = Math.max(this.nextUnobserved, g.end + 1);
  this.tail = this.tail.filter((t) => t.seq >= this.nextUnobserved);
}
```

Loss is not "unlikely". It is structurally impossible, and ordering failures are counted rather than hidden.

## Verified negatives

A corollary from the corroboration-ledger work: **an absence must carry the protocol that produced it.** "Nothing was lost" is not a claim until you can show the ledger that accounts for every turn. A backend that cannot report coverage is not lossless; it is unmeasured.
