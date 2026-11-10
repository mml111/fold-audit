/**
 * Run the fold-audit plugin against a REAL stored session log.
 *
 * Reads a `session.v4.jsonl.zstd` file, replays the surface exactly as the
 * Session engine does, folds the plugin's projection over the actual events,
 * and prints the audit. This validates the arithmetic on genuine harness data
 * rather than synthetic fixtures.
 *
 * Run with:
 *   node scripts/fold-audit-from-log.mjs <path-to-session.v4.jsonl.zstd>
 */
import { execFileSync } from 'node:child_process';
import { apply, Config } from '../dsh-plugin/index.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/fold-audit-from-log.mjs <session.v4.jsonl.zstd>');
  process.exit(1);
}

const text = execFileSync('unzstd', ['-c', path], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
const lines = text.split('\n').filter(Boolean);
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map((line) => JSON.parse(line));

// Replay the surface: every surface event places one node; a replace removes
// the span it names and inserts itself.
const surface = [];
for (const event of events) {
  if (event.surfaceOp === 'append') surface.push(event.seq);
  else if (event.surfaceOp?.op === 'replace') {
    const startIdx = surface.indexOf(event.surfaceOp.startSeq);
    const endIdx = surface.indexOf(event.surfaceOp.endSeq);
    if (startIdx < 0 || endIdx < 0) {
      console.error(`surface replay could not locate range ${event.surfaceOp.startSeq}..${event.surfaceOp.endSeq}`);
      continue;
    }
    surface.splice(startIdx, endIdx - startIdx + 1, event.seq);
  }
}

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
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

const session = {
  id: header.id,
  header,
  inheritedEventCount: header.inheritedEventCount ?? 0,
  surface: { nodes: surface },
  snapshotEvents: () => events,
};

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
  sessions: { get: (id) => (id === session.id ? session : undefined) },
  tokenMeter: { estimateMessage },
};

apply(ctx, Config['~standard'].validate({}).value);
const result = await tools.fold_audit.execute({}, { agent: { id: session.id } });

const foldTypes = events.filter((event) => event.type === 'compaction/summary' || event.type === 'compaction/prune').length;
const surfaceEvents = events.filter((event) => event.surfaceOp !== undefined).length;

console.log(`session ${header.id}`);
console.log(`events=${events.length} surfaceEvents=${surfaceEvents} compactionEvents=${foldTypes} presentSurface=${surface.length}`);
console.log('\ncoverage:\n' + JSON.stringify(result.coverage, null, 2));
console.log('\nnetSaving:\n' + JSON.stringify(result.netSaving, null, 2));
console.log('\ncacheCost:\n' + JSON.stringify(result.cacheCost, null, 2));
console.log('\nnestedPasses:\n' + JSON.stringify(result.nestedPasses, null, 2));
console.log('\nledger (first 10 folds):');
for (const fold of result.ledger.slice(0, 10)) {
  console.log(`  seq ${fold.seq} ${fold.kind} shadowed=${fold.shadowedCount} removed=${fold.shadowedTokens} kept=${fold.replacementTokens} net=${fold.netSaving} cacheCost=${fold.cacheCost} nested=${fold.nested}`);
}
console.log('\nsummary: ' + result.summary);
