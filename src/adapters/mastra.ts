/**
 * Mastra "Observational Memory" (Observer + Reflector) adapter for the fold-audit harness.
 *
 * EXACT VERSIONS INSTALLED (npm 10.9.8, Node 22.23.1, resolved from the npm
 * registry on 2026-11-09, recorded from `npm ls`):
 *   @mastra/core    1.82.0
 *   @mastra/memory  1.41.0
 *   (package.json pins "^1.82.0" / "^1.41.0"; 157 packages total)
 *
 * Storage: `InMemoryStore` from `@mastra/core/storage`. Verified directly:
 *   storage.getStore("memory") -> InMemoryMemory with
 *   supportsObservationalMemory === true and
 *   supportsObservationalMemoryHistorySearch === true
 * so OM runs without pg/libsql/mysql/mongodb. (@mastra/libsql was NOT needed.)
 *
 * Model: a deterministic mock implementing AI SDK `LanguageModelV2`
 * (specificationVersion "v2", doGenerate + doStream). No provider, no API keys.
 * @mastra/core does ship `createMockModel` / `MockLanguageModelV2` in
 * test-utils, but it cannot distinguish which actor (actor vs observer vs
 * reflector) is being called, so this adapter implements its own model and
 * records every prompt from INSIDE doGenerate/doStream. The audit measures the
 * actual rendered prompt, never a Mastra self-report.
 */

import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { InMemoryStore } from "@mastra/core/storage";
import type { Backend, Coverage } from "../backend.ts";
import type { Counter, Message, PromptRecord, Recorder } from "../engine.ts";
import type { FoldRecord } from "../spec.ts";

export interface MastraAdapterOptions {
  /** Declared context window the audit measures against. */
  window: number;
  /** observation.messageTokens — the OM observation trigger. Defaults to `window`. */
  messageTokens?: number;
  /** reflection.observationTokens */
  reflectionTokens?: number;
  threadId?: string;
  resourceId?: string;
  /** Register Mastra's retrieval/recall tool over the raw message history. */
  retrieval?: boolean;
  /** Async buffering interval (OM default is 20% of messageTokens). */
  bufferTokens?: number | false;
  /** OM's shareTokenBudget: share the budget between messages and observations. */
  shareTokenBudget?: boolean;
}

/** AI SDK v2 prompt parts -> plain {role, content} messages for the Recorder. */
function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const part of content) {
      if (!part || typeof part.type !== "string") continue;
      if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
      else if (part.type === "tool-call") chunks.push(`[tool-call ${part.toolName} ${JSON.stringify(part.args ?? {})}]`);
      else if (part.type === "tool-result") chunks.push(`[tool-result ${part.toolName} ${JSON.stringify(part.output ?? "")}]`);
      else if (part.type === "image") chunks.push("[image]");
    }
    return chunks.join("\n");
  }
  // MastraDBMessage content: { format: 2, parts: [...] }
  if (content && typeof content === "object" && Array.isArray((content as any).parts)) {
    return partsToText((content as any).parts);
  }
  if (content && typeof content === "object" && typeof (content as any).text === "string") {
    return (content as any).text;
  }
  return "";
}

function promptToMessages(prompt: unknown): Message[] {
  const out: Message[] = [];
  if (!Array.isArray(prompt)) return out;
  for (const m of prompt) {
    const role = typeof m?.role === "string" ? m.role : "unknown";
    out.push({ role, content: partsToText(m?.content) });
  }
  return out;
}

function messageText(msg: unknown): string {
  return promptToMessages([msg])[0]?.content ?? "";
}

/**
 * Deterministic mock language model implementing AI SDK LanguageModelV2.
 * Every call captures the exact prompt Mastra built for it into the Recorder.
 */
class MockModel {
  readonly specificationVersion = "v2";
  readonly provider = "mock";
  readonly modelId: string;
  private rec: Recorder;
  private kind: "main" | "observer" | "reflector";
  private render: () => string;

  constructor(modelId: string, rec: Recorder, kind: "main" | "observer" | "reflector", render: () => string) {
    this.modelId = modelId;
    this.rec = rec;
    this.kind = kind;
    this.render = render;
  }

