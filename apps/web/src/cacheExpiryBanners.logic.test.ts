import { RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  CACHE_EXPIRY_BANNER_LEAD_MS,
  PROMPT_CACHE_TTL_MS,
  dueCacheExpiryBanners,
  formatContextTokens,
} from "./cacheExpiryBanners.logic";
import { makeThreadFixture, type ThreadFixtureOverrides } from "./test-fixtures";

const COMPLETED = "2026-10-12T20:00:00.000Z";
const completedMs = Date.parse(COMPLETED);
const inWindow = completedMs + PROMPT_CACHE_TTL_MS - CACHE_EXPIRY_BANNER_LEAD_MS + 60_000;

const idleThread = (overrides: ThreadFixtureOverrides = {}) =>
  makeThreadFixture({
    title: "Big refactor",
    idleContextTokens: 182_000,
    latestRun: {
      runId: RunId.make("run-1"),
      status: "completed",
      requestedAt: "2026-10-12T19:55:00.000Z",
      startedAt: "2026-10-12T19:55:01.000Z",
      completedAt: COMPLETED,
      assistantMessageId: null,
    },
    ...overrides,
  });

const due = (threads: ReturnType<typeof idleThread>[], nowMs = inWindow, driver = "claudeAgent") =>
  dueCacheExpiryBanners({ threads, nowMs, minTokens: 100_000, driverOf: () => driver });

describe("dueCacheExpiryBanners", () => {
  it("opens the lead window before expiry and closes it at expiry", () => {
    const expiresMs = completedMs + PROMPT_CACHE_TTL_MS;
    expect(due([idleThread()], expiresMs - CACHE_EXPIRY_BANNER_LEAD_MS - 1)).toHaveLength(0);
    expect(due([idleThread()], expiresMs - CACHE_EXPIRY_BANNER_LEAD_MS)).toHaveLength(1);
    expect(due([idleThread()], expiresMs)).toHaveLength(0);
    expect(due([idleThread()])[0]).toMatchObject({
      title: "Big refactor",
      tokens: 182_000,
      expiresAt: new Date(expiresMs).toISOString(),
    });
  });

  it("keys one banner per idle period", () => {
    const [banner] = due([idleThread()]);
    expect(banner?.key).toBe(`environment-test:thread-test@${COMPLETED}`);
  });

  it("leaves running, small, put-away and non-Claude threads alone", () => {
    const later = "2026-10-13T00:00:00.000Z";
    for (const overrides of [
      { idleContextTokens: null },
      { idleContextTokens: 99_000 },
      { settledAt: later },
      { archivedAt: later },
      { deletedAt: later },
      { snoozedUntil: later },
    ] satisfies ThreadFixtureOverrides[]) {
      expect(due([idleThread(overrides)]), JSON.stringify(overrides)).toHaveLength(0);
    }
    expect(due([idleThread()], inWindow, "codex")).toHaveLength(0);
    // A snooze that already ran out does not hide it.
    expect(due([idleThread({ snoozedUntil: COMPLETED })])).toHaveLength(1);
  });

  it("stays quiet while keep-alive is pinging the thread", () => {
    const withKeepAlive = (pausedAt: string | null) => {
      const { source } = idleThread();
      return idleThread({
        source: {
          ...source,
          cacheKeepAlive: {
            enabledAt: DateTime.makeUnsafe(COMPLETED),
            nudgeCount: 0,
            pausedAt: pausedAt === null ? null : DateTime.makeUnsafe(pausedAt),
            lastNudgeRunId: null,
            lastNudgeAfterRead: false,
          },
        },
      });
    };
    expect(due([withKeepAlive(null)])).toHaveLength(0);
    // Out of pings: the cache will lapse after all, so the banner returns.
    expect(due([withKeepAlive(COMPLETED)])).toHaveLength(1);
  });

  it("formats context sizes", () => {
    expect(formatContextTokens(182_400)).toBe("182k");
    expect(formatContextTokens(1_000_000)).toBe("1M");
    expect(formatContextTokens(1_250_000)).toBe("1.3M");
  });
});
