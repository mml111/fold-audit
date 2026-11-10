/**
 * fold-audit — read-only audit of the harness's own compaction log.
 *
 * The Harness already emits everything this audit needs as durable session
 * events: `compaction/summary` and `compaction/prune` carry the authoritative
 * shadowed seq set, the heuristic price of the shadowed content, and the
 * summarisation call's provider usage. Nothing here intercepts a request; it
 * folds the log that already exists.
 *
 * Four numbers are computed per session:
 *   1. coverage      — how many surface nodes a fold shadowed, and whether any
 *                      turn is neither present on the surface nor covered by a
 *                      fold
 *   2. net saving    — `shadowedTokenCount - replacementTokens`, per fold
 *   3. cache cost    — `inputTokens - cacheReadTokens` of the first assistant
 *                      usage committed after the fold: the re-prefill the
 *                      rewrite forced on the next request
 *   4. nested passes — folds whose net saving is no greater than their cache
 *                      cost, at the configured threshold
 *
 * There is no `compaction/summary` listener event in the Host Event catalogue
 * (only `compaction/summary-error`), so the ledger rides `ctx.sessionProjections`,
 * which the framework drives from `session/event` for every committed event.
 *
 * @module @local/fold-audit
 */

/** Hard services this plugin needs; the row fails to activate without them. */
export const inject = ['tools', 'sessionProjections', 'sessions', 'tokenMeter'];

/**
 * Tunables live in the patch layer, so a user's override survives upgrades.
 *
 * The Loader validates `Config` through the standard-schema interface
 * (`Config["~standard"].validate(config)`), and the resolved value reaches
 * `apply`. This bundle deliberately declares no dependencies: a linked bundle
 * resolves imports from its own checkout, not from the profile's node_modules,
 * so an external schema library would be a fragile install surface.
 */
export const Config = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', default: true, description: 'Register the ledger and the tool at all.' },
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 10,
      default: 1,
      description: 'A fold is a nested pass when cacheCost >= netSaving * threshold.',
    },
  },
  '~standard': {
    validate(value) {
      if (value === undefined || value === null) return { value: { enabled: true, threshold: 1 } };
      if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'fold-audit config must be an object' }] };
      const issues = [];
      for (const [key, rule] of Object.entries(Config.properties)) {
        if (!(key in value)) continue;
        const item = value[key];
        if (rule.type === 'boolean' && typeof item !== 'boolean') issues.push({ message: `config.${key} must be a boolean` });
        if (rule.type === 'number') {
          if (typeof item !== 'number' || !Number.isFinite(item)) issues.push({ message: `config.${key} must be a finite number` });
          else if (item < rule.minimum || item > rule.maximum) issues.push({ message: `config.${key} must be between ${rule.minimum} and ${rule.maximum}` });
        }
      }
      if (issues.length > 0) return { issues };
      return {
        value: {
          enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
          threshold: typeof value.threshold === 'number' ? value.threshold : 1,
        },
      };
    },
  },
};

/** Detail caps keep checkpointed state bounded; every limit hit is reported. */
const MAX_FOLDS = 500;
const MAX_SEQS_PER_FOLD = 200;
const MAX_USAGE_RECORDS = 20000;

const usageSchema = {
  parse: (value) => {
    if (value === null) return null;
    if (typeof value !== 'object' || value === null) throw new Error('fold-audit usage record is not an object');
    return { inputTokens: finite(value.inputTokens), outputTokens: finite(value.outputTokens), cacheReadTokens: finite(value.cacheReadTokens) };
  },
};

const foldSchema = {
  parse: (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fold-audit fold record is not an object');
    return {
      seq: finite(value.seq) ?? 0,
      kind: value.kind === 'prune' ? 'prune' : 'summary',
      compactionId: typeof value.compactionId === 'string' ? value.compactionId : null,
      range: { start: finite(value.range?.start) ?? 0, end: finite(value.range?.end) ?? 0 },
      shadowedSeqs: Array.isArray(value.shadowedSeqs) ? value.shadowedSeqs.map((seq) => finite(seq) ?? 0) : [],
      shadowedCount: finite(value.shadowedCount) ?? 0,
      shadowedTokens: finite(value.shadowedTokens) ?? 0,
      summaryTokens: finite(value.summaryTokens),
      replacementSeq: finite(value.replacementSeq),
      replacementTokens: finite(value.replacementTokens),
      summariserUsage: value.summariserUsage === null ? null : usageSchema.parse(value.summariserUsage),
    };
  },
};

