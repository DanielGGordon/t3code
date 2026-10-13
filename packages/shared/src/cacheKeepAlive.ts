import type { OrchestrationV2ThreadShell, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

// Fork: per-thread prompt-cache keep-alive. Claude keeps a conversation's
// prompt cache for an hour after its last request; once it lapses the next
// message re-reads the whole context uncached. With the toggle on, the server
// sends a short ping shortly before that hour is up, which resets the clock.
// Codex and the other providers cache for minutes, too short to keep warm.
// The server's sweep, the orchestrator's guard and the chat header all judge
// a thread with `cacheKeepAliveState`, so they cannot disagree.

export const PROMPT_CACHE_TTL_MS = 60 * 60_000;
/**
 * How long before expiry the ping goes out. The cache clock starts at the
 * turn's last request, a little before the run is recorded as complete, and
 * the server sweeps every 30 s; two minutes covers both.
 */
export const CACHE_KEEP_ALIVE_LEAD_MS = 2 * 60_000;
/** Pings in a row without a user message before keep-alive pauses (about 8 h). */
export const CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES = 8;
/** Shared verbatim with Alfred's manual nudge button. */
export const CACHE_KEEP_ALIVE_NUDGE_TEXT =
  'Keep-alive ping to keep the prompt cache warm. No action needed — just reply "ok".';
/** Ping messages use `<prefix><threadId>:<runId>` ids, which also mark them in the transcript. */
export const CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX = "cache-keep-alive:";

const CACHE_KEEP_ALIVE_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);
const BUSY_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
// A turn that ran to the end, or that the user stopped, has refreshed the cache.
// A failed one may not have (a usage limit, an auth error), so pings wait for
// the next real turn rather than retrying a failure every hour.
const WARM_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "interrupted"]);

export type CacheKeepAliveThread = Pick<
  OrchestrationV2ThreadShell,
  | "cacheKeepAlive"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "activeRunId"
  | "activityRunStatus"
  | "status"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "latestRunId"
  | "latestRunCompletedAt"
>;

export type CacheKeepAliveState =
  /** The toggle is off. */
  | { readonly kind: "off" }
  /** The ping budget ran out with no message from the user. */
  | { readonly kind: "paused"; readonly nudgeCount: number }
  /** The conversation is not on a provider with an hour-long cache. */
  | { readonly kind: "unsupported" }
  /** Archived, settled or snoozed: put away, so no pings. */
  | { readonly kind: "parked" }
  /** A turn is running or queued, or the thread is waiting on the user. */
  | { readonly kind: "busy" }
  /** No finished turn with a live cache; pings resume after the next turn. */
  | { readonly kind: "cold" }
  | {
      /** `scheduled` until `nudgeAtMs`, then `due` until the cache expires. */
      readonly kind: "scheduled" | "due";
      /** The finished run whose cache the ping keeps warm. */
      readonly runId: RunId;
      readonly nudgeAtMs: number;
      readonly expiresAtMs: number;
      readonly nudgeCount: number;
    };

/**
 * Where a thread stands for keep-alive. `driver` is the driver of the provider
 * thread that holds the conversation (undefined when unknown or when the next
 * turn would run on a different provider instance).
 */
export function cacheKeepAliveState(input: {
  readonly thread: CacheKeepAliveThread;
  readonly driver: string | undefined;
  readonly nowMs: number;
}): CacheKeepAliveState {
  const { thread, nowMs } = input;
  const keepAlive = thread.cacheKeepAlive ?? null;
  if (keepAlive === null) return { kind: "off" };
  if (keepAlive.pausedAt !== null) return { kind: "paused", nudgeCount: keepAlive.nudgeCount };
  if (!cacheKeepAliveSupportsDriver(input.driver)) return { kind: "unsupported" };
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  ) {
    return { kind: "parked" };
  }
  if (
    thread.activeRunId !== null ||
    thread.activityRunStatus != null ||
    BUSY_RUN_STATUSES.has(thread.status) ||
    thread.pendingRuntimeRequest !== null ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return { kind: "busy" };
  }
  const completedAt = thread.latestRunCompletedAt ?? null;
  if (
    thread.latestRunId === null ||
    completedAt === null ||
    !WARM_RUN_STATUSES.has(thread.status)
  ) {
    return { kind: "cold" };
  }
  const expiresAtMs = DateTime.toEpochMillis(completedAt) + PROMPT_CACHE_TTL_MS;
  // A lapsed cache is gone; a ping would only pay to rebuild it.
  if (nowMs >= expiresAtMs) return { kind: "cold" };
  const nudgeAtMs = expiresAtMs - CACHE_KEEP_ALIVE_LEAD_MS;
  return {
    kind: nowMs >= nudgeAtMs ? "due" : "scheduled",
    runId: thread.latestRunId,
    nudgeAtMs,
    expiresAtMs,
    nudgeCount: keepAlive.nudgeCount,
  };
}

/** Whether a provider driver keeps an hour-long prompt cache worth pinging. */
export function cacheKeepAliveSupportsDriver(driver: string | undefined): boolean {
  return driver !== undefined && CACHE_KEEP_ALIVE_DRIVERS.has(driver);
}

export function isCacheKeepAliveMessageId(messageId: string | undefined): boolean {
  return messageId?.startsWith(CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX) === true;
}
