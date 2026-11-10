import { createHash } from "node:crypto";
import { Counter, type Message } from "../engine.ts";
import type { Recorder } from "../engine.ts";
import type { Backend, Coverage } from "../backend.ts";
import type { FoldRecord } from "../spec.ts";

/**
 * REFERENCE IMPLEMENTATION.
 *
 * The pattern Mastra's Observational Memory actually uses, with three things
 * added that OM does not have:
 *   - a coverage pointer. The tail is, by construction, every turn at or above
 *     `nextUnobserved`. A fold may only extend the ledger contiguously, so silent
 *     loss is structurally impossible and an assertion catches ordering bugs.
 *   - an absolute window guard checked before the request is built, not a
 *     relative threshold after the fact.
 *   - deterministic verbatim anchors extracted from the span being folded.
 *
 * Buffering is real: observation chunks are computed in the background and
 * ACTIVATION is a pointer move with no model call. Thresholds are OM's defaults
 * (messageTokens 30k, bufferTokens 0.2, bufferActivation 0.8, blockAfter 1.2,
 * observationTokens 40k).
 */
interface Group {
  id: string;
  kind: "observation" | "reflection";
  start: number;
  end: number;
  text: string;
  anchors: string[];
  originalTokens: number;
  compactedTokens: number;
  promptIndex?: number;
  synchronous?: boolean;
}

const PATH_RE = /[\w./-]+\.(?:py|ts|js|tsx|json|md|sh|yaml|toml|sql|rs|go)\b/g;
const NUM_RE = /\b(?:0x[0-9a-fA-F]{4,}|\d[\d.,_]{1,15})\b/g;
const ERROR_RE = /(?:error|exception|failed|traceback|ENOENT|ECONN)[^\n]{0,90}/gi;
const QUOTED_RE = /"([^"\n]{4,80})"/g;

/**
 * Gated extraction. Scanning a 1.2M-character blob with [\w./-]+ is quadratic:
 * a long run of identical characters backtracks forever. This cost is invisible
 * in most compaction libraries and it hangs real harnesses.
 */