const ledgerSchema = {
  parse: (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fold-audit ledger is not an object');
    return {
      folds: Array.isArray(value.folds) ? value.folds.map(foldSchema.parse) : [],
      foldCount: finite(value.foldCount) ?? 0,
      detailDropped: finite(value.detailDropped) ?? 0,
      shadowedTokenTotal: finite(value.shadowedTokenTotal) ?? 0,
      replacementTokenTotal: finite(value.replacementTokenTotal) ?? 0,
      usageRecords: Array.isArray(value.usageRecords) ? value.usageRecords.map((record) => ({ seq: finite(record?.seq) ?? 0, usage: usageSchema.parse(record?.usage) })) : [],
      usageCount: finite(value.usageCount) ?? 0,
      usageDetailDropped: finite(value.usageDetailDropped) ?? 0,
      pendingFoldSeq: finite(value.pendingFoldSeq),
    };
  },
};

/** Finite number or null, so an absent provider field stays null, never 0. */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Project one provider TokenUsage into the ledger's plain-JSON shape. */
function readUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: finite(usage.inputTokens),
    outputTokens: finite(usage.outputTokens),
    cacheReadTokens: finite(usage.cacheReadTokens),
    cacheWriteTokens: finite(usage.cacheWriteTokens),
  };
}

/**
 * Price content blocks with the meter service's own fixed-density estimator.
 * The fallback mirrors `dsh-token-meter/estimate` (4 characters per token plus
 * 4 tokens of block framing) so a meter failure degrades to the same
 * arithmetic rather than to a guess.
 */
function measureBlocks(tokenMeter, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  try {
    const value = tokenMeter.estimateMessage({ role: 'user', content: blocks });
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  } catch {
    /* fall through to the local heuristic below */
  }
  let tokens = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      tokens += 4;
      continue;
    }
    if (block.type === 'text' || block.type === 'reasoning') {
      tokens += Math.ceil((block.text?.length ?? 0) / 4) + 4;
    } else if (block.type === 'tool-call') {
      tokens += Math.ceil((block.name?.length ?? 0) / 4) + Math.ceil((block.arguments?.length ?? 0) / 4) + 4;
    } else {
      tokens += 4 + Math.ceil(JSON.stringify(block).length / 4);
    }
  }
  return tokens;
}

/** The message a surface event carries, whatever the event shape is. */
function surfaceMessage(event) {
  if (event.type === 'user/message' || event.type === 'system/message') return event.data;
  return event.data?.message;
}

/** Empty ledger for a session that has never folded. */
function initLedger() {
  return {
    folds: [],
    foldCount: 0,
    detailDropped: 0,
    shadowedTokenTotal: 0,
    replacementTokenTotal: 0,
    usageRecords: [],
    usageCount: 0,
    usageDetailDropped: 0,
    pendingFoldSeq: null,
  };
}

/**
 * One fold's derived numbers. `cacheCost` is null when no assistant usage has
 * committed after the fold yet: that is reported as unknown, never as 0.
 */
function scoreFold(fold, usageRecords, threshold) {
  const replacementTokens = fold.replacementTokens ?? fold.summaryTokens ?? 0;
  const netSaving = fold.shadowedTokens - replacementTokens;
  let cacheCost = null;
  let cacheRequestSeq = null;
  for (const [seq, inputTokens, cacheReadTokens, cacheWriteTokens] of usageRecords) {
    if (seq <= fold.seq) continue;
    if (inputTokens === null) continue;
    // The provider's identity is total = input + output + cacheRead + cacheWrite,
    // so `inputTokens` is ALREADY the fresh, uncached part of the prompt.
    // Subtracting cacheRead from it double-counts and can go negative.
    cacheCost = inputTokens + (cacheWriteTokens ?? 0);
    cacheRequestSeq = seq;
    break;
  }
  return {
    seq: fold.seq,
    kind: fold.kind,
    compactionId: fold.compactionId,
    shadowedRange: fold.range,
    shadowedCount: fold.shadowedCount,
    shadowedTokens: fold.shadowedTokens,
    replacementSeq: fold.replacementSeq,
    replacementTokens,
    netSaving,
    cacheCost,
    cacheRequestSeq,
    summariserInputTokens: fold.summariserUsage?.inputTokens ?? null,
    summariserOutputTokens: fold.summariserUsage?.outputTokens ?? null,
    nested: cacheCost !== null && cacheCost >= netSaving * threshold,
  };
}

