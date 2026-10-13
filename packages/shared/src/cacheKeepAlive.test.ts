import { RunId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  CACHE_KEEP_ALIVE_LEAD_MS,
  PROMPT_CACHE_TTL_MS,
  cacheKeepAliveState,
  isCacheKeepAliveMessageId,
  type CacheKeepAliveThread,
} from "./cacheKeepAlive.ts";

const completedMs = Date.parse("2026-10-13T12:00:00.000Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);
const runId = RunId.make("run:finished");
const nudgeAtMs = completedMs + PROMPT_CACHE_TTL_MS - CACHE_KEEP_ALIVE_LEAD_MS;
const expiresAtMs = completedMs + PROMPT_CACHE_TTL_MS;

const idle: CacheKeepAliveThread = {
  cacheKeepAlive: {
    enabledAt: at(completedMs),
    nudgeCount: 2,
    pausedAt: null,
    lastNudgeRunId: null,
    lastNudgeAfterRead: false,
  },
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  activeRunId: null,
  activityRunStatus: null,
  status: "completed",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: runId,
  latestRunCompletedAt: at(completedMs),
};

const stateOf = (
  thread: Partial<CacheKeepAliveThread>,
  nowMs = nudgeAtMs,
  driver: string | undefined = "claudeAgent",
) => cacheKeepAliveState({ thread: { ...idle, ...thread }, driver, nowMs });

describe("cacheKeepAliveState", () => {
  it("schedules the ping shortly before the hour-long cache lapses", () => {
    expect(stateOf({}, nudgeAtMs - 1)).toEqual({
      kind: "scheduled",
      runId,
      nudgeAtMs,
      expiresAtMs,
      nudgeCount: 2,
    });
    expect(stateOf({}, nudgeAtMs).kind).toBe("due");
    expect(stateOf({}, expiresAtMs - 1).kind).toBe("due");
  });

  it("never pings a lapsed cache: the next turn rebuilds it anyway", () => {
    expect(stateOf({}, expiresAtMs).kind).toBe("cold");
  });

  it("is off, paused or unsupported before anything else", () => {
    expect(stateOf({ cacheKeepAlive: null }).kind).toBe("off");
    expect(
      stateOf({ cacheKeepAlive: { ...idle.cacheKeepAlive!, pausedAt: at(completedMs) } }),
    ).toEqual({ kind: "paused", nudgeCount: 2 });
    expect(stateOf({}, nudgeAtMs, "codex").kind).toBe("unsupported");
    expect(cacheKeepAliveState({ thread: idle, driver: undefined, nowMs: nudgeAtMs }).kind).toBe(
      "unsupported",
    );
  });

  it("leaves archived, settled and snoozed threads alone", () => {
    expect(stateOf({ archivedAt: at(completedMs) }).kind).toBe("parked");
    expect(stateOf({ settledOverride: "settled" }).kind).toBe("parked");
    expect(stateOf({ snoozedUntil: at(nudgeAtMs + 1) }).kind).toBe("parked");
    // A snooze that already woke does not hold the thread back.
    expect(stateOf({ snoozedUntil: at(nudgeAtMs - 1) }).kind).toBe("due");
  });

  it("never pings mid-turn or while the thread waits on the user", () => {
    expect(stateOf({ activeRunId: RunId.make("run:live"), status: "running" }).kind).toBe("busy");
    expect(stateOf({ activityRunStatus: "waiting", status: "waiting" }).kind).toBe("busy");
    expect(stateOf({ status: "queued" }).kind).toBe("busy");
    expect(
      stateOf({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request:approval"),
          kind: "command",
          createdAt: at(completedMs),
        },
      }).kind,
    ).toBe("busy");
    // A subagent will wake the agent; a dev server left running will not.
    const task = { taskId: "task" };
    expect(stateOf({ pendingBackgroundTasks: [{ ...task, kind: "subagent" }] }).kind).toBe("busy");
    expect(stateOf({ pendingBackgroundTasks: [{ ...task, kind: "command" }] }).kind).toBe("due");
  });

  it("waits for a finished turn: none yet, or one that failed", () => {
    expect(stateOf({ latestRunId: null, latestRunCompletedAt: null, status: "idle" }).kind).toBe(
      "cold",
    );
    expect(stateOf({ status: "failed" }).kind).toBe("cold");
    expect(stateOf({ status: "interrupted" }).kind).toBe("due");
  });
});

describe("isCacheKeepAliveMessageId", () => {
  it("recognizes the ping's message ids", () => {
    expect(isCacheKeepAliveMessageId("cache-keep-alive:thread:run")).toBe(true);
    expect(isCacheKeepAliveMessageId("message:1")).toBe(false);
    expect(isCacheKeepAliveMessageId(undefined)).toBe(false);
  });
});
