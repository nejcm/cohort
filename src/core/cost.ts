import type { Prices } from '../providers/catalog.ts';
import type { Usage } from '../providers/types.ts';

export type CapEnforcement = 'priced_reservations' | 'provider_reported_cost' | 'step_time_only';

// Rates are USD per million tokens; unknown rates never count as zero.
export function estimateCostUsd(usage: Usage, prices: Prices): number | null {
  const cached = usage.cachedInputTokens ?? 0;
  if (prices.input === null || prices.output === null) return null;
  if (cached > 0 && prices.cachedInput === null) return null;
  return (
    ((usage.inputTokens - cached) * prices.input +
      cached * (prices.cachedInput ?? 0) +
      usage.outputTokens * prices.output) /
    1_000_000
  );
}

export class CostMeter {
  readonly maxUsd: number;
  readonly prices: Prices;
  settledUsd = 0;
  reportedUsd = 0;
  unsettledUsd = 0;
  private reportedSeen = false;

  constructor(maxUsd: number, prices: Prices) {
    this.maxUsd = maxUsd;
    this.prices = prices;
  }

  get enforcement(): CapEnforcement {
    if (this.prices.input !== null && this.prices.output !== null) return 'priced_reservations';
    return this.reportedSeen ? 'provider_reported_cost' : 'step_time_only';
  }

  get spentUsd(): number {
    return this.enforcement === 'provider_reported_cost' ? this.reportedUsd : this.settledUsd + this.unsettledUsd;
  }

  /** Returns the reserved amount, or null when the call would not fit the remaining budget. */
  reserve(maxInputTokens: number, maxOutputTokens: number): number | null {
    if (this.enforcement === 'priced_reservations') {
      const amount =
        (maxInputTokens * (this.prices.input ?? 0) + maxOutputTokens * (this.prices.output ?? 0)) / 1_000_000;
      return this.spentUsd + amount > this.maxUsd ? null : amount;
    }
    return this.enforcement === 'provider_reported_cost' && this.reportedUsd >= this.maxUsd ? null : 0;
  }

  settle(reserved: number, usage: Usage | null): void {
    if (!usage) {
      this.unsettledUsd += reserved;
      return;
    }
    this.settledUsd += estimateCostUsd(usage, this.prices) ?? 0;
    if (usage.reportedCostUsd !== null) {
      this.reportedSeen = true;
      this.reportedUsd += usage.reportedCostUsd;
    }
  }

  get exhausted(): boolean {
    return this.enforcement !== 'step_time_only' && this.spentUsd >= this.maxUsd;
  }
}
