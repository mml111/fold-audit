import { Counter, type Message } from "../engine.ts";
import type { Recorder } from "../engine.ts";
import type { Backend, Coverage } from "../backend.ts";
import type { FoldRecord } from "../spec.ts";

/**
 * NEGATIVE CONTROL.
 *
 * A faithful port of the "decoupled dual-thread continuous stitching" pattern
 * that circulates in agent-harness writeups: a main thread appends turns, a
 * background worker summarises a snapshot when a high watermark is crossed,
 * then truncates history to a fixed tail.
 *
 * It is here so the suite can prove it detects failure. If this fixture passes,
 * the suite is broken, not the fixture.
 *
 * Bugs it reproduces deliberately:
 *   1. The trigger watermark (65% of the window) is above the window itself in
 *      the original pattern; prompts are sent over the limit.
 *   2. snapshot = raw[:-tail] is taken at trigger time, but raw = raw[-tail:]
 *      runs after the async summariser finishes. Every turn appended in between
 *      is dropped without ever being summarised.
 *   3. is_compacting suppresses re-triggers for the whole duration of the fold,
 *      so compaction starves.
 *   4. The summary is free prose with no verbatim anchors and no pointer back
 *      to the original span.
 */
export class NaiveStitcher implements Backend {
  name = "naive-sketch (negative control)";
  raw: { seq: number; role: string; content: string }[] = [];
  anchor = "";
  system: string;
  busy = false;
  summarized = new Set<number>();
  records: FoldRecord[] = [];
  foldCount = 0;
  saved = 0;
  high: number;
  tailLen = 10;
  latencyTurns = 12;   // the summariser takes this many turns to finish
  pending: { snapshot: { seq: number; content: string }[]; turnsLeft: number } | null = null;
  rec: Recorder;
  counter: Counter;
  seq = 0;

  constructor(rec: Recorder, counter: Counter, window: number) {
    this.rec = rec;
    this.counter = counter;
    this.system = "You are an autonomous engineering agent.";
    this.high = Math.floor(window * 0.65);
  }

  prompt(): Message[] {
    return [{ role: "system", content: this.anchor || this.system }, ...this.raw];
  }

  tokens(): number {
    return this.counter.countMessages(this.prompt());
  }

  async turn(content: string): Promise<string> {
    this.settleFold();

    this.raw.push({ seq: this.seq, role: "user", content });
    this.seq++;

    const prompt = this.prompt();
    const tokens = this.counter.countMessages(prompt);
    this.rec.record(prompt, "main", 30);

    if (tokens >= this.high && !this.pending) {
      // Snapshot at trigger time. The truncation happens later. Everything
      // appended in between is the leak.
      this.pending = {
        snapshot: this.raw.slice(0, this.raw.length - this.tailLen),
        turnsLeft: this.latencyTurns,
      };
    }

    const reply = `response to ${this.seq - 1}`;
    this.raw.push({ seq: this.seq, role: "assistant", content: reply });
    this.seq++;
    return reply;
  }

  /** Deterministic stand-in for "the summariser is still running". */
  private settleFold(): void {
    if (!this.pending) return;
    this.pending.turnsLeft--;
    if (this.pending.turnsLeft > 0) return;

    const snapshot = this.pending.snapshot;
    const before = snapshot.reduce((a, s) => a + this.counter.count(s.content), 0);
    this.rec.record([{ role: "system", content: "condense this span" }, ...snapshot], "observer", 60);
    const observerIndex = this.rec.prompts.length - 1;
    this.anchor = `summary of ${snapshot.length} turns`;
    for (const s of snapshot) this.summarized.add(s.seq);
    // The race: truncation is applied to the *current* history, not the snapshot.
    this.raw = this.raw.slice(-this.tailLen);
    this.foldCount++;
    this.saved += Math.max(0, before - this.counter.count(this.anchor));
    this.records.push({
      id: `fold-${this.foldCount}`,
      kind: "truncation",
      startSeq: snapshot[0]?.seq ?? -1,
      endSeq: snapshot[snapshot.length - 1]?.seq ?? -1,
      originalTokens: before,
      compactedTokens: this.counter.count(this.anchor),
      cacheBustTokens: this.nextMainRePrefill(observerIndex),
      anchors: [],
      // The sketch records no range pointer and no archive: the removed turns
      // are simply gone.
      preservedBy: null,
      archivePointer: null,
      spanDigest: null,
      trigger: "high-watermark",
      actor: "background",
    });
    this.pending = null;
  }

  coverage(): Coverage {
    const live = new Set(this.raw.map((r) => r.seq));
    let folded = 0;
    let lost = 0;
    for (let i = 0; i < this.seq; i++) {
      if (live.has(i)) folded++;
      else if (this.summarized.has(i)) folded++;
      else lost++;
    }
    return { total: this.seq, verbatim: live.size, folded: folded - live.size, lost, doubleCounted: 0 };
  }

  // The sketch keeps no archive and no range pointers: nothing can be recalled.
  /** The re-prefill the next main request actually paid for this fold. */
  private nextMainRePrefill(afterIndex: number): number {
    for (let i = afterIndex + 1; i < this.rec.prompts.length; i++) {
      if (this.rec.prompts[i].kind === "main") return this.rec.prompts[i].rePrefill;
    }
    return 0;
  }

  recall(_query: string): string[] {
    return [];
  }

  folds(): number {
    return this.foldCount;
  }
  reflections(): number {
    return 0;
  }
  tokensSaved(): number {
    return this.saved;
  }
  async settled(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  promptRecords(): { kind: string; tokens: number; cached: number; rePrefill: number }[] {
    return this.rec.prompts.map((p) => ({ kind: p.kind, tokens: p.tokens, cached: p.cached, rePrefill: p.rePrefill, stamp: p.stamp }));
  }

  foldLedger(): FoldRecord[] {
    return this.records;
  }
}
