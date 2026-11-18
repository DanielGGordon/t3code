import { DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS } from "@t3tools/contracts";
import type {
  OrchestrationV2CacheKeepAliveMode,
  OrchestrationV2ThreadCacheKeepAlive,
  OrchestrationV2ThreadCacheKeepAliveContext,
  OrchestrationV2ThreadShell,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export const PROMPT_CACHE_TTL_MS = 60 * 60_000;
// Leave time to restart Claude Code and its MCP servers after the session is released.
export const CACHE_KEEP_ALIVE_LEAD_MS = 5 * 60_000;
const DEFAULT_CACHE_KEEP_ALIVE_MODE = "warm-then-compact";

// A ping reads at 0.1x input price and a cold resend rewrites the one-hour cache at 2x, so 20 pings cost one cold resend.
export const CACHE_KEEP_ALIVE_BREAK_EVEN_PINGS = 20;
export const CACHE_KEEP_ALIVE_COST_WARNING =
  "Keeping the cache warm 20x will yield zero net benefit in cost.";
/** Shared verbatim with Alfred's manual nudge button. */
export const CACHE_KEEP_ALIVE_NUDGE_TEXT =
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Match the provider message sent by Alfred.
  'Keep-alive ping to keep the prompt cache warm. No action needed — just reply "ok".';
/**
 * Ping messages use `<prefix><threadId>:<runId>:<attempt>` ids, which also mark
 * them in the transcript.
 */
export const CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX = "cache-keep-alive:";

// Only provider items on the root node date the cache. Bookkeeping items and subagents do not touch it.
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

/** Drivers with an hour-long prompt cache. Their threads carry a cache context even with the toggle off. */
export const CACHE_KEEP_ALIVE_DRIVER_KINDS: ReadonlyArray<string> = ["claudeAgent"];
const CACHE_KEEP_ALIVE_DRIVERS: ReadonlySet<string> = new Set(CACHE_KEEP_ALIVE_DRIVER_KINDS);
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
> &
  Partial<Pick<OrchestrationV2ThreadShell, "lineage" | "creationSource">>;

export type CacheKeepAliveMode = OrchestrationV2CacheKeepAliveMode;
type CacheKeepAliveChoice = CacheKeepAliveMode | "off";

export const CACHE_KEEP_ALIVE_MODE_LABELS: Record<CacheKeepAliveChoice, string> = {
  "warm-then-compact": "Keep cache alive, compact if I don't come back for a while",
  warm: "Keep cache alive for a while, don't compact",
  compact: "Compact if I'm not back before cache expires",
  off: "Cache keep-alive is off",
};

const NEXT_CACHE_KEEP_ALIVE_CHOICE: Record<CacheKeepAliveChoice, CacheKeepAliveChoice> = {
  off: DEFAULT_CACHE_KEEP_ALIVE_MODE,
  "warm-then-compact": "warm",
  warm: "compact",
  compact: "off",
};

export function nextCacheKeepAliveChoice(
  stored: OrchestrationV2ThreadCacheKeepAlive | null,
  compactModes: boolean,
  maxPings: number,
): CacheKeepAliveChoice {
  const current = stored?.inherited ? null : stored;
  const active = cacheKeepAliveActive(current, maxPings);
  if (!compactModes) return active ? "off" : "warm";
  return NEXT_CACHE_KEEP_ALIVE_CHOICE[active ? cacheKeepAliveMode(current) : "off"];
}

/** What the toggle does; toggles saved before modes existed only ping. */
export function cacheKeepAliveMode(
  keepAlive: Pick<OrchestrationV2ThreadCacheKeepAlive, "mode"> | null | undefined,
): CacheKeepAliveMode {
  return keepAlive?.mode ?? "warm";
}

const cacheKeepAliveBudgetSpent = (
  keepAlive: Pick<OrchestrationV2ThreadCacheKeepAlive, "pausedAt" | "nudgeCount">,
  maxPings: number,
) => keepAlive.pausedAt !== null || keepAlive.nudgeCount >= maxPings;
const cacheKeepAliveCompacts = (mode: CacheKeepAliveMode) => mode !== "warm";

/**
 * Whether the toggle still has work to do. A spent ping budget only ends a mode
 * that never compacts; the others still compact before the last cache lapses.
 */
export function cacheKeepAliveActive(
  keepAlive:
    | Pick<OrchestrationV2ThreadCacheKeepAlive, "mode" | "pausedAt" | "nudgeCount">
    | null
    | undefined,
  maxPings = DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS,
): boolean {
  return (
    keepAlive != null &&
    (!cacheKeepAliveBudgetSpent(keepAlive, maxPings) ||
      cacheKeepAliveCompacts(cacheKeepAliveMode(keepAlive)))
  );
}

/**
 * The toggle after a `thread.cache-keep-alive.set`, for the server and the
 * clients' optimistic copy. A mode-less enable preserves pending compaction.
 */
export function nextCacheKeepAlive(
  stored: OrchestrationV2ThreadCacheKeepAlive | null,
  input: { readonly enabled: boolean; readonly mode?: CacheKeepAliveMode | undefined },
  now: OrchestrationV2ThreadCacheKeepAlive["enabledAt"],
  maxPings = DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS,
): OrchestrationV2ThreadCacheKeepAlive | null {
  if (!input.enabled) return null;
  // An explicit toggle replaces an inherited record.
  const current = stored?.inherited ? null : stored;
  if (
    current !== null &&
    (!cacheKeepAliveBudgetSpent(current, maxPings) ||
      (input.mode === undefined && cacheKeepAliveCompacts(cacheKeepAliveMode(current))))
  ) {
    return input.mode === undefined || cacheKeepAliveMode(current) === input.mode
      ? current
      : { ...current, mode: input.mode };
  }
  const mode = input.mode ?? DEFAULT_CACHE_KEEP_ALIVE_MODE;
  return {
    mode,
    lastCompactRunId: current?.lastCompactRunId ?? null,
    enabledAt: current?.enabledAt ?? now,
    nudgeCount: 0,
    pausedAt: null,
    lastNudgeRunId: current?.lastNudgeRunId ?? null,
    lastNudgeAfterRead: current?.lastNudgeAfterRead ?? false,
  };
}

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
    }
  | {
      /** `compact-scheduled` until `compactAtMs`, then `compact-due` until the cache expires. */
      readonly kind: "compact-scheduled" | "compact-due";
      readonly runId: RunId;
      readonly compactAtMs: number;
      readonly expiresAtMs: number;
    }
  /** The compaction ran; nothing more happens until the user writes again. */
  | { readonly kind: "compacted" };

