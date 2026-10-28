import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectClaudeUsage, selectCodexUsage, selectGeminiUsage } from "./headerUsageLimits";

function antigravity(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    driver: "antigravity",
    enabled: true,
    usageLimits: { checkedAt: "2026-03-23T00:00:00.000Z", windows },
    ...overrides,
  } as ServerProvider;
}

const window = (
  id: string,
  label: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  resetsAt?: string,
): ServerProviderUsageWindow => ({
  id,
  label,
  kind,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

describe("selectGeminiUsage", () => {
  it("reads the Gemini 5-hour and weekly buckets and ignores the shared Claude & GPT allowance", () => {
    const usage = selectGeminiUsage([
      antigravity([
        window("gemini-5h", "Gemini · 5-hour", "session", 40, "2099-03-23T04:00:00.000Z"),
        window("gemini-weekly", "Gemini · Weekly", "weekly", 12, "2099-03-26T00:00:00.000Z"),
        window("3p-5h", "Claude & GPT (shared) · 5-hour", "session", 99),
      ]),
    ]);

    expect(usage).toEqual({
      session: { usedPercent: 40, resetsAt: "2099-03-23T04:00:00.000Z" },
      weekly: { usedPercent: 12, resetsAt: "2099-03-26T00:00:00.000Z" },
    });
  });

  it("takes the fullest Gemini bucket when several share a kind", () => {
    const usage = selectGeminiUsage([
      antigravity([
        window("gemini-pro-5h", "Gemini · 5-hour", "session", 70),
        window("gemini-flash-5h", "Gemini · 5-hour", "session", 15),
      ]),
    ]);

    expect(usage?.session?.usedPercent).toBe(70);
    expect(usage?.weekly).toBeNull();
  });

  it("is null without an enabled Antigravity provider that reports Gemini windows", () => {
    const windows = [window("gemini-5h", "Gemini · 5-hour", "session", 40)];
    expect(selectGeminiUsage([])).toBeNull();
    expect(selectGeminiUsage([antigravity(windows, { enabled: false })])).toBeNull();
    expect(selectGeminiUsage([antigravity(windows, { driver: "codex" as never })])).toBeNull();
    expect(
      selectGeminiUsage([
        antigravity([window("3p-5h", "Claude & GPT (shared) · 5-hour", "session", 5)]),
      ]),
    ).toBeNull();
  });
});

describe("selectClaudeUsage", () => {
  const claude = (instanceId: string, sessionPercent: number | null): ServerProvider =>
    ({
      driver: "claudeAgent",
      instanceId,
      enabled: true,
      usageLimits: {
        checkedAt: "2026-03-23T00:00:00.000Z",
        windows:
          sessionPercent === null
            ? []
            : [window("five_hour", "Session", "session", sessionPercent)],
      },
    }) as unknown as ServerProvider;

  it("reads the instance the thread runs on, not the first Claude account", () => {
    const providers = [claude("claudeAgent", 10), claude("claude_work", 70)];
    expect(selectClaudeUsage(providers, "claude_work" as never)?.limits[0]?.percent).toBe(70);
    expect(selectClaudeUsage(providers, "claudeAgent" as never)?.limits[0]?.percent).toBe(10);
  });

  it("never borrows another account's numbers when the thread's instance reports none", () => {
    const providers = [claude("claudeAgent", 10), claude("claude_work", null)];
    expect(selectClaudeUsage(providers, "claude_work" as never)).toBeNull();
  });

  it("falls back to the first reporting Claude instance for non-Claude threads", () => {
    const providers = [claude("claudeAgent", 10), claude("claude_work", 70)];
    expect(selectClaudeUsage(providers, "codex" as never)?.limits[0]?.percent).toBe(10);
    expect(selectClaudeUsage(providers)?.limits[0]?.percent).toBe(10);
  });
});

describe("expired windows", () => {
  const claude = (windows: ReadonlyArray<ServerProviderUsageWindow>) =>
    ({
      driver: "claudeAgent",
      enabled: true,
      usageLimits: { checkedAt: "2026-03-23T00:00:00.000Z", windows },
    }) as ServerProvider;

  it("drops a window whose reset time has passed but keeps the live ones", () => {
    const usage = selectClaudeUsage([
      claude([
        window("five_hour", "Session", "session", 99, "2020-01-01T00:00:00.000Z"),
        window("seven_day", "Weekly", "weekly", 39, "2099-01-01T00:00:00.000Z"),
      ]),
    ]);

    expect(usage?.limits).toEqual([
      { kind: "weekly_all", percent: 39, resetsAt: "2099-01-01T00:00:00.000Z" },
    ]);
  });

  it("is null when every window has reset", () => {
    expect(
      selectCodexUsage([
        {
          driver: "codex",
          enabled: true,
          usageLimits: {
            checkedAt: "x",
            windows: [window("primary", "Weekly", "weekly", 47, "2020-01-01T00:00:00.000Z")],
          },
        } as unknown as ServerProvider,
      ]),
    ).toBeNull();
  });
});
