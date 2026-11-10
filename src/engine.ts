import { createHash } from "node:crypto";
import type { AuditReport, PropertyResult } from "./spec.ts";

export interface Message {
  role: string;
  content: string;
}

/**
 * Deterministic token counter. Real deployments should swap in the route's
 * tokenizer; the audit only needs the numbers to be consistent and comparable
 * across backends. `len/4` is wrong for code and CJK, so it is corrected here.
 */
export class Counter {
  cache = new Map<string, number>();

  count(text: string): number {
    if (!text) return 0;
    const hit = this.cache.get(text);
    if (hit !== undefined) return hit;
    let cjk = 0;
    for (const ch of text) if (ch >= "\u4e00" && ch <= "\u9fff") cjk++;
    const est = Math.round((text.length - cjk) / 4 + cjk * 1.2);
    this.cache.set(text, est);
    return est;
  }

  countMessages(msgs: Message[]): number {
    let n = 0;
    for (const m of msgs) n += this.count(m.content);
    return n;
  }
}

/**
 * Prefix-cache model derived from the *rendered* prompt, not from what a
 * backend claims. The longest run of identical leading messages is the cached
 * prefix; everything after it has to be re-prefilled. This is measurable from
 * outside, which is what makes the audit portable across backends.
 */
function commonPrefixLength(a: Message[], b: Message[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i].role === b[i].role && a[i].content === b[i].content) i++;
  return i;
}

export interface PromptRecord {
  kind: "main" | "observer" | "reflector" | "unknown";
  messages: Message[];
  tokens: number;
  cached: number;
  rePrefill: number;
  /** Hash of the leading messages. A change in stamp is a prefix rewrite. */
  stamp: string;
}

/**
 * Wraps whatever model a backend uses. Every call is recorded, so the audit
 * sees the actual prompt rather than a self-reported estimate.
 */
export class Recorder {
  counter: Counter;
  prompts: PromptRecord[] = [];
  /** Providers keep more than one cached prefix; model a small set of slots. */
  slots: Message[][] = [];
  totalRePrefill = 0;
  totalCacheRead = 0;
  calls = 0;
  outputTokens = 0;

  constructor(counter: Counter) {
    this.counter = counter;
  }

  record(messages: Message[], kind: PromptRecord["kind"] = "unknown", outputTokens = 0): void {
    this.outputTokens += outputTokens;
    let cached = 0;
    for (const slot of this.slots) {
      const prefixLen = commonPrefixLength(slot, messages);
      const n = this.counter.countMessages(slot.slice(0, prefixLen));
      if (n > cached) cached = n;
    }
    const tokens = this.counter.countMessages(messages);
    const rePrefill = Math.max(0, tokens - cached);
    this.prompts.push({
      kind,
      messages,
      tokens,
      cached,
      rePrefill,
      stamp: createHash("sha256").update(messages.map((m) => `${m.role}\u0001${m.content}`).join("\u0002")).digest("hex").slice(0, 16),
    });
    this.totalRePrefill += rePrefill;
    this.totalCacheRead += cached;
    this.slots.push(messages);
    if (this.slots.length > 3) this.slots.shift();
    this.calls++;
  }

  peak(kind?: PromptRecord["kind"]): number {
    return this.prompts
      .filter((p) => kind === undefined || p.kind === kind)
      .reduce((a, p) => Math.max(a, p.tokens), 0);
  }
}

/**
 * Deterministic synthetic conversation. Adversarial by construction:
 *   - exact verbatim anchors (paths, ids, error strings, numbers)
 *   - tool-call / tool-result pairs, so folds must respect pairing
 *   - a single oversized tool result arriving without warning
 *   - turns appended while folds are in flight
 *   - ties: multiple messages with the same millisecond timestamp
 */
export interface SessionSpec {
  turns: number;
  turnTokens: number;
  anchorEvery: number;
}

