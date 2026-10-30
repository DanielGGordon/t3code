import {
  CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX,
  CACHE_KEEP_ALIVE_NUDGE_TEXT,
  cacheKeepAliveState,
  type CacheKeepAliveThread,
} from "@t3tools/shared/cacheKeepAlive";
import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  type OrchestrationV2Command,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** The ping window is five minutes wide, so a sweep every 30 s is plenty. */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * Pings tried per idle period: the first, and up to two retries after an
 * infrastructure failure (a busy database, say). Each attempt has its own
 * command id, since a failed command's receipt is permanent. A refusal from the
 * orchestrator's guard is final; it also guarantees one ping per idle period,
 * since an accepted ping starts a run and moves the thread on.
 */
const MAX_ATTEMPTS = 3;

const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);

type CacheKeepAliveCommand = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * Fork: the keep-alive ping, or the compaction that replaces it in the
 * toggle's compact modes, for a thread that is due one, else null. The command
 * and message ids name the executed run being kept warm and the attempt, so
 * repeated sweeps of one idle period never send the same attempt twice.
 */
export function cacheKeepAliveCommand(
  thread: CacheKeepAliveThread & { readonly id: ThreadId },
  nowMs: number,
  attempt = 1,
): CacheKeepAliveCommand | null {
  const state = cacheKeepAliveState({ thread, nowMs });
  if (state.kind !== "due" && state.kind !== "compact-due") return null;
  const compact = state.kind === "compact-due";
  const identity = `${compact ? "compact:" : ""}${thread.id}:${state.runId}:${attempt}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`cache-keep-alive:${identity}`),
    messageId: MessageId.make(`${CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX}${identity}`),
    threadId: thread.id,
    cacheKeepAliveOfRunId: state.runId,
    ...(compact
      ? { cacheKeepAliveAction: "compact" as const, idleCompaction: "beforeCacheExpires" as const }
      : {}),
    text: compact ? IDLE_COMPACTION_TEXT : CACHE_KEEP_ALIVE_NUDGE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  };
}

/** Each thread's ping (or compaction) for its current idle period. */
interface PingAttempts {
  readonly runId: RunId;
  readonly attempts: number;
  /** Accepted, or refused by the guard: nothing more to send this period. */
  readonly settled: boolean;
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const nextSweepAtMs = yield* Ref.make(0);
  const pings = yield* Ref.make(new Map<ThreadId, PingAttempts>());
  const record = (threadId: ThreadId, entry: PingAttempts) =>
    Ref.update(pings, (current) => new Map(current).set(threadId, entry));
  return Effect.fn("CacheKeepAliveWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (nowMs < (yield* Ref.get(nextSweepAtMs))) return;
    yield* Ref.set(nextSweepAtMs, nowMs + SWEEP_INTERVAL_MS);
    const threadIds = yield* projections.getCacheKeepAliveCandidates();
    yield* Ref.update(pings, (current) => {
      const live = new Set(threadIds);
      return new Map([...current].filter(([threadId]) => live.has(threadId)));
    });
    for (const threadId of threadIds) {
      yield* Effect.gen(function* () {
        const shell = yield* projections.getThreadShell(threadId);
        if (shell === null) return;
        const firstTry = cacheKeepAliveCommand(shell, nowMs);
        if (firstTry === null) return;
        const runId = firstTry.cacheKeepAliveOfRunId!;
        const known = (yield* Ref.get(pings)).get(threadId);
        const previous = known?.runId === runId ? known : undefined;
        if (previous !== undefined && (previous.settled || previous.attempts >= MAX_ATTEMPTS)) {
          return;
        }
        const attempt = (previous?.attempts ?? 0) + 1;
        const command = attempt === 1 ? firstTry : cacheKeepAliveCommand(shell, nowMs, attempt)!;
        yield* threads.dispatch(command).pipe(
          Effect.andThen(record(threadId, { runId, attempts: attempt, settled: true })),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            const error = Cause.squash(cause);
            const refused =
              isDispatchError(error) &&
              Orchestrator.isOrchestratorCacheKeepAliveRefusal(error.cause);
            return record(threadId, { runId, attempts: attempt, settled: refused }).pipe(
              Effect.andThen(
                refused
                  ? Effect.logDebug("orchestration-v2.cache-keep-alive.refused", { threadId })
                  : Effect.logWarning("orchestration-v2.cache-keep-alive.dispatch-failed", {
                      threadId,
                      attempt,
                      willRetry: attempt < MAX_ATTEMPTS,
                      cause,
                    }),
              ),
            );
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("orchestration-v2.cache-keep-alive.sweep-failed", {
                threadId,
                cause,
              }),
        ),
      );
    }
  });
});

// Due pings are derived from persisted runs and the thread's toggle, so a
// restart needs no timer restoration and no connected client.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("cache-keep-alive", sweep());
  }),
);
