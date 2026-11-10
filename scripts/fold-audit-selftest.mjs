/**
 * Offline self-test for the fold-audit plugin logic.
 *
 * Builds a stub Host context (sessionProjections, tools, sessions, tokenMeter)
 * and synthetic session logs that mimic the real `compaction/summary` and
 * `compaction/prune` event shapes, then checks the four audit numbers against
 * hand-computed expectations. Four scenarios:
 *   1. a well-behaved fold pair  — everything accounted for, nothing nested
 *   2. a negative control        — a fold whose cache cost exceeds its saving
 *   3. a negative control        — a surface node removed with no shadow claim
 *   4. no compaction at all      — the empty-ledger path
 *
 * Run with:  node scripts/fold-audit-selftest.mjs
 * It never touches the installed profile.
 */
import { apply, Config } from '../dsh-plugin/index.js';

/** The harness's own fixed-density estimator, copied for the stub. */
function estimateMessage(message) {
  const blocks = message?.content ?? [];
  let tokens = 0;
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') tokens += Math.ceil(block.text.length / 4) + 4;
    else if (block.type === 'tool-call') tokens += Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4) + 4;
    else tokens += 4 + Math.ceil(JSON.stringify(block).length / 4);
  }
  return tokens + 4;
}

/** Replay surface ops exactly as the Session surface does: append pushes, replace splices. */
function stubSession(events, id = 'session-selftest') {
  const surface = [];
  const committed = [];
  events.forEach((raw, seq) => {
    const event = { ...raw, seq, time: 1000 + seq };
    committed.push(event);
    if (event.surfaceOp === 'append') {
      surface.push(seq);
    } else if (event.surfaceOp?.op === 'replace') {
      const startIdx = surface.indexOf(event.surfaceOp.startSeq);
      const endIdx = surface.indexOf(event.surfaceOp.endSeq);
      surface.splice(startIdx, endIdx - startIdx + 1, seq);
    }
  });
  return {
    id,
    header: { id },
    surface: { nodes: surface },
    snapshotEvents: () => committed,
  };
}

/** Mount the plugin against one stub session and run the tool. */
async function run(events, id) {
  const session = stubSession(events, id);
  const registrations = {};
  const tools = {};
  const ctx = {
    sessionProjections: {
      register: (definition) => { registrations[definition.key] = definition; },
      stateOf: (target, key) => {
        const definition = registrations[key];
        if (!definition) return undefined;
        let state = definition.init(target.header, 0);
        for (const event of target.snapshotEvents()) state = definition.apply(state, event);
        return state;
      },
    },
    tools: { register: (definition) => { tools[definition.name] = definition; } },
    sessions: { get: (sessionId) => (sessionId === session.id ? session : undefined) },
    tokenMeter: { estimateMessage },
  };
  apply(ctx, Config['~standard'].validate({}).value);
  if (!tools.fold_audit) throw new Error('fold_audit was not registered');
  return { session, result: await tools.fold_audit.execute({}, { agent: { id: session.id } }) };
}

const bigText = 'x'.repeat(4000);
const prunedText = 'x'.repeat(100);
const summary = [{ type: 'text', text: 'Folded summary of the previous work.' }];

const failures = [];
const check = (name, actual, want) => {
  if (actual !== want) failures.push(`${name}: got ${actual}, expected ${want}`);
};

/* ---------------- scenario 1: honest fold pair ---------------- */
const good = await run([
  { type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'prompt' }] } }, surfaceOp: 'append' },
  { type: 'user/message', data: { content: [{ type: 'text', text: 'start' }] }, surfaceOp: 'append' },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 } }, surfaceOp: 'append' },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: bigText }] } }, surfaceOp: 'append' },
  { type: 'user/message', data: { content: [{ type: 'text', text: 'keep going' }] }, surfaceOp: 'append' },
  { type: 'compaction/prune', data: { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: estimateMessage({ role: 'tool', content: [{ type: 'text', text: bigText }] }) } },
  { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: prunedText }] } }, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] },
  { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'after prune' }] }, usage: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 100 } }, surfaceOp: 'append' },
  { type: 'compaction/start', data: { compactionId: 'cmp-1', turn: 1 } },
  { type: 'compaction/summary', data: { compactionId: 'cmp-1', summary, shadowedRange: { start: 1, end: 4 }, shadowedSeqs: [1, 2, 6, 4], shadowedTokenCount: 2000, provider: 'stub', model: 'stub-model', usage: { inputTokens: 2000, outputTokens: 120, cacheReadTokens: 1800 } } },
  { type: 'user/message', data: { content: summary }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 }, sourceEventSeqs: [8, 9, 1, 2, 6, 4] },
  { type: 'assistant/message', data: { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'after summary' }] }, usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 300 } }, surfaceOp: 'append' },
  { type: 'compaction/end', data: { compactionId: 'cmp-1', turn: 1 } },
], 's1');
const goodResult = good.result;
const pruneTokens = estimateMessage({ role: 'tool', content: [{ type: 'text', text: bigText }] });
const prunedReplacement = estimateMessage({ role: 'tool', content: [{ type: 'text', text: prunedText }] });
const summaryTokens = estimateMessage({ role: 'user', content: summary });
const goodFold = (kind) => goodResult.ledger.find((item) => item.kind === kind);

