/**
 * Real-Session validation for the fold-audit plugin.
 *
 * Builds an actual `Session` from the shipped @deepseek-ai/dsh-session package,
 * appends genuine `compaction/prune` and `compaction/summary` events in the same
 * order the compaction engine uses (deriving the shadowed set from the live
 * surface, exactly as the engine's `replacementRange` does), then folds the
 * plugin's projection over the real log.
 *
 * Run with:  node scripts/fold-audit-real-session.mjs
 * It never touches the installed profile or any real session.
 */
import { Session, SESSION_FORMAT_VERSION } from '/home/matt/.npm/_npx/50d2c97abf8f4186/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { apply, Config } from '../dsh-plugin/index.js';

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;

/** The harness's fixed-density estimator, mirrored for the stub meter. */
function estimateMessage(message) {
  const blocks = message?.content ?? [];
  let tokens = 0;
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
    else if (block.type === 'tool-call') tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN) + Math.ceil(block.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
    else tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
  }
  return tokens + 4;
}

/** Shadowed seqs of a surface-position span, as the Session engine computes them. */
function shadowedSpan(session, startSeq, endSeq) {
  const nodes = [...session.surface.nodes];
  return nodes.slice(nodes.indexOf(startSeq), nodes.indexOf(endSeq) + 1);
}

const bigTool = 'x'.repeat(4000);
const smallTool = 'x'.repeat(100);
const summaryBlocks = [{ type: 'text', text: 'Checkpoint summary: earlier work was folded.' }];
const toolMessage = (content) => ({
  role: 'tool',
  source: { kind: 'tool', callId: 'call_1' },
  toolCallId: 'call_1',
  content: [{ type: 'text', text: content }],
});

const session = Session.create('fold-audit-real', [], {
  version: SESSION_FORMAT_VERSION,
  id: 'fold-audit-real',
  createdAt: Date.now(),
  isSeeded: false,
});

const systemNode = session.append('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] } }, { surfaceOp: 'append' });
const firstUser = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'start' }] }, { surfaceOp: 'append' });
const firstAssistant = session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stream: [], usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 150 } }, { surfaceOp: 'append' });
session.append('tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{}' });
const bigResult = session.append('tool/result', { turn: 1, step: 1, message: toolMessage(bigTool), stream: [] }, { surfaceOp: 'append' });
const secondUser = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'continue' }] }, { surfaceOp: 'append' });

// ---- prune: the over-budget tool result is rewritten smaller ----
session.append('compaction/prune', {
  shadowedRange: { start: bigResult.seq, end: bigResult.seq },
  shadowedSeqs: [bigResult.seq],
  shadowedTokenCount: estimateMessage(toolMessage(bigTool)),
});
session.append('tool/result', { turn: 1, step: 1, message: toolMessage(smallTool), stream: [] }, {
  surfaceOp: { op: 'replace', startSeq: bigResult.seq, endSeq: bigResult.seq },
  sourceEventSeqs: [bigResult.seq],
});

const secondAssistant = session.append('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'after prune' }] }, stream: [], usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 120 } }, { surfaceOp: 'append' });

// ---- summary: the live span from the first user node to the last assistant node ----
const spanStart = firstUser.seq;
const spanEnd = secondAssistant.seq;
const shadowed = shadowedSpan(session, spanStart, spanEnd);
const startEvent = session.append('compaction/start', { compactionId: 'cmp-real', turn: 1 });
const summaryEvent = session.append('compaction/summary', {
  compactionId: 'cmp-real',
  summary: summaryBlocks,
  shadowedRange: { start: spanStart, end: spanEnd },
  shadowedSeqs: shadowed,
  shadowedTokenCount: 3000,
  provider: 'stub',
  model: 'stub-model',
  usage: { inputTokens: 3000, outputTokens: 60, cacheReadTokens: 2500 },
});
session.append('user/message', { role: 'user', content: summaryBlocks }, {
  surfaceOp: { op: 'replace', startSeq: spanStart, endSeq: spanEnd },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowed],
});
const thirdAssistant = session.append('assistant/message', { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'after summary' }] }, stream: [], usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 200 } }, { surfaceOp: 'append' });
session.append('compaction/end', { compactionId: 'cmp-real', turn: 1 });

const registrations = {};
const tools = {};
const ctx = {
  sessionProjections: {
    register: (definition) => { registrations[definition.key] = definition; },
    stateOf: (target, key) => {
      const definition = registrations[key];
      if (!definition) return undefined;
      let state = definition.init(target.header, target.inheritedEventCount);
      for (const event of target.snapshotEvents()) state = definition.apply(state, event);
      return state;
    },
  },
  tools: { register: (definition) => { tools[definition.name] = definition; } },
  sessions: { get: (id) => (id === 'fold-audit-real' ? session : undefined) },
  tokenMeter: { estimateMessage },
};

apply(ctx, Config['~standard'].validate({ threshold: 1 }).value);
const result = await tools.fold_audit.execute({}, { agent: { id: 'fold-audit-real' } });

const surface = [...session.surface.nodes];
const everPlaced = session.snapshotEvents().filter((event) => event.surfaceOp !== undefined).length;
const fold = (kind) => result.ledger.find((item) => item.kind === kind);
const pruneTokens = estimateMessage(toolMessage(bigTool));
const prunedTokens = estimateMessage(toolMessage(smallTool));
const summaryTokens = estimateMessage({ role: 'user', content: summaryBlocks });

const failures = [];
const check = (name, actual, want) => { if (actual !== want) failures.push(`${name}: got ${actual}, expected ${want}`); };

console.log('surface after folds:', surface, '| shadowed:', shadowed, '| everPlaced:', everPlaced);
check('folds', result.netSaving.folds, 2);
check('present', result.coverage.surfaceNodesPresent, surface.length);
check('everPlaced', result.coverage.surfaceNodesEverPlaced, everPlaced);
check('shadowedNodes', result.coverage.surfaceNodesShadowedByFolds, shadowed.length + 1);
check('unaccounted', result.coverage.surfaceNodesUnaccounted, 0);
check('claimsDistinct', result.coverage.shadowedClaimsDistinct, shadowed.length + 1);
check('overlap', result.coverage.overlappingShadowedClaims, 0);
check('stillPresent', result.coverage.shadowedSeqsStillOnSurface, 0);
check('pruneNetSaving', fold('prune').netSaving, pruneTokens - prunedTokens);
check('pruneCacheCost', fold('prune').cacheCost, 500 - 120);
check('summaryNetSaving', fold('summary').netSaving, 3000 - summaryTokens);
check('summaryCacheCost', fold('summary').cacheCost, 1200 - 200);
check('summaryNested', fold('summary').nested, (3000 - summaryTokens) <= 1000);
check('totalNetSaving', result.netSaving.totalNetSaving, (pruneTokens + 3000) - (prunedTokens + summaryTokens));
check('turnsPresent', result.coverage.turnsPresent >= 1, true);
check('thirdAssistantSeq', thirdAssistant.seq > summaryEvent.seq, true);

console.log('coverage:', JSON.stringify(result.coverage, null, 2));
console.log('ledger:', JSON.stringify(result.ledger, null, 2));
console.log('summary:', result.summary);

if (failures.length > 0) {
  console.error('\nFAIL\n' + failures.join('\n'));
  process.exit(1);
}
console.log('\nPASS: the ledger matches the real Session surface semantics.');