// Provider items date the last request before checkpointing. Stopped runs without item times are undated.
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

// During the first active request, the cache is fresh until an item can date it.
export function promptCacheExpiresAtMs(input: {
  readonly thread: Pick<CacheKeepAliveThread, "cacheKeepAliveContext">;
  readonly nowMs: number;
}): number | null {
  const context = input.thread.cacheKeepAliveContext ?? null;
  if (context === null || context.run === null) return null;
  if (!cacheKeepAliveSupportsDriver(context.driver)) return null;
  const { run } = context;
  const finishedAnchorMs = cacheKeepAliveAnchorMs(run);
  let anchorMs: number | null = finishedAnchorMs;
  if (finishedAnchorMs === null && BUSY_RUN_STATUSES.has(run.status)) {
    anchorMs =
      run.lastProviderActivityAt !== null
        ? DateTime.toEpochMillis(run.lastProviderActivityAt)
        : run.status === "running"
          ? input.nowMs
          : null;
  }
  if (anchorMs === null) return null;
  const expiresAtMs = anchorMs + PROMPT_CACHE_TTL_MS;
  return input.nowMs >= expiresAtMs ? null : expiresAtMs;
}

/** "55m" for the time left on the cache; whole minutes rounded down, so it never overpromises. */
export function formatCacheExpiry(remainingMs: number): string {
  const minutes = Math.floor(remainingMs / 60_000);
  return minutes < 1 ? "<1m" : `${minutes}m`;
}

const PARENT_NOT_KEEPING_WARM: ReadonlySet<CacheKeepAliveState["kind"]> = new Set([
  "off",
  "paused",
  "compacted",
  "unsupported",
  "parked",
]);

/**
 * Whether a subagent thread T3 can message follows `parent`'s keep-alive: the
 * parent's own toggle works, background work holds its turn open, or (fork)
 * the subagent heartbeat is armed. Provider-native children never inherit.
 */
function cacheKeepAliveInheritsFrom(input: {
  readonly thread: CacheKeepAliveThread;
  readonly parent?: CacheKeepAliveThread | null | undefined;
  readonly nowMs: number;
  readonly maxPings: number;
}): boolean {
  const { thread, parent, nowMs, maxPings } = input;
  if (
    parent == null ||
    thread.lineage?.relationshipToParent !== "subagent" ||
    thread.creationSource === "provider" ||
    parent.archivedAt != null ||
    parent.deletedAt != null
  ) {
    return false;
  }
  return (
    !PARENT_NOT_KEEPING_WARM.has(
      keepAliveStateOf(parent, parent.cacheKeepAlive ?? null, nowMs, maxPings).kind,
    ) ||
    backgroundWorkHoldsCompletion(parent.pendingBackgroundTasks ?? []) ||
    cacheKeptWarmByHeartbeat(parent)
  );
}

/** The toggle a thread is judged by: its own, else a warm one inherited from its parent. */
export function effectiveCacheKeepAlive(input: {
  readonly thread: CacheKeepAliveThread;
  readonly parent?: CacheKeepAliveThread | null | undefined;
  readonly nowMs: number;
  readonly maxPings: number;
}): {
  readonly keepAlive: OrchestrationV2ThreadCacheKeepAlive | null;
  readonly inherited: boolean;
} {
  const own = input.thread.cacheKeepAlive ?? null;
  if (own !== null && !own.inherited) return { keepAlive: own, inherited: false };
  if (!cacheKeepAliveInheritsFrom(input)) return { keepAlive: null, inherited: false };
  return {
    keepAlive: own ?? {
      mode: "warm",
      inherited: true,
      enabledAt: DateTime.makeUnsafe(input.nowMs),
      nudgeCount: 0,
      pausedAt: null,
      lastNudgeRunId: null,
      lastNudgeAfterRead: false,
    },
    inherited: true,
  };
}