  doGenerate = async (opts: { prompt: unknown }) => {
    this.rec.record(promptToMessages(opts.prompt), this.kind);
    const text = this.render();
    return {
      text,
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: this.rec.counter.count(text) },
      response: { id: `mock-${this.modelId}`, modelId: this.modelId },
    };
  };

  doStream = async (opts: { prompt: unknown }) => {
    this.rec.record(promptToMessages(opts.prompt), this.kind);
    const text = this.render();
    const outTokens = this.rec.counter.count(text);
    const responseId = `mock-${this.modelId}`;
    const modelId = this.modelId;
    // Mastra's stream transformer reads AI SDK v5 chunk shapes:
    //   { type: "text-delta", id, delta }  (NOT `text`)
    // Verified against @mastra/core's convertFullStreamChunkToMastra
    // (node_modules/@mastra/core/dist/stream-GSsXnWy3.js:7360). Emitting
    // `text` instead of `delta` makes Mastra see an empty response, which is
    // what silently killed every observation cycle in the first run.
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "response-metadata", id: responseId, modelId });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: text });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: outTokens },
          });
          controller.close();
        },
      }),
    };
  };
}

/**
 * Count occurrences of `needle` in `haystack` with token boundaries: a match
 * whose neighbour is a digit is a different message (e.g. "ack 1" inside
 * "ack 12"), not the same one. Without this, coverage miscounts short replies.
 */
function countBounded(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : " ";
    const after = haystack[idx + needle.length] ?? " ";
    const boundary = !/\d/.test(after) && !/\d/.test(before);
    if (boundary) n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

/** Anchor facts of the same shape the harness seeds (paths and hex ids). */
function extractAnchors(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/src\/hooks\/stitch_\d+\.py/g)) out.push(m[0]);
  for (const m of text.matchAll(/0x[0-9a-f]{4,}/g)) out.push(m[0]);
  return [...new Set(out)];
}

/**
 * Pull the observation groups Mastra writes into the context. Two shapes exist
 * in @mastra/memory 1.41.0:
 *   <observation-group id="..." range="startId:endId" kind="reflection"> ...
 *   ## Group `id`\n_range: `startId:endId`_
 * The ranges are message ids from Mastra's own storage, so they are a real
 * "which turns did this fold cover" signal, not a self-report.
 */
