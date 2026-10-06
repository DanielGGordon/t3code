import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  formatCostUsd,
  isSameContextWindowSnapshot,
} from "./contextWindow";

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      {
        item: {
          id: "compaction-1" as never,
          threadId: "thread-1" as never,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          type: "compaction",
          driver: null,
          beforeTokenCount: 10_000,
          afterTokenCount: 2_000,
        },
      },
    ]);
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBe(10_000);
  });

  it("prefers current provider usage and preserves ACP cost", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: {
        usedTokens: 2_500,
        maxTokens: 10_000,
        cost: { amount: 0.42, currency: "USD" },
      },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      usedTokens: 2_500,
      maxTokens: 10_000,
      remainingTokens: 7_500,
      usedPercentage: 25,
      cost: { amount: 0.42, currency: "USD" },
    });
  });

  it("formats compact token values", () => {
    expect(formatContextWindowTokens(1_500)).toBe("1.5k");
  });
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
  });

  it("handles a report without a known context window", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 42_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.usedPercentage).toBeNull();
  });

  it("prefers total processed tokens for thread totals, falling back to context usage", () => {
    const withTotals = deriveLatestContextWindowSnapshot([], {
      usedTokens: 81_659,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(withTotals?.threadTotalTokens).toBe(81_659);

    const withProviderTotal = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: { usedTokens: 81_659, totalProcessedTokens: 748_126 },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });
    expect(withProviderTotal?.threadTotalTokens).toBe(748_126);
  });

  it("derives the thread spend from a USD cost and ignores other currencies", () => {
    const usd = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: { usedTokens: 1_000, cost: { amount: 1.25, currency: "USD" } },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });
    expect(usd?.threadTotalCostUsd).toBe(1.25);
    expect(usd?.threadTotalCostUsdIncomplete).toBe(false);

    const eur = deriveLatestContextWindowSnapshot([], undefined, {
      contextUsage: { usedTokens: 1_000, cost: { amount: 1.25, currency: "EUR" } },
      updatedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
    });
    expect(eur?.threadTotalCostUsd).toBeNull();

    const none = deriveLatestContextWindowSnapshot([], {
      usedTokens: 1_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(none?.threadTotalCostUsd).toBeNull();
  });

  it("formats cost readouts", () => {
    expect(formatCostUsd(null)).toBeNull();
    expect(formatCostUsd(0.004)).toBe("<$0.01");
    expect(formatCostUsd(1.256)).toBe("$1.26");
    expect(formatCostUsd(250.4)).toBe("$250");
  });

  it("treats snapshots as identical only when the usage and totals match", () => {
    const usage = { usedTokens: 10_000, updatedAt: "2026-08-27T00:00:00.000Z" };
    const a = deriveLatestContextWindowSnapshot([], usage);
    const b = deriveLatestContextWindowSnapshot([], { ...usage });
    const c = deriveLatestContextWindowSnapshot([], {
      usedTokens: 11_000,
      updatedAt: "2026-08-27T00:01:00.000Z",
    });

    expect(a && b && isSameContextWindowSnapshot(a, b)).toBe(true);
    expect(a && c && isSameContextWindowSnapshot(a, c)).toBe(false);
  });
});
