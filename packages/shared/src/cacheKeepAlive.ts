import type {
  OrchestrationV2ThreadCacheKeepAliveContext,
  OrchestrationV2ThreadShell,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

// Fork: per-thread prompt-cache keep-alive. Claude keeps a conversation's
// prompt cache for an hour after its last request; once it lapses the next
// message re-reads the whole context uncached. With the toggle on, the server
// sends a short ping shortly before that hour is up, which resets the clock.
// Codex and the other providers cache for minutes, too short to keep warm.
// The server's sweep, the orchestrator's guard and the chat header all judge
// a thread with `cacheKeepAliveState` over the server-computed
// `cacheKeepAliveContext` on its shell, so they cannot disagree.

export const PROMPT_CACHE_TTL_MS = 60 * 60_000;
/**
 * How long before expiry the ping goes out. The cache clock is dated by the
 * start of the run's last provider item, a little after the request that
 * produced it, and the server sweeps every 30 s; two minutes covers both.
 */
export const CACHE_KEEP_ALIVE_LEAD_MS = 2 * 60_000;
/** Pings in a row without a user message before keep-alive pauses (about 8 h). */
export const CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES = 8;
/** Shared verbatim with Alfred's manual nudge button. */
export const CACHE_KEEP_ALIVE_NUDGE_TEXT =
  'Keep-alive ping to keep the prompt cache warm. No action needed — just reply "ok".';
/** Ping messages use `<prefix><threadId>:<runId>` ids, which also mark them in the transcript. */
export const CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX = "cache-keep-alive:";

/**
 * Turn items a model response produces. The latest one on a run's root node
 * began just after the run's last provider request, which is when the cache
 * clock last restarted. Checkpoints, errors, notices and bookkeeping items are
 * written by the server, often minutes later, so they do not count.
 */
export const CACHE_KEEP_ALIVE_PROVIDER_ITEM_TYPES: ReadonlyArray<string> = [
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "user_input_request",
  "approval_request",
  "secret_request",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
];

const CACHE_KEEP_ALIVE_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);
const BUSY_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export type CacheKeepAliveThread = Pick<
  OrchestrationV2ThreadShell,
  | "cacheKeepAlive"
  | "cacheKeepAliveContext"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "activeRunId"
  | "activityRunStatus"
  | "status"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
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
      /** The executed run whose cache the ping keeps warm. */
      readonly runId: RunId;
      readonly nudgeAtMs: number;
      readonly expiresAtMs: number;
      readonly nudgeCount: number;
    };

/**
 * When a run's cache clock started, or null when it cannot be dated safely.
 * The run's last provider item marks its last request; checkpoint capture can
 * hold the completion back by minutes. Without item times only a run that ran
 * to the end is dated, by its completion. A stopped run without them may have
 * sat in a long tool call, so it is not guessed at.
 */
function cacheKeepAliveAnchorMs(
  run: NonNullable<OrchestrationV2ThreadCacheKeepAliveContext["run"]>,
): number | null {
  if (run.status !== "completed" && run.status !== "interrupted") return null;
  if (run.lastProviderActivityAt !== null)
    return DateTime.toEpochMillis(run.lastProviderActivityAt);
  return run.status === "completed" && run.completedAt !== null
    ? DateTime.toEpochMillis(run.completedAt)
    : null;
}

/** Whether a provider driver keeps an hour-long prompt cache worth pinging. */
export function cacheKeepAliveSupportsDriver(driver: string | null | undefined): boolean {
  return driver != null && CACHE_KEEP_ALIVE_DRIVERS.has(driver);
}

/** Where a thread stands for keep-alive at `nowMs`. */
export function cacheKeepAliveState(input: {
  readonly thread: CacheKeepAliveThread;
  readonly nowMs: number;
}): CacheKeepAliveState {
  const { thread, nowMs } = input;
  const keepAlive = thread.cacheKeepAlive ?? null;
  if (keepAlive === null) return { kind: "off" };
  if (keepAlive.pausedAt !== null) return { kind: "paused", nudgeCount: keepAlive.nudgeCount };
  // The server adds the context with the toggle; until a client sees it, wait.
  const context = thread.cacheKeepAliveContext ?? null;
  if (context === null) return { kind: "cold" };
  if (!cacheKeepAliveSupportsDriver(context.driver)) return { kind: "unsupported" };
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
    context.hasQueuedRun ||
    (context.run !== null && BUSY_RUN_STATUSES.has(context.run.status)) ||
    thread.pendingRuntimeRequest !== null ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return { kind: "busy" };
  }
  // A failed run may not have refreshed the cache (a usage limit, an auth
  // error), so pings wait for the next real turn instead of retrying it hourly.
  const anchorMs = context.run === null ? null : cacheKeepAliveAnchorMs(context.run);
  if (context.run === null || anchorMs === null) return { kind: "cold" };
  const expiresAtMs = anchorMs + PROMPT_CACHE_TTL_MS;
  // A lapsed cache is gone; a ping would only pay to rebuild it.
  if (nowMs >= expiresAtMs) return { kind: "cold" };
  const nudgeAtMs = expiresAtMs - CACHE_KEEP_ALIVE_LEAD_MS;
  return {
    kind: nowMs >= nudgeAtMs ? "due" : "scheduled",
    runId: context.run.id,
    nudgeAtMs,
    expiresAtMs,
    nudgeCount: keepAlive.nudgeCount,
  };
}

export function isCacheKeepAliveMessageId(messageId: string | undefined): boolean {
  return messageId?.startsWith(CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX) === true;
}
