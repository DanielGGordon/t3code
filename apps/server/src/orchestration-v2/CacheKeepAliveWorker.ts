import {
  CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX,
  CACHE_KEEP_ALIVE_NUDGE_TEXT,
  cacheKeepAliveState,
  type CacheKeepAliveThread,
} from "@t3tools/shared/cacheKeepAlive";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** The ping window is two minutes wide, so a sweep every 30 s is plenty. */
const SWEEP_INTERVAL_MS = 30_000;

type CacheKeepAliveCommand = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * Fork: the keep-alive ping for a thread that is due one, else null. The
 * command and message ids name the executed run being kept warm, so repeated
 * sweeps of one idle period dispatch it at most once.
 */
export function cacheKeepAliveCommand(
  thread: CacheKeepAliveThread & { readonly id: ThreadId },
  nowMs: number,
): CacheKeepAliveCommand | null {
  const state = cacheKeepAliveState({ thread, nowMs });
  if (state.kind !== "due") return null;
  const identity = `${thread.id}:${state.runId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`cache-keep-alive:${identity}`),
    messageId: MessageId.make(`${CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX}${identity}`),
    threadId: thread.id,
    cacheKeepAliveOfRunId: state.runId,
    text: CACHE_KEEP_ALIVE_NUDGE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const nextSweepAtMs = yield* Ref.make(0);
  // The last ping each thread was sent. Its receipt already settles a repeat
  // (accepted or refused), so a later sweep of the same idle period skips it
  // instead of logging the same refusal again.
  const attempted = yield* Ref.make(new Map<ThreadId, string>());
  return Effect.fn("CacheKeepAliveWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (nowMs < (yield* Ref.get(nextSweepAtMs))) return;
    yield* Ref.set(nextSweepAtMs, nowMs + SWEEP_INTERVAL_MS);
    const threadIds = yield* projections.getCacheKeepAliveCandidates();
    yield* Ref.update(attempted, (current) => {
      const live = new Set(threadIds);
      return new Map([...current].filter(([threadId]) => live.has(threadId)));
    });
    for (const threadId of threadIds) {
      yield* Effect.gen(function* () {
        const shell = yield* projections.getThreadShell(threadId);
        if (shell === null) return;
        const command = cacheKeepAliveCommand(shell, nowMs);
        if (command === null) return;
        if ((yield* Ref.get(attempted)).get(threadId) === command.commandId) return;
        yield* Ref.update(attempted, (current) =>
          new Map(current).set(threadId, command.commandId),
        );
        yield* threads.dispatch(command);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("orchestration-v2.cache-keep-alive.dispatch-failed", {
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