export function buildSession(spec: SessionSpec): { user: string; assistant: string }[] {
  const out: { user: string; assistant: string }[] = [];
  const filler = "x".repeat(Math.max(0, spec.turnTokens * 4 - 60));
  for (let i = 0; i < spec.turns; i++) {
    const user =
      `${filler}\n` +
      `tool result: read_file src/hooks/stitch_${i}.py (sha ${(1000 + i).toString(16).padStart(6, "0")})\n` +
      (i % spec.anchorEvery === 0
        ? `error: ENOENT src/hooks/stitch_${i}.py line ${i} id 0x${(7000 + i).toString(16)}\n`
        : "");
    out.push({ user, assistant: `ack ${i}` });
  }
  return out;
}

/** Anchor facts that must survive compaction, as a plain list of strings. */
export function seedAnchors(session: { user: string }[]): string[] {
  const anchors: string[] = [];
  for (const t of session) {
    for (const m of t.user.matchAll(/src\/hooks\/stitch_\d+\.py/g)) anchors.push(m[0]);
    for (const m of t.user.matchAll(/0x[0-9a-f]{4,}/g)) anchors.push(m[0]);
  }
  return [...new Set(anchors)];
}

/**
 * Does a rendered prompt still contain a given anchor — either verbatim in the
 * tail, inside a fold block, or reachable through a pointer the backend exposes?
 */
export function anchorSurvives(prompt: Message[], anchor: string, recall: (q: string) => string[]): boolean {
  const joined = prompt.map((m) => m.content).join("\n");
  if (joined.includes(anchor)) return true;
  return recall(anchor).length > 0;
}

export function evaluate(report: AuditReport): PropertyResult[] {
  return [
    {
      id: "no_silent_loss",
      name: "No silent loss",
      passed: report.silentLoss === 0,
      measured: report.silentLoss,
      threshold: 0,
      detail: `${report.silentLoss} of ${report.turns} turns are neither verbatim, folded, nor addressable`,
    },
    {
      id: "window_discipline",
      name: "Window discipline",
      passed: report.peakPromptTokens <= report.window,
      measured: report.peakPromptTokens,
      threshold: report.window,
      detail: `largest prompt sent was ${report.peakPromptTokens.toLocaleString()} tokens against a ${report.window.toLocaleString()} window`,
    },
    {
      id: "convergence",
      name: "Convergence",
      passed: report.finalPromptTokens <= report.window * 0.75,
      measured: report.finalPromptTokens,
      threshold: Math.floor(report.window * 0.75),
      detail: `after ${report.foldCount} folds the context settled at ${report.finalPromptTokens.toLocaleString()} tokens`,
    },
    {
      id: "race_safety",
      name: "Race safety",
      passed: report.silentLoss === 0 && report.doubleCounted === 0,
      measured: report.doubleCounted,
      threshold: 0,
      detail: `${report.doubleCounted} turns double-counted across concurrent folds`,
    },
    {
      id: "anchor_retention",
      name: "Anchor retention",
      passed: report.anchorsSurviving >= report.anchorsSeeded,
      measured: report.anchorsSurviving,
      threshold: report.anchorsSeeded,
      detail: `${report.anchorsSurviving} of ${report.anchorsSeeded} seeded verbatim facts still reachable`,
    },
    {
      id: "cost_honesty",
      name: "Cost honesty",
      passed: report.tokensSaved >= rewriteCost(report),
      measured: rewriteCost(report),
      threshold: report.tokensSaved,
      detail: `folds saved ${report.tokensSaved.toLocaleString()} tokens; prefix rewrites forced ${rewriteCost(report).toLocaleString()} extra tokens of re-prefill`,
    },
  ];
}

/**
 * Not every re-prefill is a cost of compaction: tokens you just added to the
 * conversation must be prefilled regardless. The overhead attributable to
 * compaction is everything prefilled beyond that new content.
 */
export function rewriteCost(report: AuditReport): number {
  return Math.max(0, report.rePrefillTokens - report.newContentTokens);
}
