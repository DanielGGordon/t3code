import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly threadTotalTokens: number;
  readonly threadTotalCostUsd: number | null;
  /**
   * True when any session in the thread reported unpriced token usage, so
   * `threadTotalCostUsd` covers only part of the thread's real spend.
   */
  readonly threadTotalCostUsdIncomplete: boolean;
  readonly activityId: string;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  // Providers report cumulative totals unevenly: Codex sends a genuine
  // thread-cumulative total on every update, while Claude only attaches one at
  // turn end and its accumulator restarts with the CLI process. Track the
  // total across ALL snapshots — summing across accumulator resets — so the
  // thread total never regresses when the latest snapshot lacks it.
  let committedTotal = 0;
  let runningTotal: number | null = null;
  // costUsd has the same per-provider-session cumulative semantics as
  // totalProcessedTokens, so it gets the same reset-tolerant accumulator.
  let committedCostUsd = 0;
  let runningCostUsd: number | null = null;
  let costUsdIncomplete = false;
  let peakUsedTokens = 0;
  let latest: { activity: OrchestrationThreadActivity; usedTokens: number } | null = null;

  for (const activity of activities) {
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }
    const totalProcessedTokens = asFiniteNumber(payload?.totalProcessedTokens);
    if (totalProcessedTokens !== null && totalProcessedTokens > 0) {
      if (runningTotal !== null && totalProcessedTokens < runningTotal) {
        committedTotal += runningTotal;
      }
      runningTotal = totalProcessedTokens;
    }
    const costUsd = asFiniteNumber(payload?.costUsd);
    if (costUsd !== null && costUsd >= 0) {
      if (runningCostUsd !== null && costUsd < runningCostUsd) {
        // Session restarted: bank the previous run before tracking the new one.
        committedCostUsd += runningCostUsd;
      }
      runningCostUsd = costUsd;
    }
    if (asBoolean(payload?.costUsdIncomplete) === true) {
      costUsdIncomplete = true;
    }
    peakUsedTokens = Math.max(peakUsedTokens, usedTokens);
    latest = { activity, usedTokens };
  }

  if (!latest) {
    return null;
  }

  const payload = asRecord(latest.activity.payload);
  const usedTokens = latest.usedTokens;
  const maxTokens = asFiniteNumber(payload?.maxTokens);
  const usedPercentage =
    maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
  const remainingTokens =
    maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
  const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;
  const threadTotalTokens = Math.max(committedTotal + (runningTotal ?? 0), peakUsedTokens);
  const threadTotalCostUsd =
    runningCostUsd === null && committedCostUsd === 0
      ? null
      : committedCostUsd + (runningCostUsd ?? 0);

  return {
    usedTokens,
    totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
    maxTokens,
    remainingTokens,
    usedPercentage,
    remainingPercentage,
    threadTotalTokens,
    threadTotalCostUsd,
    threadTotalCostUsdIncomplete: costUsdIncomplete,
    costUsd: asFiniteNumber(payload?.costUsd),
    costUsdIncomplete: asBoolean(payload?.costUsdIncomplete),
    inputTokens: asFiniteNumber(payload?.inputTokens),
    cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
    outputTokens: asFiniteNumber(payload?.outputTokens),
    reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
    lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
    lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
    lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
    lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
    lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
    toolUses: asFiniteNumber(payload?.toolUses),
    durationMs: asFiniteNumber(payload?.durationMs),
    compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
    activityId: String(latest.activity.id),
    updatedAt: latest.activity.createdAt,
  };
}

// A snapshot only changes when a new context-window activity lands (new
// activityId) or an earlier activity adjusts the accumulated total. Callers
// can use this to keep a stable object identity across unrelated activity
// appends (e.g. streaming tool events) so memoized consumers don't re-render.
export function isSameContextWindowSnapshot(
  a: ContextWindowSnapshot,
  b: ContextWindowSnapshot,
): boolean {
  return (
    a.activityId === b.activityId &&
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
