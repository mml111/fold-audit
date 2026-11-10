import type { Message } from "../engine.ts";
import type { Recorder, Counter } from "../engine.ts";
import type { Backend, Coverage } from "../backend.ts";
import type { FoldRecord } from "../spec.ts";

/**
 * BASELINE: a harness that does nothing. Messages append forever. This is the
 * control that shows what "no compaction" actually costs, and it is what most
 * of the "lossless compaction is unnecessary" arguments quietly assume.
 */
export class NoCompaction implements Backend {
  name = "no-compaction (baseline)";
  system = "You are an autonomous engineering agent.";
  raw: { seq: number; role: string; content: string }[] = [];
  seq = 0;
  rec: Recorder;
  counter: Counter;

  constructor(rec: Recorder, counter: Counter, _window: number) {
    this.rec = rec;
    this.counter = counter;
  }

  prompt(): Message[] {
    return [{ role: "system", content: this.system }, ...this.raw];
  }

  async turn(content: string): Promise<string> {
    this.raw.push({ seq: this.seq, role: "user", content });
    this.seq++;
    const p = this.prompt();
    this.rec.record(p, "main", 20);
    const reply = `response to ${this.seq - 1}`;
    this.raw.push({ seq: this.seq, role: "assistant", content: reply });
    this.seq++;
    return reply;
  }

  coverage(): Coverage {
    return { total: this.seq, verbatim: this.seq, folded: 0, lost: 0, doubleCounted: 0 };
  }

  recall(query: string): string[] {
    const q = query.toLowerCase();
    return this.raw.filter((r) => r.content.toLowerCase().includes(q)).map((r) => r.content);
  }

  folds(): number {
    return 0;
  }
  promptRecords(): { kind: string; tokens: number; cached: number; rePrefill: number }[] {
    return this.rec.prompts.map((p) => ({ kind: p.kind, tokens: p.tokens, cached: p.cached, rePrefill: p.rePrefill }));
  }

  foldLedger(): FoldRecord[] {
    return [];
  }
  reflections(): number {
    return 0;
  }
  tokensSaved(): number {
    return 0;
  }
  async settled(): Promise<void> {}
}