check('s1 surfaceNodesPresent', goodResult.coverage.surfaceNodesPresent, 4);
check('s1 surfaceNodesEverPlaced', goodResult.coverage.surfaceNodesEverPlaced, 9);
check('s1 nodesShadowed', goodResult.coverage.surfaceNodesShadowedByFolds, 5);
check('s1 nodesUnaccounted', goodResult.coverage.surfaceNodesUnaccounted, 0);
check('s1 shadowClaims', goodResult.coverage.shadowedClaimsTotal, 5);
check('s1 overlappingClaims', goodResult.coverage.overlappingShadowedClaims, 0);
check('s1 shadowedStillPresent', goodResult.coverage.shadowedSeqsStillOnSurface, 0);
check('s1 gapTurns', goodResult.coverage.turnsNeitherPresentNorCovered, 0);
check('s1 pruneNetSaving', goodFold('prune').netSaving, pruneTokens - prunedReplacement);
// `inputTokens` is already the fresh (uncached) input, so the re-prefill a fold
// forces is the whole inputTokens of the next request, not input minus cacheRead.
check('s1 pruneCacheCost', goodFold('prune').cacheCost, 400);
check('s1 pruneNested', goodFold('prune').nested, 400 >= (pruneTokens - prunedReplacement));
check('s1 summaryNetSaving', goodFold('summary').netSaving, 2000 - summaryTokens);
check('s1 summaryCacheCost', goodFold('summary').cacheCost, 900);
check('s1 summariserInput', goodFold('summary').summariserInputTokens, 2000);
check('s1 totalNetSaving', goodResult.netSaving.totalNetSaving, (pruneTokens + 2000) - (prunedReplacement + summaryTokens));
check('s1 pruneReplacementSeq', goodFold('prune').replacementSeq, 6);

/* ---------------- scenario 2: the fold costs more than it removes ---------------- */
const expensive = await run([
  { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'a'.repeat(4000) }] }, surfaceOp: 'append' },
  { type: 'compaction/start', data: { compactionId: 'cmp-2', turn: 1 } },
  { type: 'compaction/summary', data: { compactionId: 'cmp-2', summary, shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1000, provider: 'stub', model: 'stub-model' } },
  { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'b'.repeat(3600) }] }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'go' }] }, usage: { inputTokens: 1500, outputTokens: 5, cacheReadTokens: 300 } }, surfaceOp: 'append' },
  { type: 'compaction/end', data: { compactionId: 'cmp-2', turn: 1 } },
], 's2');
const s2Fold = expensive.result.ledger[0];
check('s2 netSaving', s2Fold.netSaving, 1000 - estimateMessage({ role: 'user', content: [{ type: 'text', text: 'b'.repeat(3600) }] }));
check('s2 cacheCost', s2Fold.cacheCost, 1500);
check('s2 nested', s2Fold.nested, true);
check('s2 nestedCount', expensive.result.nestedPasses.count, 1);
check('s2 coverageGapNodes', expensive.result.coverage.surfaceNodesUnaccounted, 0);

/* ---------------- scenario 3: a node vanishes with no shadow claim ---------------- */
const leaky = await run([
  { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'keep' }] }, surfaceOp: 'append' },
  { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'gone' }] }, surfaceOp: 'append' },
  { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'rewritten' }] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 50 } }, surfaceOp: 'append' },
], 's3');
check('s3 nodesPresent', leaky.result.coverage.surfaceNodesPresent, 3);
check('s3 nodesEverPlaced', leaky.result.coverage.surfaceNodesEverPlaced, 4);
check('s3 unaccountedNodes', leaky.result.coverage.surfaceNodesUnaccounted, 1);
check('s3 unaccountedSeq', leaky.result.coverage.unaccountedSeqsSample[0], 1);
check('s3 gapTurns', leaky.result.coverage.turnsNeitherPresentNorCovered, 0); // turn 1 still has node 0 present
check('s3 folds', leaky.result.netSaving.folds, 0);

/* ---------------- scenario 4: no compaction at all ---------------- */
const empty = await run([
  { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'hello' }] }, surfaceOp: 'append' },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 10 } }, surfaceOp: 'append' },
], 's4');
check('s4 folds', empty.result.netSaving.folds, 0);
check('s4 present', empty.result.coverage.surfaceNodesPresent, 2);
check('s4 unaccounted', empty.result.coverage.surfaceNodesUnaccounted, 0);
check('s4 ledger', empty.result.ledger.length, 0);

console.log('s1:', goodResult.summary);
console.log('s2:', expensive.result.summary);
console.log('s3:', leaky.result.summary);
console.log('s4:', empty.result.summary);

if (failures.length > 0) {
  console.error('\nFAIL\n' + failures.join('\n'));
  process.exit(1);
}
console.log('\nPASS: all four scenarios match their hand-computed expectations, including both negative controls.');
