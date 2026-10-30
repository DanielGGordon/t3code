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
  cacheKeepAliveActive,
  cacheKeepAliveState,
  cacheKeptWarmByHeartbeat,
  formatCacheExpiry,
  isCacheKeepAliveMessageId,
  nextCacheKeepAlive,
  promptCacheExpiresAtMs,
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

describe("compact modes", () => {
  const keepAlive = (fields: Partial<NonNullable<CacheKeepAliveThread["cacheKeepAlive"]>>) => ({
    ...idle.cacheKeepAlive!,
    ...fields,
  });
  const compactAtMs = nudgeAtMs;

  it("compact mode never pings: it compacts shortly before the cache lapses", () => {
    const compact = { cacheKeepAlive: keepAlive({ mode: "compact" }) };
    expect(stateOf(compact, compactAtMs - 1)).toEqual({
      kind: "compact-scheduled",
      runId,
      compactAtMs,
      expiresAtMs,
    });
    expect(stateOf(compact, compactAtMs).kind).toBe("compact-due");
    expect(stateOf(compact, expiresAtMs).kind).toBe("cold");
  });

  it("is done once the compaction ran, until the user writes and a new run takes over", () => {
    const compacted = { cacheKeepAlive: keepAlive({ mode: "compact", lastCompactRunId: runId }) };
    expect(stateOf(compacted).kind).toBe("compacted");
    const newRun = withRun({ id: RunId.make("run:later") });
    expect(stateOf({ ...compacted, ...newRun }).kind).toBe("compact-due");
  });

  it("warm-then-compact pings while the budget lasts, then compacts after the last ping", () => {
    expect(stateOf({ cacheKeepAlive: keepAlive({ mode: "warm-then-compact" }) }).kind).toBe("due");
    const spent = { cacheKeepAlive: keepAlive({ mode: "warm-then-compact", pausedAt: at(0) }) };
    expect(stateOf(spent, compactAtMs).kind).toBe("compact-due");
    expect(
      stateOf({ ...spent, cacheKeepAlive: { ...spent.cacheKeepAlive, lastCompactRunId: runId } })
        .kind,
    ).toBe("compacted");
  });

  it("a spent warm toggle still just pauses", () => {
    const spent = keepAlive({ pausedAt: at(0) });
    expect(cacheKeepAliveActive(spent)).toBe(false);
    expect(cacheKeepAliveActive({ ...spent, mode: "warm-then-compact" })).toBe(true);
    expect(stateOf({ cacheKeepAlive: spent }).kind).toBe("paused");
  });

  it("waits out a busy thread like a ping does", () => {
    const compact = { cacheKeepAlive: keepAlive({ mode: "compact" }) };
    expect(
      stateOf({ ...compact, activeRunId: RunId.make("run:live"), status: "running" }).kind,
    ).toBe("busy");
  });
});

describe("nextCacheKeepAlive", () => {
  const now = at(lastRequestMs);
  const on = idle.cacheKeepAlive!;

  it("turns off, and on with the default or requested mode", () => {
    expect(nextCacheKeepAlive(on, { enabled: false }, now)).toBeNull();
    expect(nextCacheKeepAlive(null, { enabled: true }, now)).toMatchObject({
      mode: "warm",
      nudgeCount: 0,
    });
    expect(nextCacheKeepAlive(null, { enabled: true, mode: "compact" }, now)?.mode).toBe("compact");
  });

  it("keeps a running budget when only the mode changes", () => {
    expect(nextCacheKeepAlive(on, { enabled: true, mode: "compact" }, now)).toEqual({
      ...on,
      mode: "compact",
    });
    expect(nextCacheKeepAlive(on, { enabled: true }, now)).toBe(on);
  });

  it("starts a fresh budget when the old one ran out, keeping the compaction record", () => {
    const spent = { ...on, pausedAt: at(0), lastCompactRunId: runId };
    expect(nextCacheKeepAlive(spent, { enabled: true }, now)).toMatchObject({
      pausedAt: null,
      nudgeCount: 0,
      lastCompactRunId: runId,
    });
  });
});