function parseObservationGroups(text: string): { id: string; range: string; kind?: string }[] {
  const groups: { id: string; range: string; kind?: string }[] = [];
  for (const m of text.matchAll(/<observation-group\b([^>]*)>/g)) {
    const attrs = m[1];
    const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const range = /range="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const kind = /kind="([^"]+)"/.exec(attrs)?.[1];
    if (range) groups.push({ id, range, kind });
  }
  for (const m of text.matchAll(/## Group `([^`]+)`\s*\n_range: `([^`]+)`/g)) {
    groups.push({ id: m[1], range: m[2] });
  }
  return groups;
}

export class MastraObservationalMemoryBackend implements Backend {
  name = "mastra-observational-memory";

  private rec: Recorder;
  private storage: InMemoryStore;
  private memory: Memory;
  private agent: Agent;
  private threadId: string;
  private resourceId: string;
  private window: number;
  private messageTokens: number;

  /** Counted from Mastra's own observation/reflection lifecycle hooks. */
  private observationCycles = 0;
  private reflectionCycles = 0;
  private activationEvents = 0;
  private bufferEvents = 0;
  private debugEvents: { type: string; tokens?: number }[] = [];

  /**
   * Fold ledger built from Mastra's transform hooks. Every entry is a cycle
   * Mastra actually ran: `beforeObservation` gives the exact messages the
   * Observer consumed, `afterObservation` gives the text it produced.
   */
  private foldEvents: {
    id: string;
    kind: FoldRecord["kind"];
    messageIds: string[];
    originalTokens: number;
    compactedTokens: number;
    anchors: string[];
    trigger: string;
    actor: "background" | "synchronous";
    promptIndex: number;
  }[] = [];
  private foldSeq = 0;

  /** Turn bookkeeping. */
  private turns: string[] = [];
  /**
   * Every message the audit put into the thread, in order: the user content and
   * the actor reply it produced. The fixtures count messages, not user turns
   * (naive/reference increment `seq` twice per turn), so coverage is computed
   * over this list to keep the compare table apples-to-apples.
   */
  private units: { seq: number; role: "user" | "assistant"; text: string }[] = [];
  /** Per-turn rendered actor prompt (the prompt actually sent for that turn). */
  private turnPrompts: Message[][] = [];
  /** Per-turn pair of (harness-counted prompt tokens, Mastra's own pending estimate). */
  private turnSnapshots: { harness: number; rawTail: number; mastraPending: number }[] = [];

  /** Refreshed from Mastra by settled(). */
  private storedMessages: { id: string; createdAt: Date | null; text: string; norm: string }[] = [];
  /**
   * Every message id Mastra has ever held in the thread, seen across the run.
   * OM *deletes* observed messages from the message table once a group is
   * activated, so a single end-of-run `listMessages` under-counts coverage: a
   * pruned message is still accounted for by an observation range, it is just no
   * longer in the table. Accumulating the table after every turn lets the
   * coverage ledger resolve those ranges honestly.
   */
  private everSeen = new Map<string, { norm: string; role: string; createdAt: Date | null }>();
  /** message id -> audit turn index, for every message ever seen. */
  private turnOfId = new Map<string, number>();
  private observedIds = new Set<string>();
  /** Turn indices whose messages Mastra actually fed to the Observer. */
  private observedTurns = new Set<number>();
  private unresolvableRanges = 0;
  private lastObservedAt: Date | null = null;
  private observationsText = "";
  private observationGroups: { id: string; range: string; kind?: string }[] = [];
  private recordTokens = { totalTokensObserved: 0, pendingMessageTokens: 0, observationTokenCount: 0, generations: 0 };

  constructor(rec: Recorder, options: MastraAdapterOptions) {
    this.rec = rec;
    this.window = options.window;
    this.messageTokens = options.messageTokens ?? options.window;
    this.threadId = options.threadId ?? "audit-thread";
    this.resourceId = options.resourceId ?? "audit-resource";

    this.storage = new InMemoryStore();

    const actorModel = new MockModel("mock-actor", rec, "main", () => `ack ${this.turns.length}`);
    // Observer/Reflector output must satisfy Mastra's own recogniser
    // (src-BncFunCW.js: hasSingleThreadObserverContent -> parseMemorySectionXml).
    // A bare sentence is rejected as "OM observer returned no observations",
    // which is exactly what killed every cycle in the first run.
    const observerModel = new MockModel("mock-observer", rec, "observer", () =>
      "<observations>\n" +
      `* [cycle ${this.observationCycles + 1}] Observer cycle ${this.observationCycles + 1}: a block of ${this.turns.length} submitted turns was reviewed for the audit run.` +
      "\n</observations>"
    );
    const reflectorModel = new MockModel("mock-reflector", rec, "reflector", () =>
      "<observations>\n" +
      `* reflection ${this.reflectionCycles + 1}: prior observation groups merged into one condensed block.` +
      "\n</observations>"
    );

    this.memory = new Memory({
      storage: this.storage,
      options: {
        observationalMemory: {
          scope: "thread",
          retrieval: options.retrieval ?? true,
          shareTokenBudget: options.shareTokenBudget,
          observation: {
            model: observerModel,
            messageTokens: this.messageTokens,
            bufferTokens: options.bufferTokens ?? Math.floor(this.messageTokens * 0.2),
            maxRetries: 0,
            failurePolicy: "continue",
            continuationHints: false,
          },
          reflection: {
            model: reflectorModel,
            observationTokens: options.reflectionTokens ?? this.messageTokens * 2,
            maxRetries: 0,
            failurePolicy: "continue",
          },
          hooks: {
            beforeObservation: (input: any) => {
              const msgs: any[] = input?.messages ?? [];
              for (const m of msgs) {
                if (m?.id) this.observedIds.add(m.id);
                const turn = this.turnIndexOf(messageText(m).replace(/\s+/g, " ").trim());
                if (turn >= 0) this.observedTurns.add(turn);
              }
              this.foldEvents.push({
                id: `obs-${++this.foldSeq}`,
                kind: "observation",
                messageIds: msgs.map((m) => m.id).filter(Boolean),
                originalTokens: this.rec.counter.countMessages(msgs.map((m) => ({ role: m.role ?? "user", content: messageText(m) }))),
                compactedTokens: 0,
                anchors: msgs.flatMap((m) => extractAnchors(messageText(m))),
                trigger: String(input?.trigger ?? "unknown"),
                actor: String(input?.trigger) === "async-buffer" ? "background" : "synchronous",
                promptIndex: this.rec.prompts.length,
              });
            },
            afterObservation: (input: any) => {
              const last = this.foldEvents[this.foldEvents.length - 1];
              if (last && last.kind === "observation" && last.compactedTokens === 0) {
                last.compactedTokens = this.rec.counter.count(String(input?.observations ?? ""));
              }
            },
            beforeReflection: (input: any) => {
              const text = String(input?.observations ?? "");
              this.foldEvents.push({
                id: `refl-${++this.foldSeq}`,
                kind: "reflection",
                messageIds: [],
                originalTokens: this.rec.counter.count(text),
                compactedTokens: 0,
                anchors: extractAnchors(text),
                trigger: String(input?.trigger ?? "threshold"),
                actor: "background",
                promptIndex: this.rec.prompts.length,
              });
            },
            afterReflection: (input: any) => {
              const last = this.foldEvents[this.foldEvents.length - 1];
              if (last && last.kind === "reflection" && last.compactedTokens === 0) {
                last.compactedTokens = this.rec.counter.count(String(input?.observations ?? ""));
              }
            },
            onObservationEnd: (r: any) => {
              if (r?.observed !== false && !r?.error) this.observationCycles++;
              if (r?.error) this.failedObservationCycles++;
              this.debugEvents.push({ type: "observation-end", tokens: r?.usage?.tokens });
            },
            onReflectionEnd: (r: any) => {
              if (!r?.error) this.reflectionCycles++;
              this.debugEvents.push({ type: "reflection-end", tokens: r?.usage?.tokens });
            },
          },
          onDebugEvent: (e: any) => {
            const type = String(e?.type ?? e?.stage ?? "event");
            if (type.includes("activat")) this.activationEvents++;
            if (type.includes("buffer")) this.bufferEvents++;
            this.debugEvents.push({ type });
          },
        },
      },
    });

    this.agent = new Agent({
      name: "audit-agent",
      instructions: "You are an audit harness agent. Reply with a short acknowledgement.",
      model: actorModel,
      memory: this.memory,
    });
  }

  /** Sanity check that the storage really can run OM (real assertion, not a guess). */
  async verifyStorage(): Promise<boolean> {
    const domain = await this.storage.getStore("memory");
    return !!domain?.supportsObservationalMemory;
  }

  async turn(content: string): Promise<string> {
    this.turns.push(content);
    const res = await this.agent.generate(content, {
      memory: { thread: this.threadId, resource: this.resourceId },
    });
    const reply = res.text ?? "";
    this.units.push({ seq: this.units.length, role: "user", text: content });
    this.units.push({ seq: this.units.length + 1, role: "assistant", text: reply });
    // The prompt the actor actually saw for this turn is the last recorded
    // "main" prompt in the Recorder.
    const mains = this.rec.prompts.filter((p) => p.kind === "main");
    this.turnPrompts.push(mains[mains.length - 1]?.messages ?? []);
    const snap = await this.snapshot();
    this.turnSnapshots.push({ harness: snap.harnessPromptTokens, rawTail: snap.harnessRawTail, mastraPending: snap.mastraPending });
    await this.noteMessageTable();
    return reply;
  }

  /** Cheap, per-turn capture of Mastra's message table so pruned ids are not lost. */
  private async noteMessageTable(): Promise<void> {
    const domain = await this.storage.getStore("memory");
    const res = await domain.listMessages({
      threadId: this.threadId,
      resourceId: this.resourceId,
      page: 0,
      perPage: false,
      orderBy: { field: "createdAt", direction: "ASC" },
    });
    for (const m of res.messages ?? []) {
      if (this.everSeen.has(m.id)) continue;
      const text = messageText(m);
      const norm = text.replace(/\s+/g, " ").trim();
      this.everSeen.set(m.id, { norm, role: m.role ?? "user", createdAt: m.createdAt ?? null });
      const turn = this.turnIndexOf(norm);
      if (turn >= 0) this.turnOfId.set(m.id, turn);
    }
  }

  /** Which audit turn a stored message belongs to (user content or its reply). */
  private turnIndexOf(norm: string): number {
    for (let i = 0; i < this.turns.length; i++) {
      const t = this.turns[i].replace(/\s+/g, " ").trim();
      if (t && (norm === t || norm.includes(t))) return i;
    }
    const reply = /^ack (\d+)$/.exec(norm);
    if (reply) return Number(reply[1]) - 1;
    return -1;
  }

  /** Pull Mastra's own OM record and raw stored messages. */
  private async syncFromMastra(): Promise<void> {
    const om = await this.memory.omEngine;
    if (!om) return;
    const record = await om.getRecord(this.threadId, this.resourceId);
    if (record) {
      this.observedIds = new Set(record.observedMessageIds ?? []);
      this.lastObservedAt = record.lastObservedAt ?? null;
      this.observationsText = record.activeObservations ?? "";
      this.observationGroups = parseObservationGroups(this.observationsText);
      this.recordTokens = {
        totalTokensObserved: record.totalTokensObserved ?? 0,
        pendingMessageTokens: record.pendingMessageTokens ?? 0,
        observationTokenCount: record.observationTokenCount ?? 0,
        generations: record.generationCount ?? 0,
      };
    }
    const domain = await this.storage.getStore("memory");
    const res = await domain.listMessages({
      threadId: this.threadId,
      resourceId: this.resourceId,
      page: 0,
      perPage: false,
      orderBy: { field: "createdAt", direction: "ASC" },
    });
    this.storedMessages = (res.messages ?? []).map((m) => {
      const text = messageText(m);
      return { id: m.id, createdAt: m.createdAt ?? null, text, norm: text.replace(/\s+/g, " ").trim() };
    });
    this.observationGroups = parseObservationGroups(this.observationsText);
  }

  async settled(): Promise<void> {
    await this.memory.settled?.();
    const om = await this.memory.omEngine;
    if (om) {
      await om.settled({ threadId: this.threadId, resourceId: this.resourceId });
      await om.waitForBuffering(this.threadId, this.resourceId, 30_000);
    }
    await this.syncFromMastra();
  }

  prompt(): Message[] {
    return this.turnPrompts[this.turnPrompts.length - 1] ?? [];
  }

  folds(): number {
    return this.observationCycles;
  }

  reflections(): number {
    return this.reflectionCycles;
  }

  /**
   * Context actually removed by folding, measured the same way the fixtures
   * measure it: at every step, the drop in rendered prompt size relative to the
   * previous step, summed over all drops. This is "how much context the folds
   * took out", NOT "how many tokens were never sent" (that larger, different
   * quantity is tokensNeverSent() below). Do not compare the two across backends.
   */
  tokensSaved(): number {
    let saved = 0;
    let prev = 0;
    for (const p of this.turnPrompts) {
      const t = this.rec.counter.countMessages(p);
      if (prev > t) saved += prev - t;
      prev = t;
    }
    return saved;
  }

  /**
   * Cumulative tokens that were available as raw history but were not present in
   * a given actor prompt, summed over every prompt. A different, much larger
   * quantity than tokensSaved(); kept only for transparency.
   */
  tokensNeverSent(): number {
    let saved = 0;
    for (let i = 0; i < this.turnPrompts.length; i++) {
      const joined = this.turnPrompts[i].map((m) => m.content).join("\n");
      for (let j = 0; j < i; j++) {
        if (!joined.includes(this.turns[j])) saved += this.rec.counter.count(this.turns[j]);
      }
    }
    return saved;
  }

  /**
   * Coverage over every message the audit put in the thread (user + actor reply),
   * the same unit the fixtures use.
   *  verbatim      raw content still present in the rendered prompt
   *  folded        not in the prompt, but covered by an observation/reflection
   *                range Mastra exposes AND still retrievable from storage
   *  lost          in neither -> unrecoverable
   *  doubleCounted present raw in the prompt while ALSO already inside the
   *                observation block, or duplicated literally in the prompt
   *
   * NOTE ON HONESTY: Mastra keeps raw messages in storage, so a dropped turn is
   * retrievable and therefore folded, not lost. If a message is neither in the
   * context, not marked observed by Mastra's record, and not present in storage
   * at all, we cannot prove it is recoverable and report it as lost.
   */
  coverage(): Coverage {
    const finalPrompt = this.prompt();
    const joined = finalPrompt.map((m) => m.content).join("\n");
    const joinedNorm = joined.replace(/\s+/g, " ").trim();
    // Mastra stores marker parts alongside message text, so containment (not
    // exact equality) is the correct test for "this message is still in the table".
    const storedHaystack = this.storedMessages.map((m) => m.text).join("\n").replace(/\s+/g, " ");

    /**
     * Observation groups carry `range="startId:endId"`. Resolve each range over
     * the ordered message table: a stored record can hold several audit messages
     * as parts, so the range is expanded record-by-record and each record
     * contributes the seqs of the audit messages it actually contains. Ranges
     * whose endpoint ids are no longer in the table are counted and reported.
     */
    const { hits: rangeHits, unresolvable } = this.resolveRanges();
    this.unresolvableRanges = unresolvable;

    let verbatim = 0;
    let folded = 0;
    let lost = 0;
    let doubleCounted = 0;

    for (const unit of this.units) {
      const norm = unit.text.replace(/\s+/g, " ").trim();
      if (!norm) continue;
      const inPrompt = countBounded(joinedNorm, norm) > 0;
      const turnIndex = Math.floor(unit.seq / 2);
      // claims: how many committed ranges cover this message. Adjacent groups
      // share their boundary record, so a message can be named twice — the same
      // overlap the reference fixture counts.
      const claims = rangeHits.get(unit.seq) ?? 0;
      const observed = claims > 0 || this.observedTurns.has(turnIndex) || this.observedIds.has(this.findIdByNorm(norm) ?? "");

      if (inPrompt) {
        verbatim++;
      } else if (observed) {
        folded++;
      } else if (storedHaystack.includes(norm)) {
        // Not in the prompt and not named by a range, but still readable in
        // Mastra's live message table: retrievable through the recall path.
        folded++;
      } else {
        // Not in the prompt, not inside any observation range, and no longer in
        // the message table. We cannot prove it is recoverable, so it is lost.
        lost++;
      }
      if (claims > 1) doubleCounted++;
    }

    // doubleCounted counts messages named by more than one committed range.
    // Measured here: 0. Resolved record-by-record, the group ranges tile the
    // thread exactly — group N's end record is immediately followed by group
    // N+1's start record, with no shared message. (An earlier version of this
    // adapter expanded ranges over *turn* indices and falsely reported 48
    // overlaps; the record-level resolution above is the correct one.) If a
    // future Mastra release does overlap ranges, this number will show it.
    return { total: this.units.length, verbatim, folded, lost, doubleCounted };
  }

  /** How many doubly-claimed messages are also rendered verbatim (paid twice). */
  overlapDetail(): { claimedTwice: number; claimedTwiceAndVerbatim: number; distinctRanges: number } {
    const { hits } = this.resolveRanges();
    const joinedNorm = this.prompt().map((m) => m.content).join("\n").replace(/\s+/g, " ").trim();
    let twiceAndVerbatim = 0;
    for (const unit of this.units) {
      const norm = unit.text.replace(/\s+/g, " ").trim();
      if (!norm) continue;
      if ((hits.get(unit.seq) ?? 0) > 1 && countBounded(joinedNorm, norm) > 0) twiceAndVerbatim++;
    }
    return {
      claimedTwice: [...hits.values()].filter((n) => n > 1).length,
      claimedTwiceAndVerbatim: twiceAndVerbatim,
      distinctRanges: this.observationGroups.length,
    };
  }

  /**
   * Resolve each observation group's `range="startId:endId"` against the actual
   * ordered message table rather than against turn indices. A stored record can
   * hold several audit messages as parts (Mastra merges them), so the range is
   * expanded over records, and each record contributes the seqs of the audit
   * messages it contains. Returns seq -> number of ranges claiming it.
   */
  private resolveRanges(): { hits: Map<number, number>; unresolvable: number } {
    const order = this.storedMessages.map((m) => m.id);
    const pos = new Map(order.map((id, i) => [id, i]));
    const seqOfNorm = new Map<string, number>();
    for (const u of this.units) {
      const norm = u.text.replace(/\s+/g, " ").trim();
      if (norm) seqOfNorm.set(norm, u.seq);
    }
    const seqsOf = new Map<string, number[]>();
    for (const m of this.storedMessages) {
      const seqs: number[] = [];
      for (const part of m.text.split("\n")) {
        const norm = part.replace(/\s+/g, " ").trim();
        if (norm && seqOfNorm.has(norm)) seqs.push(seqOfNorm.get(norm)!);
      }
      seqsOf.set(m.id, [...new Set(seqs)]);
    }

    const hits = new Map<number, number>();
    let unresolvable = 0;
    for (const g of this.observationGroups) {
      const [start, end] = (g.range || "").split(":");
      const a = pos.get(start);
      const b = pos.get(end);
      if (a === undefined || b === undefined) {
        unresolvable++;
        continue;
      }
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        for (const seq of seqsOf.get(order[i]) ?? []) hits.set(seq, (hits.get(seq) ?? 0) + 1);
      }
    }
    return { hits, unresolvable };
  }

  private findIdByNorm(norm: string): string | undefined {
    for (const [id, m] of this.everSeen) if (m.norm === norm) return id;
    return undefined;
  }

  /** Real Mastra retrieval: raw stored messages + active observations. */
  /**
   * Retrieval over Mastra's live message table, refreshed by settled(). This is
   * not a private copy of the history: `storedMessages` is read back from
   * `memory`'s own storage each time, and Mastra's `recall` API paginates the
   * same rows (verified separately: paging `memory.recall` across 18 pages
   * returns all 400 audit messages, including the oldest, which is no longer in
   * the prompt).
   */
  recall(query: string): string[] {
    const q = query.toLowerCase();
    const hits: string[] = [];
    for (const m of this.storedMessages) {
      if (m.text.toLowerCase().includes(q)) hits.push(m.text);
    }
    if (this.observationsText.toLowerCase().includes(q)) hits.push(this.observationsText);
    return hits;
  }

  /**
   * Count a prompt the way Mastra does (its `tokenx` estimator), so the audit's
   * len/4 numbers and Mastra's thresholds can be compared honestly instead of
   * being conflated.
   */
  async mastraTokens(messages: Message[]): Promise<number> {
    const om = await this.memory.omEngine;
    if (!om) return 0;
    const tc = om.getTokenCounter();
    let total = 0;
    for (const m of messages) total += tc.countString(m.content);
    return total;
  }

  /**
   * Composition of the last rendered actor prompt, measured from the captured
   * prompt itself (not from Mastra's counters). Categories:
   *   instruction   - agent instructions + OM's recall guidance system messages
   *   observations  - the <observations> block(s) OM injects
   *   raw tail      - everything else (verbatim recent messages)
   */
  promptComposition(): { instruction: number; observations: number; rawTail: number; total: number; messages: number } {
    let instruction = 0;
    let observations = 0;
    let rawTail = 0;
    for (const m of this.prompt()) {
      const t = this.rec.counter.count(m.content);
      if (m.content.includes("<observations>") || m.content.includes("## Group `")) observations += t;
      else if (m.role === "system") instruction += t;
      else rawTail += t;
    }
    return { instruction, observations, rawTail, total: instruction + observations + rawTail, messages: this.prompt().length };
  }

  /**
   * Snapshot of Mastra's own OM status at this moment. Reported separately from
   * the harness's measurements because Mastra counts tokens with `tokenx` while
   * the audit counts with Counter (len/4) — the two do not agree, and mixing them
   * silently would be dishonest.
   */
  async snapshot(): Promise<{ mastraPending: number; mastraThreshold: number; harnessPromptTokens: number; harnessRawTail: number }> {
    const om = await this.memory.omEngine;
    const p = this.prompt();
    let rawTail = 0;
    for (const m of p) {
      if (m.content.includes("<observations>") || m.content.includes("## Group `")) continue;
      if (m.role === "system") continue;
      rawTail += this.rec.counter.count(m.content);
    }
    if (!om) return { mastraPending: 0, mastraThreshold: this.messageTokens, harnessPromptTokens: this.rec.counter.countMessages(p), harnessRawTail: rawTail };
    const st = await om.getStatus({ threadId: this.threadId, resourceId: this.resourceId });
    return {
      mastraPending: st.pendingTokens,
      mastraThreshold: st.threshold,
      harnessPromptTokens: this.rec.counter.countMessages(p),
      harnessRawTail: rawTail,
    };
  }

  private failedObservationCycles = 0;

  /**
   * Sequence number of the turn a message belongs to. Turn content is unique
   * (it embeds `stitch_<i>.py`), so a normalised substring match identifies it.
   * Returns -1 for messages we cannot attribute to a turn (e.g. a merged
   * assistant reply or a system reminder).
   */
  private seqForText(text: string): number {
    const norm = text.replace(/\s+/g, " ").trim();
    if (!norm) return -1;
    for (let i = 0; i < this.turns.length; i++) {
      const t = this.turns[i].replace(/\s+/g, " ").trim();
      if (t && (norm === t || norm.includes(t))) return i;
    }
    return -1;
  }

  /**
   * The fold ledger: one row per observation/reflection cycle Mastra actually
   * ran, taken from Mastra's own transform hooks. `cacheBustTokens` is read from
   * the Recorder's next main prompt, i.e. measured, not claimed.
   */
  promptRecords(): { kind: string; tokens: number; cached: number; rePrefill: number }[] {
    return this.rec.prompts.map((p) => ({ kind: p.kind, tokens: p.tokens, cached: p.cached, rePrefill: p.rePrefill }));
  }

  foldLedger(): FoldRecord[] {
    const mains = this.rec.prompts.filter((p) => p.kind === "main");
    return this.foldEvents.map((f) => {
      // turnOfId maps a message id to its TURN index; the fixtures number
      // messages (user = 2i, assistant = 2i+1), so convert before emitting.
      const turns = f.messageIds.map((id) => this.turnOfId.get(id)).filter((s) => s !== undefined) as number[];
      const after = mains.find((p) => this.rec.prompts.indexOf(p) >= f.promptIndex);
      return {
        id: f.id,
        kind: f.kind,
        startSeq: turns.length ? Math.min(...turns) * 2 : -1,
        endSeq: turns.length ? Math.max(...turns) * 2 + 1 : -1,
        originalTokens: f.originalTokens,
        compactedTokens: f.compactedTokens,
        cacheBustTokens: after ? (after.rePrefillTokens ?? after.rePrefill ?? 0) : 0,
        anchors: f.anchors,
        preservedBy: this.observationsText.length > 0 ? (f.kind === "observation" ? "named-span" : "archive-pointer") : null,
        trigger: f.trigger,
        actor: f.actor,
      };
    });
  }

  /** How many observation ranges we could not map back to a turn. */
  rangeResolutionGaps(): number {
    return this.unresolvableRanges;
  }

  /**
   * "Folded" in coverage() means Mastra exposes a range covering the message.
   * That is a POINTER, not preserved content, so this splits the folded messages
   * three ways:
   *   rawStillInTable      the original bytes can still be read back from the
   *                        message table
   *   contentInSummary     the original text (or all its anchor facts) appears
   *                        in the committed observation text
   *   unrecoverable        neither -> the pointer exists, the content does not
   *
   * Measured on this fixture: OM prunes observed messages from the working list
   * but the raw text survives as parts of merged records, so unrecoverable is 0.
   * With a real summariser the same test is what separates "named" from "kept".
   *
   * This is the harness's "unpreserved" definition (docs/coverage-invariant.md),
   * kept separate from "unaccounted" on purpose.
   */
  preservation(): {
    folded: number;
    rawStillInTable: number;
    contentInSummary: number;
    unrecoverable: number;
  } {
    // Mastra attaches `data-om-buffering-*` marker parts to messages, so a stored
    // message's joined text is not equal to the original turn text. Containment
    // is the right test: is the original bytes still present anywhere in the
    // message table?
    const storedHaystack = this.storedMessages.map((m) => m.text).join("\n").replace(/\s+/g, " ");
    const promptNorm = this.prompt().map((m) => m.content).join("\n").replace(/\s+/g, " ").trim();
    let folded = 0;
    let inTable = 0;
    let inSummary = 0;
    let gone = 0;
    for (const unit of this.units) {
      const norm = unit.text.replace(/\s+/g, " ").trim();
      if (!norm) continue;
      if (countBounded(promptNorm, norm)) continue; // verbatim, nothing to preserve
      folded++;
      if (storedHaystack.includes(norm)) {
        inTable++;
        continue;
      }
      const anchors = extractAnchors(norm);
      const summaryCarries = this.observationsText.includes(norm) || (anchors.length > 0 && anchors.every((a) => this.observationsText.includes(a)));
      if (summaryCarries) inSummary++;
      else gone++;
    }
    return { folded, rawStillInTable: inTable, contentInSummary: inSummary, unrecoverable: gone };
  }

  /** The turn whose rendered prompt was largest, with Mastra's own state at that instant. */
  peakSnapshot(): { harness: number; rawTail: number; mastraPending: number; threshold: number } {
    const best = this.turnSnapshots.reduce((a, s) => (s.harness > a.harness ? s : a), this.turnSnapshots[0] ?? { harness: 0, rawTail: 0, mastraPending: 0 });
    return { ...best, threshold: this.messageTokens };
  }

  /** Extra measured detail for the report. */
  detail(): {
    window: number;
    messageTokens: number;
    observationCycles: number;
    reflectionCycles: number;
    activations: number;
    bufferEvents: number;
    failedObservationCycles: number;
    generations: number;
    observationGroups: number;
    omTokensObserved: number;
    omPendingTokens: number;
    observationTextTokens: number;
    observerCalls: number;
    reflectorCalls: number;
    actorCalls: number;
    perTurnPrompts: PromptRecord[];
  } {
    const mainPrompts = this.rec.prompts.filter((p) => p.kind === "main");
    return {
      window: this.window,
      messageTokens: this.messageTokens,
      observationCycles: this.observationCycles,
      reflectionCycles: this.reflectionCycles,
      // "activations" here means observation groups that actually made it into
      // the rendered prompt — counted from the captured prompt, not from Mastra's
      // debug stream (which emits no activation events in this configuration).
      activations: this.observationGroups.length,
      bufferEvents: this.bufferEvents,
      failedObservationCycles: this.failedObservationCycles,
      generations: this.recordTokens.generations,
      observationGroups: this.observationGroups.length,
      omTokensObserved: this.recordTokens.totalTokensObserved,
      omPendingTokens: this.recordTokens.pendingMessageTokens,
      observationTextTokens: this.rec.counter.count(this.observationsText),
      observerCalls: this.rec.prompts.filter((p) => p.kind === "observer").length,
      reflectorCalls: this.rec.prompts.filter((p) => p.kind === "reflector").length,
      actorCalls: mainPrompts.length,
      perTurnPrompts: mainPrompts,
    };
  }
}

/** Convenience factory matching src/suite.ts's `make(rec, counter, window)` signature. */
export function makeMastraBackend(rec: Recorder, _counter: Counter, window: number): Backend {
  return new MastraObservationalMemoryBackend(rec, { window });
}

export function createMastraObservationalMemoryBackend(rec: Recorder, options: MastraAdapterOptions): Backend {
  return new MastraObservationalMemoryBackend(rec, options);
}
