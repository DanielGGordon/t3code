import { describe, expect, it } from "vite-plus/test";
import {
  type ClaudeAccountUsage,
  EventId,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import {
  type HeaderUsageStatsVisibility,
  resolveScopedWeeklyLabel,
  selectHeaderUsageStats,
  selectHeaderUsageStatsVisibility,
} from "./HeaderUsageStats";

function makeActivity(id: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "context-window.updated",
    summary: "context-window.updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

const contextWindow = deriveLatestContextWindowSnapshot([
  makeActivity("activity-1", { usedTokens: 167_000, maxTokens: 200_000 }),
]);

const claudeUsage: ClaudeAccountUsage = {
  limits: [
    { kind: "session", percent: 42 },
    { kind: "weekly_all", percent: 63.4 },
    { kind: "weekly_scoped", percent: 18, scopeLabel: "Fable" },
  ],
  fetchedAt: "2026-03-23T00:00:00.000Z",
};

const allVisible: HeaderUsageStatsVisibility = {
  context: true,
  session: true,
  weekly: true,
  scopedWeekly: true,
};

describe("selectHeaderUsageStatsVisibility", () => {
  it("defaults every stat to hidden", () => {
    expect(selectHeaderUsageStatsVisibility(DEFAULT_CLIENT_SETTINGS)).toEqual({
      context: false,
      session: false,
      weekly: false,
      scopedWeekly: false,
    });
  });
});

describe("selectHeaderUsageStats", () => {
  it("returns all stats with formatted values when toggled on and data is available", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow,
      claudeUsage,
    });

    expect(stats.map((stat) => ({ id: stat.id, label: stat.label, value: stat.value }))).toEqual([
      { id: "context", label: "Context", value: "167k" },
      { id: "session", label: "Session", value: "42%" },
      { id: "weekly", label: "Weekly", value: "63%" },
      { id: "scopedWeekly", label: "Fable", value: "18%" },
    ]);
  });

  it("assigns a distinct color per stat", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow,
      claudeUsage,
    });

    expect(new Set(stats.map((stat) => stat.colorClass)).size).toBe(stats.length);
  });

  it("omits stats that are toggled off", () => {
    const stats = selectHeaderUsageStats({
      visibility: { ...allVisible, session: false, weekly: false },
      contextWindow,
      claudeUsage,
    });

    expect(stats.map((stat) => stat.id)).toEqual(["context", "scopedWeekly"]);
  });

  it("renders nothing for a toggled-on stat whose data is unavailable", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: null,
      claudeUsage: {
        limits: [{ kind: "session", percent: 42 }],
        fetchedAt: "2026-03-23T00:00:00.000Z",
      },
    });

    expect(stats.map((stat) => stat.id)).toEqual(["session"]);
  });

  it("returns no stats when no data source is available", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: null,
      claudeUsage: null,
    });

    expect(stats).toEqual([]);
  });

  it("falls back to a generic scoped label when the limit has none", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: null,
      claudeUsage: {
        limits: [{ kind: "weekly_scoped", percent: 18 }],
        fetchedAt: "2026-03-23T00:00:00.000Z",
      },
    });

    expect(stats).toEqual([
      expect.objectContaining({ id: "scopedWeekly", label: "Scoped", value: "18%" }),
    ]);
  });
});

describe("resolveScopedWeeklyLabel", () => {
  it("uses the scoped limit's scopeLabel", () => {
    expect(resolveScopedWeeklyLabel(claudeUsage)).toBe("Fable");
  });

  it("falls back when usage or the scoped limit is missing", () => {
    expect(resolveScopedWeeklyLabel(null)).toBe("Scoped");
    expect(
      resolveScopedWeeklyLabel({
        limits: [{ kind: "session", percent: 1 }],
        fetchedAt: "2026-03-23T00:00:00.000Z",
      }),
    ).toBe("Scoped");
  });
});