describe("isCacheKeepAliveMessageId", () => {
  it("recognizes the ping's message ids", () => {
    expect(isCacheKeepAliveMessageId("cache-keep-alive:thread:run")).toBe(true);
    expect(isCacheKeepAliveMessageId("message:1")).toBe(false);
    expect(isCacheKeepAliveMessageId(undefined)).toBe(false);
  });
});

describe("cacheKeptWarmByHeartbeat", () => {
  const withTasks = (
    pendingBackgroundTasks: Parameters<
      typeof cacheKeptWarmByHeartbeat
    >[0]["pendingBackgroundTasks"],
  ) => cacheKeptWarmByHeartbeat({ pendingBackgroundTasks });

  it("spots the armed heartbeat by its description or its command", () => {
    expect(withTasks([{ taskId: "b1", kind: "command", description: "Subagent heartbeat" }])).toBe(
      true,
    );
    expect(
      withTasks([{ taskId: "b1", kind: "command", description: "Arm the subagent heartbeat" }]),
    ).toBe(true);
    expect(
      withTasks([
        {
          taskId: "b1",
          kind: "command",
          description: "bash ~/dotfiles/claude/bin/subagent-status.sh --wait 900",
        },
      ]),
    ).toBe(true);
  });

  it("ignores other background work", () => {
    expect(withTasks([])).toBe(false);
    expect(withTasks(undefined)).toBe(false);
    expect(withTasks([{ taskId: "b1", kind: "command", description: "vp run dev" }])).toBe(false);
    expect(withTasks([{ taskId: "b1", kind: "command" }])).toBe(false);
    expect(
      withTasks([{ taskId: "a1", kind: "subagent", description: "Subagent heartbeat review" }]),
    ).toBe(false);
  });
});

describe("promptCacheExpiresAtMs", () => {
  const expiry = (thread: Partial<CacheKeepAliveThread>, nowMs = lastRequestMs + 5 * MINUTE) =>
    promptCacheExpiresAtMs({ thread: { ...idle, ...thread }, nowMs });

  it("counts down whether or not the toggle is on", () => {
    expect(expiry({})).toBe(expiresAtMs);
    expect(expiry({ cacheKeepAlive: null })).toBe(expiresAtMs);
  });

  it("has no expiry without a live Claude cache", () => {
    expect(expiry({}, expiresAtMs)).toBeNull();
    expect(expiry({ cacheKeepAliveContext: null })).toBeNull();
    expect(expiry({ cacheKeepAliveContext: { ...context, run: null } })).toBeNull();
    expect(expiry({ cacheKeepAliveContext: { ...context, driver: null } })).toBeNull();
    expect(expiry(withRun({ status: "failed" }))).toBeNull();
    expect(expiry(withRun({ status: "preparing", lastProviderActivityAt: null }))).toBeNull();
  });

  it("keeps counting while a turn runs", () => {
    const nowMs = lastRequestMs + 5 * MINUTE;
    // Counts from the turn's latest model item.
    expect(expiry(withRun({ status: "running" }), nowMs)).toBe(expiresAtMs);
    // Before the first item the turn is mid-request, so the cache is fresh.
    expect(expiry(withRun({ status: "running", lastProviderActivityAt: null }), nowMs)).toBe(
      nowMs + PROMPT_CACHE_TTL_MS,
    );
  });
});

describe("formatCacheExpiry", () => {
  it("rounds down to whole minutes", () => {
    expect(formatCacheExpiry(55 * MINUTE)).toBe("55m");
    expect(formatCacheExpiry(54 * MINUTE + 59_000)).toBe("54m");
    expect(formatCacheExpiry(MINUTE)).toBe("1m");
  });

  it("says under a minute when less than one is left", () => {
    expect(formatCacheExpiry(59_000)).toBe("<1m");
    expect(formatCacheExpiry(0)).toBe("<1m");
  });
});
