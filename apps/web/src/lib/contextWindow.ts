import {
  deriveLatestContextWindowSnapshot as deriveBaseContextWindowSnapshot,
  type ContextWindowSnapshot as BaseContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";

export { latestProviderTurnTokenUsage } from "@t3tools/client-runtime/state/context-window";

export type ContextWindowSnapshot = BaseContextWindowSnapshot & {
  /** Total tokens processed over the thread (falls back to current context usage). */
  readonly threadTotalTokens: number;
  /** API-equivalent spend in USD when the provider reported a USD cost. */
  readonly threadTotalCostUsd: number | null;
  /**
   * True when the reported spend covers only part of the thread's real usage:
   * a provider turn flagged `costUsdIncomplete`, or a completed turn that
   * reported no cost at all.
   */
  readonly threadTotalCostUsdIncomplete: boolean;
};

/**
 * Thread spend: the sum of each provider turn's modeled `costUsd`. Returns a
 * null total when no turn priced anything. A turn that is flagged
 * `costUsdIncomplete`, or completed without any cost, makes the total partial.
 */
export function sumProviderTurnCost(
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "status" | "turnTokenUsage">>,
): { readonly totalUsd: number | null; readonly incomplete: boolean } {
  let total = 0;
  let priced = false;
  let incomplete = false;
  for (const turn of providerTurns) {
    const costUsd = turn.turnTokenUsage?.costUsd;
    if (costUsd === undefined) {
      if (turn.status === "completed") incomplete = true;
      continue;
    }
    total += costUsd;
    priced = true;
    if (turn.turnTokenUsage?.costUsdIncomplete === true) incomplete = true;
  }
  return { totalUsd: priced ? total : null, incomplete };
}

export function deriveLatestContextWindowSnapshot(
  entries: Parameters<typeof deriveBaseContextWindowSnapshot>[0],
  liveUsage?: OrchestrationV2ProviderTurnTokenUsage | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage" | "updatedAt"> | null,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "status" | "turnTokenUsage">> = [],
): ContextWindowSnapshot | null {
  const base = deriveBaseContextWindowSnapshot(entries, liveUsage, providerThread);
  if (base === null) {
    return null;
  }
  const spend = sumProviderTurnCost(providerTurns);
  return {
    ...base,
    threadTotalTokens: Math.max(base.totalProcessedTokens ?? 0, base.usedTokens),
    // ACP-style providers report one thread cost figure and no per-turn cost.
    threadTotalCostUsd:
      spend.totalUsd ??
      (base.cost != null && base.cost.currency.toUpperCase() === "USD" ? base.cost.amount : null),
    threadTotalCostUsdIncomplete: spend.incomplete,
  };
}

// Callers can use this to keep a stable object identity across unrelated
// timeline updates (e.g. streaming tool events) so memoized consumers don't
// re-render when the usage snapshot did not actually change.
export function isSameContextWindowSnapshot(
  a: ContextWindowSnapshot,
  b: ContextWindowSnapshot,
): boolean {
  return (
    a.updatedAt === b.updatedAt &&
    a.usedTokens === b.usedTokens &&
    a.threadTotalTokens === b.threadTotalTokens &&
    a.threadTotalCostUsd === b.threadTotalCostUsd &&
    a.threadTotalCostUsdIncomplete === b.threadTotalCostUsdIncomplete
  );
}

export function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function formatCostUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value > 0 && value < 0.01) {
    return "<$0.01";
  }
  if (value < 100) {
    return `$${value.toFixed(2)}`;
  }
  return `$${Math.round(value)}`;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
