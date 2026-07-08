import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  formatCostUsd,
  isSameContextWindowSnapshot,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("prefers total processed tokens for thread totals, falling back to context usage", () => {
    const withTotals = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
      }),
    ]);
    expect(withTotals?.threadTotalTokens).toBe(748_126);

    const withoutTotals = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 27_000,
      }),
    ]);
    expect(withoutTotals?.threadTotalTokens).toBe(27_000);
  });

  it("keeps the thread total when a later snapshot omits totalProcessedTokens", () => {
    // Claude only attaches totals at turn end; mid-turn snapshots carry bare
    // context sizes and must not regress the thread total.
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 82_000,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(82_000);
    expect(snapshot?.threadTotalTokens).toBe(748_126);
  });

  it("sums totals across provider accumulator resets", () => {
    // A restarted CLI session restarts its cumulative counter; earlier totals
    // are still spent tokens and must stay counted.
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 400_000,
        totalProcessedTokens: 1_789_632,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 300_000,
        totalProcessedTokens: 1_461_021,
      }),
    ]);

    expect(snapshot?.threadTotalTokens).toBe(1_789_632 + 1_461_021);
  });

  it("uses peak context usage as the total when totals are never reported", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", { usedTokens: 900_000 }),
      makeActivity("activity-2", "context-window.updated", { usedTokens: 94_000 }),
    ]);

    expect(snapshot?.usedTokens).toBe(94_000);
    expect(snapshot?.threadTotalTokens).toBe(900_000);
  });

  it("derives the thread cost total from the latest costUsd", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 14_000,
        costUsd: 1.25,
      }),
    ]);

    expect(snapshot?.costUsd).toBe(1.25);
    expect(snapshot?.threadTotalCostUsd).toBe(1.25);
  });

  it("keeps the thread cost total when a later snapshot omits costUsd", () => {
    // Claude only attaches costs at turn end; mid-turn snapshots carry bare
    // context sizes and must not regress the running spend.
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 14_000,
        costUsd: 0.8,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 15_000,
      }),
    ]);

    expect(snapshot?.costUsd).toBeNull();
    expect(snapshot?.threadTotalCostUsd).toBe(0.8);
  });

  it("sums costs across provider session restarts while tokens reset independently", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 400_000,
        totalProcessedTokens: 1_789_632,
        costUsd: 0.8,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 20_000,
        totalProcessedTokens: 25_000,
        costUsd: 0.1,
      }),
    ]);

    expect(snapshot?.threadTotalCostUsd).toBeCloseTo(0.9, 10);
    expect(snapshot?.threadTotalTokens).toBe(1_789_632 + 25_000);
  });

  it("reports a null cost total when no snapshot ever carried costUsd", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", { usedTokens: 14_000 }),
    ]);

    expect(snapshot?.threadTotalCostUsd).toBeNull();
    expect(snapshot?.threadTotalCostUsdIncomplete).toBe(false);
  });

  it("flags the thread cost total as incomplete when any session reported unpriced usage", () => {
    // Mixed thread: a priced Claude session plus a Codex session on a model
    // with no list price. The total shows only the priced part.
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 14_000,
        costUsd: 0.8,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 20_000,
        costUsdIncomplete: true,
      }),
    ]);

    expect(snapshot?.threadTotalCostUsd).toBe(0.8);
    expect(snapshot?.threadTotalCostUsdIncomplete).toBe(true);
    expect(snapshot?.costUsdIncomplete).toBe(true);
  });

  it("keeps the incomplete flag once set even when later snapshots are fully priced", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 14_000,
        costUsdIncomplete: true,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 15_000,
        costUsd: 0.4,
      }),
    ]);

    expect(snapshot?.threadTotalCostUsd).toBe(0.4);
    expect(snapshot?.threadTotalCostUsdIncomplete).toBe(true);
    expect(snapshot?.costUsdIncomplete).toBeNull();
  });

  it("formats cost readouts", () => {
    expect(formatCostUsd(null)).toBeNull();
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.004)).toBe("<$0.01");
    expect(formatCostUsd(1.416)).toBe("$1.42");
    expect(formatCostUsd(142.5)).toBe("$143");
  });

  it("treats snapshots as different when only the cost total changes", () => {
    const latest = makeActivity("activity-2", "context-window.updated", {
      usedTokens: 10_000,
      costUsd: 0.5,
    });
    const a = deriveLatestContextWindowSnapshot([latest]);
    const b = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1_000,
        costUsd: 0.8,
      }),
      latest,
    ]);

    expect(a?.activityId).toBe(b?.activityId);
    expect(a?.threadTotalTokens).toBe(b?.threadTotalTokens);
    expect(a && b && isSameContextWindowSnapshot(a, b)).toBe(false);
  });

  it("treats snapshots as identical only for the same activity and total", () => {
    const base = [
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 10_000,
        totalProcessedTokens: 50_000,
      }),
    ];
    const a = deriveLatestContextWindowSnapshot(base);
    const b = deriveLatestContextWindowSnapshot([...base]);
    const c = deriveLatestContextWindowSnapshot([
      ...base,
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 11_000,
        totalProcessedTokens: 60_000,
      }),
    ]);

    expect(a && b && isSameContextWindowSnapshot(a, b)).toBe(true);
    expect(a && c && isSameContextWindowSnapshot(a, c)).toBe(false);
  });
});