/** Where a thread stands for keep-alive at `nowMs`; pass the parent to judge a subagent thread. */
export function cacheKeepAliveState(input: {
  readonly thread: CacheKeepAliveThread;
  readonly nowMs: number;
  readonly maxPings: number;
  readonly parent?: CacheKeepAliveThread | null | undefined;
}): CacheKeepAliveState {
  const { thread, nowMs, maxPings } = input;
  const { keepAlive } = effectiveCacheKeepAlive(input);
  return keepAliveStateOf(thread, keepAlive, nowMs, maxPings);
}

function keepAliveStateOf(
  thread: CacheKeepAliveThread,
  keepAlive: OrchestrationV2ThreadCacheKeepAlive | null,
  nowMs: number,
  maxPings: number,
): CacheKeepAliveState {
  if (keepAlive === null) return { kind: "off" };
  const mode = cacheKeepAliveMode(keepAlive);
  if (!cacheKeepAliveActive(keepAlive, maxPings))
    return { kind: "paused", nudgeCount: keepAlive.nudgeCount };
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
  if (cacheKeepAliveCompacts(mode) && context.run.id === keepAlive.lastCompactRunId) {
    return { kind: "compacted" };
  }
  const expiresAtMs = anchorMs + PROMPT_CACHE_TTL_MS;
  // A lapsed cache is gone; a ping would only pay to rebuild it.
  if (nowMs >= expiresAtMs) return { kind: "cold" };
  if (cacheKeepAliveCompacts(mode)) {
    // Pings come first while the budget lasts; the compaction takes the cache the last one left.
    if (mode === "compact" || cacheKeepAliveBudgetSpent(keepAlive, maxPings)) {
      const compactAtMs =
        mode === "warm-then-compact" && keepAlive.nudgeCount > maxPings
          ? nowMs
          : expiresAtMs - CACHE_KEEP_ALIVE_LEAD_MS;
      return {
        kind: nowMs >= compactAtMs ? "compact-due" : "compact-scheduled",
        runId: context.run.id,
        compactAtMs,
        expiresAtMs,
      };
    }
  }
  const nudgeAtMs = expiresAtMs - CACHE_KEEP_ALIVE_LEAD_MS;
  return {
    kind: nowMs >= nudgeAtMs ? "due" : "scheduled",
    runId: context.run.id,
    nudgeAtMs,
    expiresAtMs,
    nudgeCount: keepAlive.nudgeCount,
  };
}

// Each heartbeat wake refreshes Claude's cache. The roster exposes either the description or the command.
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

export function describeCacheKeepAlive(input: {
  readonly thread: CacheKeepAliveThread;
  readonly nowMs: number;
  readonly maxPings: number;
  readonly parent?: CacheKeepAliveThread | null | undefined;
  readonly formatTime: (ms: number) => string;
}): ReadonlyArray<string> {
  const { thread, maxPings, formatTime } = input;
  const state = cacheKeepAliveState(input);
  const status = cacheKeptWarmByHeartbeat(thread)
    ? ["Kept warm by the subagent heartbeat"]
    : [
        ...(effectiveCacheKeepAlive(input).inherited ? ["Kept warm with its parent agent"] : []),
        ...cacheKeepAliveStatus(state, maxPings, formatTime),
      ];
  const expiresAtMs = promptCacheExpiresAtMs(input);
  return expiresAtMs === null ? status : [...status, `Cache expires ${formatTime(expiresAtMs)}`];
}

/** Short phrases the tooltip joins with " · "; each one stays on a single line. */
function cacheKeepAliveStatus(
  state: CacheKeepAliveState,
  maxPings: number,
  formatTime: (ms: number) => string,
): ReadonlyArray<string> {
  switch (state.kind) {
    case "off":
      return [];
    case "paused":
      return [
        `Paused after ${state.nudgeCount} ${state.nudgeCount === 1 ? "ping" : "pings"}`,
        "Send a message to resume",
      ];
    case "unsupported":
      return ["No Claude session holds this conversation yet"];
    case "parked":
      return ["Left alone while archived, settled or snoozed"];
    case "busy":
      return ["Starts when this turn finishes"];
    case "cold":
      return ["No live cache yet; starts after the next turn"];
    case "scheduled":
      return [
        `Next ping ${formatTime(state.nudgeAtMs)}`,
        `${state.nudgeCount} of ${maxPings} sent`,
      ];
    case "due":
      return ["Pinging now"];
    case "compact-scheduled":
      return [`Compacts around ${formatTime(state.compactAtMs)} unless you write`];
    case "compact-due":
      return ["Compacting now"];
    case "compacted":
      return ["Compacted", "Nothing more until you write"];
  }
}

export function isCacheKeepAliveMessageId(messageId: string | undefined): boolean {
  return messageId?.startsWith(CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX) === true;
}