/**
 * Exact turn accounting, folded from the durable log at read time so coverage
 * stays correct even when the stored ledger hits its detail cap. Every surface
 * event places exactly one node; every node a fold shadows is removed from the
 * surface. A node is covered when it is still present or named by some fold's
 * shadowedSeqs. A turn is unaccounted when it placed a node that is neither.
 */
function coverageReport(session) {
  const present = new Set(session.surface.nodes ?? []);
  const shadowed = new Set();
  const rewritten = new Set();
  let shadowClaims = 0;
  const nodes = [];
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      for (const seq of event.data?.shadowedSeqs ?? []) {
        shadowed.add(seq);
        shadowClaims += 1;
      }
      continue;
    }
    if (event.surfaceOp === undefined) continue;
    nodes.push({
      seq: event.seq,
      turn: typeof event.data?.turn === 'number' ? event.data.turn : 0,
    });
    if (event.surfaceOp !== 'append') {
      for (const seq of event.sourceEventSeqs ?? []) {
        if (seq !== event.seq) rewritten.add(seq);
      }
    }
  }

  const turns = new Map();
  let nodesPresent = 0;
  let nodesShadowed = 0;
  let nodesRewritten = 0;
  let nodesUnaccounted = 0;
  const unaccountedSeqs = [];
  for (const node of nodes) {
    const isPresent = present.has(node.seq);
    const isCovered = shadowed.has(node.seq);
    if (isPresent) nodesPresent += 1;
    else if (isCovered) nodesShadowed += 1;
    else if (rewritten.has(node.seq)) nodesRewritten += 1;
    else {
      nodesUnaccounted += 1;
      if (unaccountedSeqs.length < 50) unaccountedSeqs.push(node.seq);
    }
    const entry = turns.get(node.turn) ?? { present: false, shadowed: false, rewritten: false, unaccounted: false };
    if (isPresent) entry.present = true;
    else if (isCovered) entry.shadowed = true;
    else if (rewritten.has(node.seq)) entry.rewritten = true;
    else entry.unaccounted = true;
    turns.set(node.turn, entry);
  }

  let presentTurns = 0;
  let shadowedOnlyTurns = 0;
  let rewrittenOnlyTurns = 0;
  let unaccountedTurns = 0;
  for (const entry of turns.values()) {
    if (entry.present) presentTurns += 1;
    else if (entry.unaccounted) unaccountedTurns += 1;
    else if (entry.shadowed) shadowedOnlyTurns += 1;
    else if (entry.rewritten) rewrittenOnlyTurns += 1;
  }

  return {
    surfaceNodesEverPlaced: nodes.length,
    surfaceNodesPresent: nodesPresent,
    surfaceNodesShadowedByFolds: nodesShadowed,
    surfaceNodesRewrittenWithoutShadowPrice: nodesRewritten,
    surfaceNodesUnaccounted: nodesUnaccounted,
    unaccountedSeqsSample: unaccountedSeqs,
    shadowedClaimsTotal: shadowClaims,
    shadowedClaimsDistinct: shadowed.size,
    overlappingShadowedClaims: shadowClaims - shadowed.size,
    shadowedSeqsStillOnSurface: [...shadowed].filter((seq) => present.has(seq)).length,
    turnsSeen: turns.size,
    turnsPresent: presentTurns,
    turnsShadowedOnly: shadowedOnlyTurns,
    turnsRewrittenOnly: rewrittenOnlyTurns,
    turnsNeitherPresentNorCovered: unaccountedTurns,
  };
}

