# The six properties, formally

Each property is stated as an adjective used by a real system, then as the
arithmetic that decides whether the adjective is true.

## 1. No silent loss

**Claim.** "Compaction preserves the important context."

**Test.** Let `T` be the set of turn sequence numbers in the session, `L` the
set covered by fold ranges, `V` the set present verbatim in the final prompt.
Loss = `|T \ (L ∪ V)|`. A system passes iff loss = 0.

The subtlety is what counts as "covered". A turn that is gone from the prompt
but retrievable through a documented recall path is *folded*, not lost. A turn
that is gone and has no addressable record is lost. The audit checks both: it
looks for the turn in the rendered prompt, and it calls the backend's `recall()`.

Measured: naive loses 161 of 6,002 turns across 7 folds; reference loses 0.

## 2. Window discipline

**Claim.** "Keeps the context under the model's limit."

**Test.** Peak prompt tokens intercepted at the model boundary must be ≤ the
declared window. Thresholds that are relative to a configured `messageTokens`
value are not caps; the audit measures the actual request.

Measured: naive 3,320,137 against a 600,000 window. Reference 331,888.

## 3. Convergence

**Claim.** "Compaction reduces pressure."

**Test.** After the run, the prompt must be ≤ 75% of the window, and must not
oscillate: if a fold is triggered and the prompt returns above the trigger
immediately, the fold did nothing.

Measured: reference settles at 54,203 of 600,000. Baseline settles at 3,320,141.

## 4. Race safety

**Claim.** "Compaction runs in the background so it never blocks the agent."

**Test.** Turns appended while a fold is in flight must appear exactly once in
the coverage ledger. `|L|` must equal the sum of range lengths; any sequence
number in two ranges is double-counted.

This is the failure mode of the async pattern. The snapshot is taken at trigger
time; the truncation is applied at completion time.

## 5. Anchor retention

**Claim.** "Summarisation keeps what matters."

**Test.** Before the run, seed the session with verbatim facts — file paths,
identifiers, error strings, numbers. After the run, each must be either present
in the prompt or retrievable. A summary that says "discussed some file issues"
does not retain `src/hooks/stitch_148.py`.

Measured: naive retains 6 of 3,429 anchors. Reference retains 3,429 of 3,429.

## 6. Cost honesty

**Claim.** "Compaction saves tokens."

**Test.** Every model call has a cached prefix and a re-prefilled remainder.
Overhead attributable to compaction is:

```
rewriteCost = Σ rePrefillTokens − Σ newContentTokens
```

New content must be prefilled regardless of compaction, so it is not a cost of
the mechanism. The comparison is `tokensSaved >= rewriteCost`.

Measured: reference 3,279,126 saved against 721,457 overhead. The same stitcher
with a cold observer prompt: 3,279,126 saved against 3,328,655 overhead — the
mechanism costs more than it removes.

**The finding.** The difference between those two numbers is one line: whether
the summariser's prompt is built as a prefix of the conversation or as a fresh
prompt. Same backend, same folds, same savings; 4.6× the overhead.
