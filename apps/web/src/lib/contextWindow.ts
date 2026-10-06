import type {
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

type BaseContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

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

/** Prefers the provider's live usage report (#8144); falls back to the last compaction item. */
export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: OrchestrationV2TurnItem;
  }>,
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

function deriveBaseContextWindowSnapshot(
  entries: ReadonlyArray<{
    readonly item: OrchestrationV2TurnItem;
  }>,
  liveUsage?: OrchestrationV2ProviderTurnTokenUsage | null,
  providerThread?: Pick<OrchestrationV2ProviderThread, "contextUsage" | "updatedAt"> | null,
): BaseContextWindowSnapshot | null {
  if (liveUsage != null) {
    const usedTokens = Math.max(0, liveUsage.usedTokens);
    const maxTokens = liveUsage.maxTokens ?? null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
    return {
      usedTokens,
      totalProcessedTokens: null,
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: liveUsage.inputTokens ?? null,
      cachedInputTokens: liveUsage.cachedInputTokens ?? null,
      outputTokens: liveUsage.outputTokens ?? null,
      reasoningOutputTokens: liveUsage.reasoningOutputTokens ?? null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: null,
      cost: null,
      updatedAt: liveUsage.updatedAt,
    };
  }
  const providerUsage = providerThread?.contextUsage;
  const providerUsageUpdatedAt = providerThread?.updatedAt;
  if (
    providerUsage !== null &&
    providerUsage !== undefined &&
    providerUsageUpdatedAt !== undefined
  ) {
    const maxTokens = asFiniteNumber(providerUsage.maxTokens);
    const usedTokens = providerUsage.usedTokens;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(providerUsage.totalProcessedTokens),
      maxTokens,
      remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
      usedPercentage,
      remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
      inputTokens: asFiniteNumber(providerUsage.inputTokens),
      cachedInputTokens: asFiniteNumber(providerUsage.cachedInputTokens),
      outputTokens: asFiniteNumber(providerUsage.outputTokens),
      reasoningOutputTokens: asFiniteNumber(providerUsage.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(providerUsage.lastUsedTokens),
      lastInputTokens: asFiniteNumber(providerUsage.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(providerUsage.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(providerUsage.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(providerUsage.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(providerUsage.toolUses),
      durationMs: asFiniteNumber(providerUsage.durationMs),
      compactsAutomatically: providerUsage.compactsAutomatically ?? null,
      cost: providerUsage.cost ?? null,
      autoCompactThreshold: providerUsage.autoCompactThreshold ?? null,
      updatedAt: DateTime.formatIso(providerUsageUpdatedAt),
    };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.item.type !== "compaction") {
      continue;
    }
    const payload = entry.item;
    const usedTokens = asFiniteNumber(payload.afterTokenCount);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = null;
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload.beforeTokenCount),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: true,
      autoCompactThreshold: null,
      cost: null,
      updatedAt: DateTime.formatIso(payload.startedAt ?? payload.updatedAt),
    };
  }

  return null;
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
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