/** Register the ledger unit and the model-facing tool for one activation. */
export function apply(ctx, config) {
  if (!config.enabled) return undefined;
  const tokenMeter = ctx.tokenMeter;
  const threshold = config.threshold;

  ctx.sessionProjections.register({
    key: 'foldAudit',
    stateSchema: ledgerSchema,
    stateVersion: 1,
    init: initLedger,
    apply: (state, event) => {
      if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
        const data = event.data ?? {};
        const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
        // A summary's body is known immediately; a prune's replacement is only
        // known when its paired replace event commits. Either way the running
        // total is corrected when the replacement lands, so the aggregate stays
        // exact even when the fold detail is capped.
        const summaryTokens = event.type === 'compaction/summary' ? measureBlocks(tokenMeter, data.summary) : 0;
        const fold = {
          seq: event.seq,
          kind: event.type === 'compaction/summary' ? 'summary' : 'prune',
          compactionId: typeof data.compactionId === 'string' ? data.compactionId : null,
          range: {
            start: finite(data.shadowedRange?.start) ?? 0,
            end: finite(data.shadowedRange?.end) ?? 0,
          },
          shadowedSeqs: seqs.slice(0, MAX_SEQS_PER_FOLD),
          shadowedCount: seqs.length,
          shadowedTokens: finite(data.shadowedTokenCount) ?? 0,
          summaryTokens,
          replacementSeq: null,
          replacementTokens: null,
          summariserUsage: readUsage(data.usage),
        };
        return {
          ...state,
          folds: state.folds.length < MAX_FOLDS ? [...state.folds, fold] : state.folds,
          foldCount: state.foldCount + 1,
          detailDropped: state.folds.length >= MAX_FOLDS ? state.detailDropped + 1 : state.detailDropped,
          shadowedTokenTotal: state.shadowedTokenTotal + fold.shadowedTokens,
          pendingFoldSeq: event.seq,
        };
      }

      if (event.type === 'assistant/message') {
        const usage = readUsage(event.data?.usage);
        if (usage === null) return state;
        return {
          ...state,
          usageRecords: state.usageRecords.length < MAX_USAGE_RECORDS
            ? [...state.usageRecords, [event.seq, usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]]
            : state.usageRecords,
          usageCount: state.usageCount + 1,
          usageDetailDropped: state.usageRecords.length >= MAX_USAGE_RECORDS ? state.usageDetailDropped + 1 : state.usageDetailDropped,
        };
      }

      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append' && state.pendingFoldSeq !== null) {
        // The contract pairs a replacement with the metering event immediately
        // before it, so the first replace surface event after a fold is it.
        const message = surfaceMessage(event);
        const replacementTokens = message?.content ? measureBlocks(tokenMeter, message.content) : 0;
        const index = state.folds.findIndex((fold) => fold.seq === state.pendingFoldSeq);
        const folds = index < 0
          ? state.folds
          : state.folds.map((fold, position) => (position === index ? { ...fold, replacementSeq: event.seq, replacementTokens } : fold));
        return {
          ...state,
          folds,
          replacementTokenTotal: state.replacementTokenTotal + replacementTokens,
          pendingFoldSeq: null,
        };
      }

      return state;
    },
  });

  ctx.tools.register({
    name: 'fold_audit',
    description:
      'Audit context compaction in the current session from its durable event log. For every fold '
      + '(compaction summary or prune) it reports the surface nodes it shadowed, the heuristic tokens '
      + 'removed, the size of the replacement, the re-prefill forced on the next request, and whether '
      + 'the fold saved no more than it cost. Read-only; it changes nothing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const sessionId = exec.agent?.id;
      const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
      if (!session) {
        return { ok: false, error: 'fold_audit needs an agent-bound session; none is attached to this call.' };
      }

      const state = ctx.sessionProjections.stateOf(session, 'foldAudit');
      if (state === undefined) {
        return { ok: false, error: 'the fold ledger is not registered in this profile.' };
      }

      const ledger = state.folds.map((fold) => scoreFold(fold, state.usageRecords, threshold));
      const coverage = coverageReport(session);

      let totalSaving = 0;
      let perFoldCacheCost = 0;
      let costKnown = 0;
      let nested = 0;
      const distinctCache = new Map();
      for (const fold of ledger) {
        totalSaving += fold.netSaving;
        if (fold.cacheCost !== null) {
          perFoldCacheCost += fold.cacheCost;
          distinctCache.set(fold.cacheRequestSeq, fold.cacheCost);
          costKnown += 1;
          if (fold.nested) nested += 1;
        }
      }
      // Several folds can precede the same request; counting each fold's share
      // of one request double-counts it, so the distinct total is the honest one.
      const distinctCacheCost = [...distinctCache.values()].reduce((sum, cost) => sum + cost, 0);

      const summary = state.foldCount === 0
        ? `No compaction fold recorded in this session: the surface holds ${coverage.surfaceNodesPresent} node(s) across ${coverage.turnsSeen} turn(s) and nothing has been shadowed`
          + (coverage.surfaceNodesUnaccounted > 0
            ? `, but ${coverage.surfaceNodesUnaccounted} surface node(s) were removed without any fold claiming them (seqs ${coverage.unaccountedSeqsSample.join(', ')}).`
            : '.')
        : `${state.foldCount} fold(s) shadowed ${coverage.surfaceNodesShadowedByFolds} surface node(s) of ${coverage.surfaceNodesEverPlaced} ever placed, removing ${state.shadowedTokenTotal} and leaving ${state.replacementTokenTotal} heuristic tokens (net ${state.shadowedTokenTotal - state.replacementTokenTotal}). `
          + `${costKnown} of the ${state.foldCount} recorded folds have a measurable next-request cache cost: ${perFoldCacheCost} summed per fold, ${distinctCacheCost} across ${distinctCache.size} distinct requests; ${nested} folds saved no more than they cost. `
          + (costKnown === 0
            ? 'No assistant usage was recorded after any fold, so cache cost is unknown here — not zero. '
            : (state.shadowedTokenTotal - state.replacementTokenTotal >= distinctCacheCost
              ? 'Compaction is cost-honest overall: net saving exceeds measured re-prefill. '
              : `Compaction costs more than it removes overall: ${distinctCacheCost} re-prefill against ${state.shadowedTokenTotal - state.replacementTokenTotal} saved. `))
          + (coverage.surfaceNodesRewrittenWithoutShadowPrice > 0
            ? `${coverage.surfaceNodesRewrittenWithoutShadowPrice} surface node(s) were rewritten without a shadow-price event (prompt updates); they are not counted as losses. `
            : '')
          + (coverage.turnsNeitherPresentNorCovered > 0
            ? `Coverage gap: ${coverage.turnsNeitherPresentNorCovered} turn(s) are neither on the surface nor covered by a fold. `
            : 'No coverage gap: every turn is either present or covered by a fold.');

      return {
        ok: true,
        sessionId,
        summary,
        coverage,
        netSaving: {
          folds: state.foldCount,
          totalShadowedTokens: state.shadowedTokenTotal,
          totalReplacementTokens: state.replacementTokenTotal,
          totalNetSaving: state.shadowedTokenTotal - state.replacementTokenTotal,
          detailNetSaving: totalSaving,
        },
        cacheCost: {
          foldsWithMeasuredCost: costKnown,
          foldsWithoutMeasuredCost: Math.min(state.foldCount, MAX_FOLDS) - costKnown,
          perFoldCacheCost,
          distinctRequests: distinctCache.size,
          distinctCacheCost,
          threshold,
        },
        costHonesty: {
          property: 'tokensSaved >= rePrefill - newContent',
          totalNetSaving: state.shadowedTokenTotal - state.replacementTokenTotal,
          distinctCacheCost,
          measured: costKnown > 0,
          honest: costKnown > 0
            ? state.shadowedTokenTotal - state.replacementTokenTotal >= distinctCacheCost
            : null,
        },
        nestedPasses: { count: nested, folds: ledger.filter((fold) => fold.nested) },
        ledger,
        ledgerLimits: {
          folds: state.foldCount,
          detailStored: state.folds.length,
          detailDropped: state.detailDropped,
          maxFolds: MAX_FOLDS,
          usageRecords: state.usageCount,
          usageRecordsStored: state.usageRecords.length,
          usageRecordsDropped: state.usageDetailDropped,
          maxUsageRecords: MAX_USAGE_RECORDS,
        },
        method: {
          tokenEstimator: 'fixed-density heuristic via ctx.tokenMeter.estimateMessage; provider usage is used only where the log carries it',
          coverageRule: 'a surface node is covered when it is still on the surface, named by a fold shadowedSeqs entry, or named as a rewrite source by a later surface event; a turn is covered when every node it placed is covered',
          cacheAttribution: 'several folds can precede one request; perFoldCacheCost double-counts those, distinctCacheCost does not',
          nestedRule: 'nested when cacheCost >= netSaving * threshold',
          cacheAttribution: 'perFoldCacheCost counts each fold separately; distinctCacheCost counts each request once, which is the number to compare against saving',
        },
      };
    },
  });

  return undefined;
}
