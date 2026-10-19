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
 * How long before expiry the ping goes out, so pings land 55–57 minutes after
 * the anchor. T3 releases a Claude session after 30 idle minutes, so a ping
 * first restarts Claude Code and its MCP servers: after a long idle, request to
 * first response measured p50 8 s, p90 40 s, and occasionally over a minute. A
 * ping that lands after expiry is the costliest outcome (a full cache write),
 * so the lead is generous on purpose. It also covers the anchor sitting a few
 * seconds after the request and the 30 s sweep.
 */
export const CACHE_KEEP_ALIVE_LEAD_MS = 5 * 60_000;
/** Pings in a row without a user message before keep-alive pauses (about 8 h). */
export const CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES = 8;
/** Shared verbatim with Alfred's manual nudge button. */
export const CACHE_KEEP_ALIVE_NUDGE_TEXT =
  'Keep-alive ping to keep the prompt cache warm. No action needed — just reply "ok".';
/**
 * Ping messages use `<prefix><threadId>:<runId>:<attempt>` ids, which also mark
 * them in the transcript.
 */
export const CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX = "cache-keep-alive:";

/**
 * Turn items a model response produces; the anchor is the latest one on the
 * run's root node. Checkpoints, errors, notices and bookkeeping items are
 * written by the server, often minutes later, so they do not count.
 *
 * Only the root node is read. The Claude adapter puts assistant messages and
 * most tool items on per-item child nodes (subagents, which do not touch the
 * parent's cache, are child nodes too), so in practice the anchor is the run's
 * last root `reasoning` item: measured within about 9 s of the true last
 * request. A run with no root provider item falls back to its completion time
 * when it completed, and is not pinged when it was stopped.
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

/**
 * Fork: the maintainer's Claude Code setup babysits background subagents with
 * a heartbeat, a background `subagent-status.sh --wait` command that wakes the
 * agent every 15 minutes until the work is done (dotfiles
 * `claude/bin/subagent-status.sh`). Each wake is a request, so it keeps the
 * prompt cache warm. The roster names a background command by its Bash
 * description, or by the command itself when it has none; the dotfiles hook
 * asks for the description "Subagent heartbeat".
 */
const SUBAGENT_HEARTBEAT_PATTERN = /subagent[- ]heartbeat|subagent-status\.sh/i;

/** Whether the subagent heartbeat is armed on this thread right now. */
export function cacheKeptWarmByHeartbeat(
  thread: Pick<OrchestrationV2ThreadShell, "pendingBackgroundTasks">,
): boolean {
  return (thread.pendingBackgroundTasks ?? []).some(
    (task) =>
      task.kind === "command" &&
      task.description !== undefined &&
      SUBAGENT_HEARTBEAT_PATTERN.test(task.description),
  );
}

export function isCacheKeepAliveMessageId(messageId: string | undefined): boolean {
  return messageId?.startsWith(CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX) === true;
}
