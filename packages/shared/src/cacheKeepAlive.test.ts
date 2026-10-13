import {
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadCacheKeepAliveContext,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  CACHE_KEEP_ALIVE_LEAD_MS,
  PROMPT_CACHE_TTL_MS,
  cacheKeepAliveState,
  isCacheKeepAliveMessageId,
  type CacheKeepAliveThread,
} from "./cacheKeepAlive.ts";

const MINUTE = 60_000;
const lastRequestMs = Date.parse("2026-10-13T12:00:00.000Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);
const runId = RunId.make("run:finished");
const nudgeAtMs = lastRequestMs + PROMPT_CACHE_TTL_MS - CACHE_KEEP_ALIVE_LEAD_MS;
const expiresAtMs = lastRequestMs + PROMPT_CACHE_TTL_MS;

type Run = NonNullable<OrchestrationV2ThreadCacheKeepAliveContext["run"]>;
const finished: Run = {
  id: runId,
  status: "completed",
  completedAt: at(lastRequestMs + MINUTE),
  lastProviderActivityAt: at(lastRequestMs),
};
const context: OrchestrationV2ThreadCacheKeepAliveContext = {
  driver: ProviderDriverKind.make("claudeAgent"),
  run: finished,
  hasQueuedRun: false,
};

const idle: CacheKeepAliveThread = {
  cacheKeepAlive: {
    enabledAt: at(lastRequestMs),
    nudgeCount: 2,
    pausedAt: null,
    lastNudgeRunId: null,
    lastNudgeAfterRead: false,
  },
  cacheKeepAliveContext: context,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  activeRunId: null,
  activityRunStatus: null,
  status: "completed",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
};

const stateOf = (thread: Partial<CacheKeepAliveThread>, nowMs = nudgeAtMs) =>
  cacheKeepAliveState({ thread: { ...idle, ...thread }, nowMs });
const withRun = (run: Partial<Run>) => ({
  cacheKeepAliveContext: { ...context, run: { ...finished, ...run } },
});

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

  it("dates the cache by the run's last provider activity, not a late checkpoint", () => {
    // Claude finished at 12:00; checkpoint capture recorded completion at 12:05.
    const delayed = withRun({ completedAt: at(lastRequestMs + 5 * MINUTE) });
    expect(stateOf(delayed, nudgeAtMs)).toMatchObject({ kind: "due", expiresAtMs });
    expect(stateOf(delayed, expiresAtMs).kind).toBe("cold");
  });

  it("dates a stopped run by its last request, however long a tool ran after it", () => {
    // Stopped ten minutes into a long tool call that began at 12:00.
    const stopped = withRun({
      status: "interrupted",
      completedAt: at(lastRequestMs + 10 * MINUTE),
    });
    expect(stateOf(stopped, nudgeAtMs)).toMatchObject({ kind: "due", expiresAtMs });
    // Without provider items a stopped run cannot be dated safely.
    expect(
      stateOf({ ...withRun({ status: "interrupted", lastProviderActivityAt: null }) }).kind,
    ).toBe("cold");
  });

  it("falls back to the completion time of a run that ran to the end", () => {
    const undated = withRun({ lastProviderActivityAt: null, completedAt: at(lastRequestMs) });
    expect(stateOf(undated, nudgeAtMs)).toMatchObject({ kind: "due", expiresAtMs });
  });

  it("never pings a lapsed cache: the next turn rebuilds it anyway", () => {
    expect(stateOf({}, expiresAtMs).kind).toBe("cold");
  });

  it("is off, paused or unsupported before anything else", () => {
    expect(stateOf({ cacheKeepAlive: null }).kind).toBe("off");
    expect(
      stateOf({ cacheKeepAlive: { ...idle.cacheKeepAlive!, pausedAt: at(lastRequestMs) } }),
    ).toEqual({ kind: "paused", nudgeCount: 2 });
    expect(
      stateOf({ cacheKeepAliveContext: { ...context, driver: ProviderDriverKind.make("codex") } })
        .kind,
    ).toBe("unsupported");
    // No Claude session on the thread's current provider instance holds it.
    expect(stateOf({ cacheKeepAliveContext: { ...context, driver: null } }).kind).toBe(
      "unsupported",
    );
    // A client that has not yet seen the server's context waits.
    expect(stateOf({ cacheKeepAliveContext: null }).kind).toBe("cold");
  });

  it("leaves archived, settled and snoozed threads alone", () => {
    expect(stateOf({ archivedAt: at(lastRequestMs) }).kind).toBe("parked");
    expect(stateOf({ settledOverride: "settled" }).kind).toBe("parked");
    expect(stateOf({ snoozedUntil: at(nudgeAtMs + 1) }).kind).toBe("parked");
    // A snooze that already woke does not hold the thread back.
    expect(stateOf({ snoozedUntil: at(nudgeAtMs - 1) }).kind).toBe("due");
  });

  it("never pings mid-turn, past a queued message, or while the thread waits on the user", () => {
    expect(stateOf({ activeRunId: RunId.make("run:live"), status: "running" }).kind).toBe("busy");
    expect(stateOf({ activityRunStatus: "waiting", status: "waiting" }).kind).toBe("busy");
    expect(stateOf({ cacheKeepAliveContext: { ...context, hasQueuedRun: true } }).kind).toBe(
      "busy",
    );
    expect(
      stateOf({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request:approval"),
          kind: "command",
          createdAt: at(lastRequestMs),
        },
      }).kind,
    ).toBe("busy");
    // A subagent will wake the agent; a dev server left running will not.
    const task = { taskId: "task" };
    expect(stateOf({ pendingBackgroundTasks: [{ ...task, kind: "subagent" }] }).kind).toBe("busy");
    expect(stateOf({ pendingBackgroundTasks: [{ ...task, kind: "command" }] }).kind).toBe("due");
  });

  it("waits for an executed turn: none yet, or one that failed", () => {
    expect(stateOf({ cacheKeepAliveContext: { ...context, run: null } }).kind).toBe("cold");
    expect(stateOf(withRun({ status: "failed" })).kind).toBe("cold");
  });
});

describe("isCacheKeepAliveMessageId", () => {
  it("recognizes the ping's message ids", () => {
    expect(isCacheKeepAliveMessageId("cache-keep-alive:thread:run")).toBe(true);
    expect(isCacheKeepAliveMessageId("message:1")).toBe(false);
    expect(isCacheKeepAliveMessageId(undefined)).toBe(false);
  });
});
