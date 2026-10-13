import { assert, expect, it } from "@effect/vitest";
import {
  CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES,
  CACHE_KEEP_ALIVE_NUDGE_TEXT,
} from "@t3tools/shared/cacheKeepAlive";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as CacheKeepAliveWorker from "./CacheKeepAliveWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("claude");
const driver = ProviderDriverKind.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet-4-5" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for keep-alive tests"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "cache-keep-alive" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const providerThreadIdOf = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${threadId}`);

/** A thread whose conversation lives on Claude, with one finished user turn. */
const createClaudeThread = (threadId: ThreadId, options?: { readonly bindClaude?: boolean }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:cache-keep-alive"),
      title: "Keep alive",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    if (options?.bindClaude !== false) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:${threadId}:provider-thread`),
            type: "provider-thread.updated",
            threadId,
            driver,
            occurredAt: now,
            payload: {
              id: providerThreadIdOf(threadId),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    }
    const run: OrchestrationV2Run = {
      id: RunId.make(`run:${threadId}:user`),
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId: providerThreadIdOf(threadId),
      userMessageId: MessageId.make(`message:${threadId}:user`),
      rootNodeId: NodeId.make(`node:${threadId}:user`),
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* finishRun(run);
    return run;
  });

const finishRun = (run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${run.id}:finished`),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          driver,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
  });

const setKeepAlive = (threadId: ThreadId, enabled: boolean, suffix = "") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.cache-keep-alive.set",
      commandId: CommandId.make(`keep-alive:${threadId}:${enabled}${suffix}`),
      threadId,
      enabled,
    });
  });

const shellOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const shell = yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId);
    assert.isNotNull(shell);
    return shell!;
  });

/** The sweep's command for the thread right now, as the worker builds it. */
const pingCommand = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return CacheKeepAliveWorker.cacheKeepAliveCommand(yield* shellOf(threadId), driver, now);
  });

const userMessage = (threadId: ThreadId, id: string): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(`user:${id}`),
  threadId,
  messageId: MessageId.make(`user:${id}`),
  text: "Back again",
  attachments: [],
  dispatchMode: { type: "defer_start" },
  createdBy: "user",
  creationSource: "web",
});

it.effect("turns keep-alive on and off as UI state, not activity", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-toggle");
    yield* createClaudeThread(threadId);
    const before = yield* shellOf(threadId);

    yield* setKeepAlive(threadId, true);
    const on = yield* shellOf(threadId);
    expect(on.cacheKeepAlive).toMatchObject({ nudgeCount: 0, pausedAt: null });
    assert.deepEqual(on.updatedAt, before.updatedAt);

    yield* setKeepAlive(threadId, false);
    assert.isNull((yield* shellOf(threadId)).cacheKeepAlive ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "pings an idle Claude thread shortly before its cache lapses, as a quiet system turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:keep-alive-ping");
      const userRun = yield* createClaudeThread(threadId);
      yield* setKeepAlive(threadId, true);

      yield* TestClock.adjust("30 minutes");
      assert.isNull(yield* pingCommand(threadId));
      assert.deepEqual(
        yield* projections.getCacheKeepAliveCandidates({ now: yield* DateTime.now }),
        [],
      );
      // A ping sent too early is refused (the sweep never sends one).
      const early = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("keep-alive:early"),
          threadId,
          messageId: MessageId.make("cache-keep-alive:early"),
          cacheKeepAliveOfRunId: userRun.id,
          text: CACHE_KEEP_ALIVE_NUDGE_TEXT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(early));

      yield* TestClock.adjust("28 minutes");
      assert.deepEqual(
        yield* projections.getCacheKeepAliveCandidates({ now: yield* DateTime.now }),
        [{ threadId, driver }],
      );
      const ping = yield* pingCommand(threadId);
      expect(ping).toMatchObject({
        type: "message.dispatch",
        cacheKeepAliveOfRunId: userRun.id,
        text: CACHE_KEEP_ALIVE_NUDGE_TEXT,
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch(ping!);

      const projection = yield* projections.getThreadProjection(threadId);
      const pingRun = projection.runs.find((run) => run.userMessageId === ping!.messageId);
      assert.isDefined(pingRun);
      expect(projection.messages.find((message) => message.id === ping!.messageId)).toMatchObject({
        role: "user",
        createdBy: "system",
        text: CACHE_KEEP_ALIVE_NUDGE_TEXT,
      });
      expect(projection.thread.cacheKeepAlive).toMatchObject({
        nudgeCount: 1,
        pausedAt: null,
        lastNudgeRunId: pingRun!.id,
        // Never visited counts as read, so the ping's reply is not news.
        lastNudgeAfterRead: true,
      });
      // A ping is not the user writing: it leaves the authored-message clock alone.
      const shell = yield* shellOf(threadId);
      assert.isNull(shell.latestUserAuthoredMessageAt ?? null);
      // Mid-turn the thread is busy, so the sweep sends nothing more.
      assert.isNull(yield* pingCommand(threadId));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses pings for threads that are mid-turn or not on Claude", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const busyId = ThreadId.make("thread:keep-alive-busy");
    const busyRun = yield* createClaudeThread(busyId);
    yield* setKeepAlive(busyId, true);
    const unboundId = ThreadId.make("thread:keep-alive-unbound");
    const unboundRun = yield* createClaudeThread(unboundId, { bindClaude: false });
    yield* setKeepAlive(unboundId, true);
    yield* TestClock.adjust("58 minutes");

    // Due, then the user starts a turn before the ping lands.
    const ping = yield* pingCommand(busyId);
    assert.isNotNull(ping);
    yield* orchestrator.dispatch(userMessage(busyId, "busy"));
    assert.isTrue(Exit.isFailure(yield* orchestrator.dispatch(ping!).pipe(Effect.exit)));

    // No Claude provider thread holds this conversation, so there is no cache.
    const candidates =
      yield* (yield* ProjectionStore.ProjectionStoreV2).getCacheKeepAliveCandidates({
        now: yield* DateTime.now,
      });
    expect(candidates).toContainEqual({ threadId: unboundId, driver: null });
    const forced = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("keep-alive:unbound"),
        threadId: unboundId,
        messageId: MessageId.make("cache-keep-alive:unbound"),
        cacheKeepAliveOfRunId: unboundRun.id,
        text: CACHE_KEEP_ALIVE_NUDGE_TEXT,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(forced));
    assert.equal(busyRun.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pauses after the ping budget and resumes when the user writes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:keep-alive-cap");
    yield* createClaudeThread(threadId);
    yield* setKeepAlive(threadId, true);

    for (let sent = 1; sent <= CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES; sent++) {
      yield* TestClock.adjust("58 minutes");
      const ping = yield* pingCommand(threadId);
      assert.isNotNull(ping, `ping ${sent} should be due`);
      yield* orchestrator.dispatch(ping!);
      const projection = yield* projections.getThreadProjection(threadId);
      yield* finishRun(projection.runs.find((run) => run.userMessageId === ping!.messageId)!);
      assert.equal(projection.thread.cacheKeepAlive?.nudgeCount, sent);
    }
    const paused = (yield* shellOf(threadId)).cacheKeepAlive;
    assert.isNotNull(paused?.pausedAt ?? null);
    yield* TestClock.adjust("58 minutes");
    assert.isNull(yield* pingCommand(threadId));
    assert.deepEqual(
      yield* projections.getCacheKeepAliveCandidates({ now: yield* DateTime.now }),
      [],
    );

    // The user's next message restarts the budget and resumes keep-alive.
    yield* orchestrator.dispatch(userMessage(threadId, "resume"));
    expect((yield* shellOf(threadId)).cacheKeepAlive).toMatchObject({
      nudgeCount: 0,
      pausedAt: null,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("re-enabling a paused keep-alive resumes it with a fresh budget", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:keep-alive-resume");
    yield* createClaudeThread(threadId);
    yield* setKeepAlive(threadId, true);
    for (let sent = 1; sent <= CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES; sent++) {
      yield* TestClock.adjust("58 minutes");
      const ping = (yield* pingCommand(threadId))!;
      yield* orchestrator.dispatch(ping);
      const projection = yield* projections.getThreadProjection(threadId);
      yield* finishRun(projection.runs.find((run) => run.userMessageId === ping.messageId)!);
    }
    const paused = (yield* shellOf(threadId)).cacheKeepAlive!;
    assert.isNotNull(paused.pausedAt);

    yield* setKeepAlive(threadId, true, ":again");
    expect((yield* shellOf(threadId)).cacheKeepAlive).toMatchObject({
      nudgeCount: 0,
      pausedAt: null,
      lastNudgeRunId: paused.lastNudgeRunId,
    });
    // The last ping just finished, so its cache is warm and the next ping is scheduled.
    yield* TestClock.adjust("58 minutes");
    assert.isNotNull(yield* pingCommand(threadId));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the scheduler sweeps due threads every 30 seconds and dispatches their ping", () =>
  Effect.gen(function* () {
    const completedAt = yield* DateTime.now;
    const threadId = ThreadId.make("thread:keep-alive-sweep");
    const runId = RunId.make("run:keep-alive-sweep");
    const shell = {
      id: threadId,
      cacheKeepAlive: {
        enabledAt: completedAt,
        nudgeCount: 0,
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
      latestRunCompletedAt: completedAt,
    } as unknown as OrchestrationV2ThreadShell;
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const layerWorker = CacheKeepAliveWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getCacheKeepAliveCandidates: () => Effect.succeed([{ threadId, driver }]),
            getThreadShell: () => Effect.succeed(shell),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: (command) =>
              Ref.update(commands, (all) => [...all, command]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          }),
        ),
      ),
      Layer.provide(Scheduler.layer),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("58 minutes");
      expect(yield* Ref.get(commands)).toMatchObject([
        {
          type: "message.dispatch",
          commandId: `cache-keep-alive:${threadId}:${runId}`,
          messageId: `cache-keep-alive:${threadId}:${runId}`,
          cacheKeepAliveOfRunId: runId,
        },
      ]);
      // Scheduler ticks every 5 s; the keep-alive sweep runs at most every 30 s.
      yield* TestClock.adjust("25 seconds");
      assert.equal((yield* Ref.get(commands)).length, 1);
      yield* TestClock.adjust("5 seconds");
      assert.equal((yield* Ref.get(commands)).length, 2);
    }).pipe(Effect.provide(layerWorker));
  }),
);
