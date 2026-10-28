import type { ResolvedEntry } from '../config/resolve.ts';
import { estimateCostUsd } from './cost.ts';

// shortcut: fixed per-call token assumption (6k in, 300 out); replace with measured per-call usage from Phase 0 runs.
function costLine(entry: ResolvedEntry): {
  text: string;
  maxUsd: number | null;
  perRun: { minUsd: number; maxUsd: number } | null;
} {
  const { pricesPerMTok: prices, untested } = entry.request.catalog.entry;
  const { steps, dollars } = entry.request.limits;
  const perCall = estimateCostUsd(
    {
      inputTokens: 6000,
      outputTokens: 300,
      cachedInputTokens: 0,
      imageInputTokens: null,
      reportedCostUsd: null,
      source: 'estimated',
    },
    prices,
  );
  const perRun = perCall === null ? null : { minUsd: perCall * 2, maxUsd: Math.min(dollars, perCall * steps) };
  const cost =
    perRun === null
      ? 'cost unknown; dollar cap unenforceable'
      : `estimated $${perRun.minUsd.toFixed(2)}-$${perRun.maxUsd.toFixed(2)} per run`;
  return {
    text: `untested: ${untested ? 'yes' : 'no'}; ${cost}`,
    maxUsd: perCall === null ? null : dollars * entry.request.repeats,
    perRun,
  };
}

export interface EntryPlan {
  personaId: string;
  provider: string;
  model: string;
  effort: string;
  modelFrom: string;
  effortFrom: string;
  untested: boolean;
  repeats: number;
  limits: { steps: number; timeMs: number; dollars: number };
  /** Catalog price x step-cap estimate per run; null when prices are unknown. */
  estimatePerRun: { minUsd: number; maxUsd: number } | null;
}

/** Per-entry plan lines and the maximum batch spend, or null when some prices are unknown. */
export function preflight(entries: readonly ResolvedEntry[]): {
  lines: string[];
  plans: EntryPlan[];
  maxBatchUsd: number | null;
} {
  let maxBatchUsd: number | null = 0;
  const plans: EntryPlan[] = [];
  const lines = entries.map((entry, index) => {
    const { request, layers } = entry;
    const cost = costLine(entry);
    maxBatchUsd = cost.maxUsd === null || maxBatchUsd === null ? null : maxBatchUsd + cost.maxUsd;
    plans.push({
      personaId: entry.persona.id,
      provider: request.provider,
      model: request.model,
      effort: request.effort,
      modelFrom: layers.modelFrom,
      effortFrom: layers.effortFrom,
      untested: request.catalog.entry.untested,
      repeats: request.repeats,
      limits: { ...request.limits },
      estimatePerRun: cost.perRun,
    });
    return `${index + 1}. ${entry.persona.id} x${request.repeats}: ${request.provider}/${request.model} effort ${request.effort} (model from ${layers.modelFrom}, effort from ${layers.effortFrom}); ${cost.text}; caps ${request.limits.steps} steps, ${request.limits.timeMs} ms, $${request.limits.dollars}`;
  });
  return { lines, plans, maxBatchUsd };
}