function extractAnchors(turns: { content: string }[], cap = 1200): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of turns) {
    const content = t.content.length > 60000 ? t.content.slice(0, 20000) + "\n" + t.content.slice(-20000) : t.content;
    for (const line of content.split("\n")) {
      if (!/[.\d"']/.test(line)) continue;
      const windows = line.length > 400 ? [line.slice(0, 400), line.slice(-400)] : [line];
      for (const w of windows) {
        for (const re of [PATH_RE, ERROR_RE, QUOTED_RE, NUM_RE]) {
          for (const m of w.matchAll(re)) {
            const a = (m[1] ?? m[0]).trim();
            if (a && !seen.has(a)) {
              seen.add(a);
              out.push(a);
              if (out.reduce((x, y) => x + y.length, 0) > cap) return out;
            }
          }
        }
      }
    }
  }
  return out;
}

export class BufferedStitcher implements Backend {
  name = "buffered-stitcher (reference)";  system = "You are an autonomous engineering agent.";
  tail: { seq: number; role: string; content: string }[] = [];
  log: Group[] = [];
  buffered: Group[] = [];
  jobs: Promise<void>[] = [];
  archive: { seq: number; role: string; content: string }[] = [];
  nextUnobserved = 0;
  computedThrough = -1;
  foldCount = 0;
  reflectionCount = 0;
  wastedCycles = 0;
  gapsFilled = 0;
  saved = 0;
  seq = 0;
  rec: Recorder;
  counter: Counter;
  window: number;
  reserve: number;
  messageTokens: number;
  bufferFraction: number;
  bufferActivation: number;
  blockAfter: number;
  observationTokens: number;
  retentionFloor = 1000;
  coldPrefix: boolean;

  constructor(rec: Recorder, counter: Counter, window: number, coldPrefix = false, bufferFraction = 0.2) {
    this.coldPrefix = coldPrefix;
    this.bufferFraction = Math.min(0.9, Math.max(0.02, bufferFraction));
    this.rec = rec;
    this.counter = counter;
    this.window = window;
    this.reserve = 8_000;
    this.messageTokens = Math.min(30_000, Math.floor(window * 0.05));
    this.bufferActivation = 0.8;
    this.blockAfter = 1.2;
    this.observationTokens = Math.floor(this.messageTokens * 1.33);
  }

  logTokens(): number {
    let n = 0;
    for (const g of this.log) n += g.compactedTokens + this.counter.count(g.anchors.join(" "));
    return n;
  }

  tailTokens(): number {
    return this.tail.reduce((a, t) => a + this.counter.count(t.content), 0);
  }

  prompt(): Message[] {
    const msgs: Message[] = [{ role: "system", content: this.system }];
    for (const g of this.log) {
      let body = `[observations ${g.start}..${g.end}] ${g.text}`;
      if (g.anchors.length) body += "\nVERBATIM: " + g.anchors.join(" | ");
      msgs.push({ role: "system", content: body });
    }
    for (const t of this.tail) msgs.push({ role: t.role, content: t.content });
    return msgs;
  }

  verifyCoverage(): void {
    for (let i = 0; i < this.tail.length; i++) {
      if (this.tail[i].seq !== this.nextUnobserved + i) {
        throw new Error(`coverage violation: tail hole at index ${i}`);
      }
    }
    let prev = -1;
    for (const g of this.log) {
      if (g.start !== prev + 1) throw new Error(`coverage violation: log gap ${prev} -> ${g.start}`);
      prev = g.end;
    }
    if (prev !== this.nextUnobserved - 1) throw new Error(`coverage violation: log ends ${prev}, pointer ${this.nextUnobserved}`);
  }

  async observeChunk(force = false): Promise<Group | null> {
    const start = Math.max(this.nextUnobserved, this.computedThrough + 1);
    const available = this.tail.filter((t) => t.seq >= start);
    if (available.length === 0) return null;

    const budget = this.messageTokens * this.bufferFraction;
    let target = available.length;
    if (!force) {
      let acc = 0;
      for (let i = 0; i < available.length; i++) {
        acc += this.counter.count(available[i].content);
        if (acc >= budget) {
          target = i + 1;
          break;
        }
      }
      target = Math.max(1, target);
    }

    const chunk = available.slice(0, target);
    const end = chunk[chunk.length - 1].seq;
    const originalTokens = chunk.reduce((a, t) => a + this.counter.count(t.content), 0);
    this.computedThrough = Math.max(this.computedThrough, end);

    if (this.coldPrefix) {
      this.rec.record([{ role: "system", content: "Condense the messages below." }, ...chunk], "observer", Math.round(originalTokens * 0.1));
    } else {
      const prefix: Message[] = [{ role: "system", content: this.system }];
      for (const g of this.log) {
        let body = `[observations ${g.start}..${g.end}] ${g.text}`;
        if (g.anchors.length) body += "\nVERBATIM: " + g.anchors.join(" | ");
        prefix.push({ role: "system", content: body });
      }
      for (const t of chunk) prefix.push({ role: t.role, content: t.content });
      this.rec.record(prefix, "observer", Math.round(originalTokens * 0.1));
    }

    const text = `observations(${chunk.length} msgs)`;
    return {
      id: `obs-${start}-${end}`,
      kind: "observation",
      start,
      end,
      text,
      anchors: extractAnchors(chunk),
      originalTokens,
      compactedTokens: this.counter.count(text),
    };
  }

  activate(g: Group): void {
    g.promptIndex = this.rec.prompts.length;
    g.synchronous = this.promptTokens() > this.window - this.reserve;
    // The ledger must stay contiguous. Two things can break that: a chunk
    // computed before an earlier one was activated (out-of-order completion),
    // or a chunk whose range was already covered. Handle both explicitly
    // instead of trusting ordering.
    if (g.end < this.nextUnobserved) {
      this.wastedCycles++;
      return;
    }
    if (g.start > this.nextUnobserved) {
      const gap = this.tail.filter((t) => t.seq >= this.nextUnobserved && t.seq < g.start);
      if (gap.length) {
        const originalTokens = gap.reduce((a, t) => a + this.counter.count(t.content), 0);
        this.log.push({
          id: `gap-${this.nextUnobserved}-${g.start - 1}`,
          kind: "observation",
          start: this.nextUnobserved,
          end: g.start - 1,
          text: `observations(${gap.length} msgs)`,
          anchors: extractAnchors(gap),
          originalTokens,
          compactedTokens: this.counter.count(`observations(${gap.length} msgs)`),
        });
        this.saved += Math.max(0, originalTokens - this.counter.count(`observations(${gap.length} msgs)`));
        this.gapsFilled++;
      }
    }
    this.log.push(g);
    this.nextUnobserved = Math.max(this.nextUnobserved, g.end + 1);
    this.tail = this.tail.filter((t) => t.seq >= this.nextUnobserved);
    this.foldCount++;
    this.saved += Math.max(0, g.originalTokens - g.compactedTokens - this.counter.count(g.anchors.join(" ")));
  }

  async reflect(): Promise<void> {
    if (this.log.length < 2) return;
    const covered = this.log;
    const originalTokens = this.logTokens();
    const text = `reflected(${covered.length} groups)`;
    const compacted = this.counter.count(text);
    const anchors = covered.flatMap((g) => g.anchors).slice(0, 120);

    this.rec.record([{ role: "system", content: this.system }, ...covered.map((g) => ({ role: "system", content: g.text }))], "reflector", compacted);

    this.log = [{
      id: `ref-${covered[0].start}-${covered[covered.length - 1].end}`,
      kind: "reflection",
      start: covered[0].start,
      end: covered[covered.length - 1].end,
      text,
      anchors,
      originalTokens,
      compactedTokens: compacted,
    }];
    this.saved += Math.max(0, originalTokens - compacted - this.counter.count(anchors.join(" ")));
    this.reflectionCount++;
  }

  async turn(content: string): Promise<string> {
    const hardCeil = this.window - this.reserve;

    // Cold cache: the prefix is going to be re-prefilled anyway, so compress first.
    if (this.buffered.length && this.promptTokens() > this.messageTokens) {
      while (this.buffered.length) this.activate(this.buffered.shift()!);
    }

    this.tail.push({ seq: this.seq, role: "user", content });
    this.archive.push({ seq: this.seq, role: "user", content });
    this.seq++;

    if (this.promptTokens() > hardCeil) {
      await Promise.race([Promise.all(this.jobs), new Promise((r) => setTimeout(r, 100))]);
      while (this.buffered.length) this.activate(this.buffered.shift()!);
      if (this.promptTokens() > hardCeil) {
        const g = await this.observeChunk(true);
        if (g) this.activate(g);
      }
      if (this.promptTokens() > this.window) throw new Error(`cannot reduce below ${this.promptTokens()} in a ${this.window} window`);
    }

    const p = this.prompt();
    this.rec.record(p, "main", 20);
    const reply = `response to ${this.seq - 1}`;
    this.tail.push({ seq: this.seq, role: "assistant", content: reply });
    this.archive.push({ seq: this.seq, role: "assistant", content: reply });
    this.seq++;
    this.verifyCoverage();

    if (this.tailTokens() >= this.messageTokens * this.bufferFraction) {
      this.jobs.push(this.observeChunk(false).then((g) => {
        if (g) this.buffered.push(g);
      }));
    }

    if (this.tailTokens() >= this.messageTokens) {
      const targetKeep = Math.max(this.retentionFloor, Math.floor(this.messageTokens * (1 - this.bufferActivation)));
      let keep = this.tailTokens();
      const take: Group[] = [];
      for (const g of this.buffered) {
        if (keep <= targetKeep) break;
        take.push(g);
        keep -= g.originalTokens;
      }
      if (take.length === 0 && this.tailTokens() >= this.messageTokens * this.blockAfter) {
        const g = await this.observeChunk(true);
        if (g) take.push(g);
      }
      for (const g of take) {
        const idx = this.buffered.indexOf(g);
        if (idx >= 0) this.buffered.splice(idx, 1);
        this.activate(g);
      }
    }

    if (this.logTokens() >= this.observationTokens) await this.reflect();

    this.verifyCoverage();
    return reply;
  }

  promptTokens(): number {
    return this.counter.countMessages(this.prompt());
  }

  promptRecords(): { kind: string; tokens: number; cached: number; rePrefill: number }[] {
    return this.rec.prompts.map((p) => ({ kind: p.kind, tokens: p.tokens, cached: p.cached, rePrefill: p.rePrefill, stamp: p.stamp }));
  }

  foldLedger(): FoldRecord[] {
    return this.log.map((g) => ({
      id: g.id,
      kind: g.kind,
      startSeq: g.start,
      endSeq: g.end,
      originalTokens: g.originalTokens,
      compactedTokens: g.compactedTokens,
      cacheBustTokens: this.rec.prompts[g.promptIndex + 1]?.rePrefill ?? 0,
      anchors: g.anchors,
      // The reference keeps a full archive and recall() queries it, so removed
      // turns are addressable, not merely summarised.
      preservedBy: "archive-pointer",
      archivePointer: `archive:${g.start}-${g.end}`,
      // A preservation claim the ledger can actually check: the digest of the
      // exact span this fold covers.
      spanDigest: this.spanDigest(g.start, g.end),
      trigger: g.synchronous ? "hardCeil" : "buffer",
      actor: g.synchronous ? "synchronous" : "background",
    }));
  }

  coverage(): Coverage {
    const verbatim = this.tail.length;
    const folded = this.nextUnobserved;
    const seen = new Map<number, number>();
    for (const g of this.log) {
      for (let i = g.start; i <= g.end; i++) seen.set(i, (seen.get(i) ?? 0) + 1);
    }
    const overlaps = [...seen.values()].filter((n) => n > 1).length;
    return { total: this.seq, verbatim, folded, lost: this.seq - verbatim - folded, doubleCounted: overlaps };
  }

  recall(query: string, limit = 5): string[] {
    const q = query.toLowerCase();
    return this.archive.filter((t) => t.content.toLowerCase().includes(q)).slice(-limit).map((t) => t.content);
  }

  /** Hash of the archived content this fold covers. Computed from the bytes the
   *  archive actually holds, not from a description of them. */
  private spanDigest(start: number, end: number): string | null {
    const parts = this.archive.filter((t) => t.seq >= start && t.seq <= end).map((t) => t.content);
    if (parts.length === 0) return null;
    return createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 32);
  }

  folds(): number {
    return this.foldCount;
  }
  reflections(): number {
    return this.reflectionCount;
  }
  tokensSaved(): number {
    return this.saved;
  }
  async settled(): Promise<void> {
    await Promise.all(this.jobs);
  }
}
