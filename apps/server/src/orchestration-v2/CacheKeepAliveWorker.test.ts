import { assert, expect, it } from "@effect/vitest";
import {
  CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES,
  CACHE_KEEP_ALIVE_NUDGE_TEXT,
} from "@t3tools/shared/cacheKeepAlive";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as CacheKeepAliveWorker from "./CacheKeepAliveWorker.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
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
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EventStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "cache-keep-alive" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      providerInstances: { [instanceId]: { driver, enabled: true } },
    },
  ),
);

const MINUTE = 60_000;
const providerThreadIdOf = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${threadId}`);
let fixtureCounter = 0;
const nextId = (prefix: string) => `${prefix}:${++fixtureCounter}`;

const write = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    yield* (yield* EventSink.EventSinkV2).write({ events });
  });

const minutesFromNow = (minutes: number) =>
  Effect.map(DateTime.now, (now) => DateTime.add(now, { milliseconds: minutes * MINUTE }));

const runFixture = (threadId: ThreadId, ordinal: number, at: DateTime.Utc): OrchestrationV2Run => ({
  id: RunId.make(`run:${threadId}:${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId: providerThreadIdOf(threadId),
  userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
  rootNodeId: NodeId.make(`node:${threadId}:${ordinal}`),
  activeAttemptId: null,
  status: "completed",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
});

/**
 * What the Claude adapter records for a model response, as it really lays it
 * out: a `reasoning` item on the run's root node, which begins just after the
 * request, and the assistant message on a per-item child node a little later.
 * Only the root item dates the cache.
 */
const providerItems = (
  run: OrchestrationV2Run,
  startedAt: DateTime.Utc,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const base = (nodeId: NodeId | null, at: DateTime.Utc) => {
    const id = nextId("item");
    return {
      id,
      event: {
        id: EventId.make(`event:${id}`),
        type: "turn-item.updated" as const,
        threadId: run.threadId,
        runId: run.id,
        driver,
        occurredAt: at,
      },
      payload: {
        id: TurnItemId.make(id),
        threadId: run.threadId,
        runId: run.id,
        nodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: fixtureCounter,
        status: "completed" as const,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      },
    };
  };
  const root = base(run.rootNodeId, startedAt);
  const answeredAt = DateTime.add(startedAt, { seconds: 5 });
  const child = base(NodeId.make(`${run.rootNodeId}:child:${fixtureCounter}`), answeredAt);
  return [
    {
      ...root.event,
      payload: { ...root.payload, type: "reasoning", text: "Thinking.", streaming: false },
    },
    {
      ...child.event,
      payload: {
        ...child.payload,
        type: "assistant_message",
        messageId: MessageId.make(`assistant:${child.id}`),
        text: "Done.",
        streaming: false,
      },
    },
  ];
};

const runUpdated = (run: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${nextId("run")}`),
  type: "run.updated",
  threadId: run.threadId,
  runId: run.id,
  driver,
  occurredAt: run.completedAt ?? run.requestedAt,
  payload: run,
});

/**
 * Records a run that talked to the provider at `lastRequestAt` and was marked
 * finished at `completedAt` (checkpoint capture, or the user's stop, can be later).
 */
const recordRun = (
  run: OrchestrationV2Run,
  options: {
    readonly lastRequestAt: DateTime.Utc | null;
    readonly completedAt?: DateTime.Utc;
    readonly status?: OrchestrationV2Run["status"];
  },
) =>
  write([
    ...(options.lastRequestAt === null ? [] : providerItems(run, options.lastRequestAt)),
    runUpdated({
      ...run,
      status: options.status ?? "completed",
      completedAt: options.completedAt ?? options.lastRequestAt ?? run.completedAt,
    }),
  ]);

/** A thread whose conversation lives on Claude, with keep-alive on and no runs yet. */
const createThread = (threadId: ThreadId, options?: { readonly bindClaude?: boolean }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
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
      yield* write([
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
      ]);
    }
    yield* setKeepAlive(threadId, true);
  });

/** A Claude thread with keep-alive on and one finished user turn, dated now. */
const createIdleThread = (threadId: ThreadId, options?: { readonly bindClaude?: boolean }) =>
  Effect.gen(function* () {
    yield* createThread(threadId, options);
    const now = yield* DateTime.now;
    const run = runFixture(threadId, 1, now);
    yield* recordRun(run, { lastRequestAt: now });
    return run;
  });

const setKeepAlive = (
  threadId: ThreadId,
  enabled: boolean,
  mode?: "warm" | "compact" | "warm-then-compact",
) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.cache-keep-alive.set",
      commandId: CommandId.make(nextId(`keep-alive:${threadId}:${enabled}`)),
      threadId,
      enabled,
      ...(mode === undefined ? {} : { mode }),
    });
  });

const shellOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(threadId);
    assert.isNotNull(shell);
    return shell!;
  });

/** The sweep's command for the thread right now, as the worker builds it. */
const pingCommand = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return CacheKeepAliveWorker.cacheKeepAliveCommand(yield* shellOf(threadId), now);
  });

/** A ping for `runId` built by hand, to show the orchestrator refuses it. */
const forcedPing = (threadId: ThreadId, runId: RunId): OrchestrationV2Command => {
  const id = nextId("forced");
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(`cache-keep-alive:${id}`),
    cacheKeepAliveOfRunId: runId,
    text: CACHE_KEEP_ALIVE_NUDGE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  };
};

const refused = (command: OrchestrationV2Command) =>
  Effect.gen(function* () {
    const exit = yield* (yield* Orchestrator.OrchestratorV2).dispatch(command).pipe(Effect.exit);
    return Exit.isFailure(exit);
  });

/** Sends the due ping and finishes its run the way Claude would, now. */
const pingAndFinish = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const ping = yield* pingCommand(threadId);
    assert.isNotNull(ping, "a ping should be due");
    yield* (yield* Orchestrator.OrchestratorV2).dispatch(ping!);
    const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
      threadId,
    );
    const run = projection.runs.find((candidate) => candidate.userMessageId === ping!.messageId)!;
    yield* recordRun(run, { lastRequestAt: yield* DateTime.now });
    return run;
  });

const sendMessage = (
  threadId: ThreadId,
  from: Pick<
    Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
    "createdBy" | "creationSource"
  >,
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> => {
  const id = nextId("message");
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(id),
    text: "Back again",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    ...from,
  };
};
const userMessage = (threadId: ThreadId) =>
  sendMessage(threadId, { createdBy: "user", creationSource: "web" });

const keepAliveOf = (threadId: ThreadId) =>
  Effect.map(shellOf(threadId), (shell) => shell.cacheKeepAlive ?? null);

it.effect("turns keep-alive on and off as UI state, not activity", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-toggle");
    yield* createIdleThread(threadId);
    const before = yield* shellOf(threadId);
    expect(before.cacheKeepAlive).toMatchObject({ nudgeCount: 0, pausedAt: null });
    expect(before.cacheKeepAliveContext).toMatchObject({ driver, hasQueuedRun: false });

    yield* setKeepAlive(threadId, false);
    const off = yield* shellOf(threadId);
    assert.isNull(off.cacheKeepAlive ?? null);
    // A Claude thread keeps its context with the toggle off, so the header can
    // still count down to expiry.
    expect(off.cacheKeepAliveContext).toMatchObject({ driver, hasQueuedRun: false });
    assert.deepEqual(off.updatedAt, before.updatedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "pings an idle Claude thread shortly before its cache lapses, as a quiet system turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:keep-alive-ping");
      const userRun = yield* createIdleThread(threadId);

      yield* TestClock.adjust("30 minutes");
      assert.isNull(yield* pingCommand(threadId));
      // A ping sent too early is refused (the sweep never sends one).
      assert.isTrue(yield* refused(forcedPing(threadId, userRun.id)));

      yield* TestClock.adjust("28 minutes");
      assert.deepEqual(yield* projections.getCacheKeepAliveCandidates(), [threadId]);
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
      assert.isNull((yield* shellOf(threadId)).latestUserAuthoredMessageAt ?? null);
      // Mid-turn the thread is busy, so the sweep sends nothing more.
      assert.isNull(yield* pingCommand(threadId));
      assert.deepEqual(yield* projections.getCacheKeepAliveCandidates(), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dates the cache by provider activity, not a late checkpoint, in SQL and in memory alike",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:keep-alive-late-checkpoint");
      yield* createThread(threadId);
      const lastRequestAt = yield* DateTime.now;
      const run = runFixture(threadId, 1, lastRequestAt);
      // Claude finished at once; checkpoint capture marked the run done 5 minutes
      // later and wrote its checkpoint item on the root node then.
      const checkpointAt = yield* minutesFromNow(5);
      yield* recordRun(run, { lastRequestAt, completedAt: checkpointAt });
      yield* write([
        {
          id: EventId.make(`event:${threadId}:checkpoint`),
          type: "turn-item.updated",
          threadId,
          runId: run.id,
          occurredAt: checkpointAt,
          payload: {
            id: TurnItemId.make(`item:${threadId}:checkpoint`),
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ++fixtureCounter,
            status: "completed",
            title: null,
            startedAt: checkpointAt,
            completedAt: checkpointAt,
            updatedAt: checkpointAt,
            type: "checkpoint",
            checkpointId: CheckpointId.make(`checkpoint:${threadId}`),
            scopeId: CheckpointScopeId.make(`scope:${threadId}`),
            files: [],
          },
        },
      ]);

      const shell = yield* shellOf(threadId);
      expect(shell.cacheKeepAliveContext?.run).toMatchObject({ id: run.id });
      // The root reasoning item dates it: not the checkpoint item, and not the
      // assistant message on its child node 5 s later.
      assert.deepEqual(shell.cacheKeepAliveContext?.run?.lastProviderActivityAt, lastRequestAt);
      // The in-memory shell builder agrees with the SQL one on that layout.
      assert.deepEqual(
        ProjectionStore.threadShellFromProjection(yield* projections.getThreadProjection(threadId))
          .cacheKeepAliveContext,
        shell.cacheKeepAliveContext,
      );

      // 55 minutes after the last request (50 after the recorded completion) it is due.
      yield* TestClock.adjust("55 minutes");
      const ping = yield* pingCommand(threadId);
      assert.isNotNull(ping);
      yield* (yield* Orchestrator.OrchestratorV2).dispatch(ping!);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("dates a stopped run by its last request, and never guesses without one", () =>
  Effect.gen(function* () {
    const stoppedId = ThreadId.make("thread:keep-alive-stopped");
    yield* createThread(stoppedId);
    const lastRequestAt = yield* DateTime.now;
    const stopped = runFixture(stoppedId, 1, lastRequestAt);
    // The user stopped it ten minutes into a long tool call.
    yield* recordRun(stopped, {
      lastRequestAt,
      completedAt: yield* minutesFromNow(10),
      status: "interrupted",
    });
    const undatedId = ThreadId.make("thread:keep-alive-stopped-undated");
    yield* createThread(undatedId);
    yield* recordRun(runFixture(undatedId, 1, lastRequestAt), {
      lastRequestAt: null,
      completedAt: yield* minutesFromNow(10),
      status: "interrupted",
    });

    yield* TestClock.adjust("55 minutes");
    const ping = yield* pingCommand(stoppedId);
    expect(ping).toMatchObject({ cacheKeepAliveOfRunId: stopped.id });
    yield* (yield* Orchestrator.OrchestratorV2).dispatch(ping!);
    assert.isNull(yield* pingCommand(undatedId));
    yield* TestClock.adjust("10 minutes");
    assert.isNull(yield* pingCommand(undatedId));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the run that executed last warm, whatever order runs were queued in", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-out-of-order");
    yield* createThread(threadId);
    const start = yield* DateTime.now;
    yield* recordRun(runFixture(threadId, 1, start), { lastRequestAt: start });
    // Run 3 started ahead of a held queue; queued run 2 resumed and finished last.
    yield* TestClock.adjust("1 minute");
    yield* recordRun(runFixture(threadId, 3, yield* DateTime.now), {
      lastRequestAt: yield* DateTime.now,
    });
    yield* TestClock.adjust("1 minute");
    const resumed = runFixture(threadId, 2, yield* DateTime.now);
    yield* recordRun(resumed, { lastRequestAt: yield* DateTime.now });

    expect((yield* shellOf(threadId)).cacheKeepAliveContext?.run).toMatchObject({ id: resumed.id });
    yield* TestClock.adjust("55 minutes");
    const ping = yield* pingCommand(threadId);
    expect(ping).toMatchObject({ cacheKeepAliveOfRunId: resumed.id });
    yield* (yield* Orchestrator.OrchestratorV2).dispatch(ping!);
    assert.equal((yield* keepAliveOf(threadId))?.nudgeCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a queued message cancelled before it started leaves the warm run in charge", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-cancelled-queue");
    const warm = yield* createIdleThread(threadId);
    yield* TestClock.adjust("5 minutes");
    yield* write([
      runUpdated({
        ...runFixture(threadId, 2, yield* DateTime.now),
        status: "cancelled",
        startedAt: null,
        completedAt: yield* DateTime.now,
      }),
    ]);
    expect((yield* shellOf(threadId)).cacheKeepAliveContext?.run).toMatchObject({ id: warm.id });

    yield* TestClock.adjust("50 minutes");
    const ping = yield* pingCommand(threadId);
    expect(ping).toMatchObject({ cacheKeepAliveOfRunId: warm.id });
    yield* (yield* Orchestrator.OrchestratorV2).dispatch(ping!);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses pings mid-turn, off Claude, and for archived, snoozed or settled threads", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const busyId = ThreadId.make("thread:keep-alive-busy");
    yield* createIdleThread(busyId);
    const unboundId = ThreadId.make("thread:keep-alive-unbound");
    const unboundRun = yield* createIdleThread(unboundId, { bindClaude: false });
    const parked = yield* Effect.forEach(["archived", "snoozed", "settled"] as const, (kind) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread:keep-alive-${kind}`);
        return { kind, threadId, run: yield* createIdleThread(threadId) };
      }),
    );
    yield* TestClock.adjust("55 minutes");

    // Due, then the user starts a turn before the ping lands.
    const ping = yield* pingCommand(busyId);
    assert.isNotNull(ping);
    yield* orchestrator.dispatch(userMessage(busyId));
    assert.isTrue(yield* refused(ping!));

    // No Claude provider thread holds this conversation, so there is no cache.
    expect((yield* shellOf(unboundId)).cacheKeepAliveContext).toMatchObject({ driver: null });
    assert.isNull(yield* pingCommand(unboundId));
    assert.isTrue(yield* refused(forcedPing(unboundId, unboundRun.id)));

    for (const { kind, threadId, run } of parked) {
      const common = { commandId: CommandId.make(nextId(kind)), threadId };
      yield* orchestrator.dispatch(
        kind === "archived"
          ? { ...common, type: "thread.archive" }
          : kind === "snoozed"
            ? {
                ...common,
                type: "thread.snooze",
                snoozedUntil: DateTime.formatIso(yield* minutesFromNow(120)),
              }
            : { ...common, type: "thread.settle" },
      );
      assert.isNull(yield* pingCommand(threadId).pipe(Effect.orElseSucceed(() => null)), kind);
      assert.isTrue(yield* refused(forcedPing(threadId, run.id)), kind);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the user's messages reset the ping count; agents' do not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:keep-alive-reset");
    yield* createIdleThread(threadId);
    for (let sent = 1; sent <= 2; sent++) {
      yield* TestClock.adjust("55 minutes");
      yield* pingAndFinish(threadId);
    }
    assert.equal((yield* keepAliveOf(threadId))?.nudgeCount, 2);

    yield* orchestrator.dispatch(
      sendMessage(threadId, { createdBy: "agent", creationSource: "mcp" }),
    );
    assert.equal((yield* keepAliveOf(threadId))?.nudgeCount, 2);
    // A web-created scheduled task is sent as the user who made it; still not the user.
    yield* orchestrator.dispatch({
      ...userMessage(threadId),
      scheduledTaskId: ScheduledTaskId.make("task:daily-audit"),
    });
    assert.equal((yield* keepAliveOf(threadId))?.nudgeCount, 2);

    yield* orchestrator.dispatch(userMessage(threadId));
    expect(yield* keepAliveOf(threadId)).toMatchObject({ nudgeCount: 0, pausedAt: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a user message sent while a ping runs makes that run real work, not a quiet ping", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:keep-alive-steer");
    yield* createIdleThread(threadId);
    yield* TestClock.adjust("55 minutes");
    const ping = yield* pingCommand(threadId);
    yield* orchestrator.dispatch(ping!);
    expect(yield* keepAliveOf(threadId)).toMatchObject({ nudgeCount: 1, lastNudgeAfterRead: true });
    assert.isNotNull((yield* keepAliveOf(threadId))?.lastNudgeRunId ?? null);

    // On Claude the web's auto delivery steers this into the ping's live run
    // (here, with no live session, it queues behind it); either way the run
    // now carries the user's work, so it must not stay quiet.
    yield* orchestrator.dispatch({ ...userMessage(threadId), deliveryIntent: "auto" });
    expect(yield* keepAliveOf(threadId)).toMatchObject({
      nudgeCount: 0,
      lastNudgeRunId: null,
      lastNudgeAfterRead: false,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("answering an agent's question counts as the user writing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:keep-alive-answer");
    yield* createIdleThread(threadId);
    yield* TestClock.adjust("55 minutes");
    const pingRun = yield* pingAndFinish(threadId);
    assert.equal((yield* keepAliveOf(threadId))?.nudgeCount, 1);

    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make("request:question");
    yield* write([
      {
        id: EventId.make("event:question:request"),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: pingRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      },
      {
        id: EventId.make("event:question:item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:question"),
          threadId,
          runId: pingRun.id,
          nodeId: pingRun.rootNodeId,
          providerThreadId: pingRun.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ++fixtureCounter,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "user_input_request",
          requestId,
          questions: [{ id: "q1", header: "Choice", question: "Which one?", options: [] }],
        },
      },
    ]);
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer:question"),
      threadId,
      requestId,
      answers: { q1: "The first" },
    });
    assert.equal((yield* keepAliveOf(threadId))?.nudgeCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("marking the thread unread overrides a quiet ping", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-unread");
    yield* createIdleThread(threadId);
    yield* TestClock.adjust("55 minutes");
    yield* pingAndFinish(threadId);
    assert.isTrue((yield* keepAliveOf(threadId))?.lastNudgeAfterRead);
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("unread:keep-alive"),
      threadId,
    });
    assert.isFalse((yield* keepAliveOf(threadId))?.lastNudgeAfterRead);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pauses after the ping budget; the user's next message or the toggle resumes it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:keep-alive-cap");
    yield* createIdleThread(threadId);
    for (let sent = 1; sent <= CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES; sent++) {
      yield* TestClock.adjust("55 minutes");
      yield* pingAndFinish(threadId);
      assert.equal((yield* keepAliveOf(threadId))?.nudgeCount, sent);
    }
    const paused = (yield* keepAliveOf(threadId))!;
    assert.isNotNull(paused.pausedAt);
    yield* TestClock.adjust("55 minutes");
    assert.isNull(yield* pingCommand(threadId));
    assert.deepEqual(yield* projections.getCacheKeepAliveCandidates(), []);

    // Turning it on again resumes with a fresh budget...
    yield* setKeepAlive(threadId, true);
    expect(yield* keepAliveOf(threadId)).toMatchObject({
      nudgeCount: 0,
      pausedAt: null,
      lastNudgeRunId: paused.lastNudgeRunId,
    });
    // ...and so does the user's next message.
    for (let sent = 1; sent <= CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES; sent++) {
      const run = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
      yield* recordRun(run, { lastRequestAt: yield* DateTime.now });
      yield* TestClock.adjust("55 minutes");
      yield* pingAndFinish(threadId);
    }
    assert.isNotNull((yield* keepAliveOf(threadId))?.pausedAt ?? null);
    yield* orchestrator.dispatch(userMessage(threadId));
    expect(yield* keepAliveOf(threadId)).toMatchObject({ nudgeCount: 0, pausedAt: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "compact mode sends /compact shortly before the cache lapses, once, and never pings",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:keep-alive-compact");
      const userRun = yield* createIdleThread(threadId);
      yield* setKeepAlive(threadId, true, "compact");
      expect(yield* keepAliveOf(threadId)).toMatchObject({ mode: "compact", nudgeCount: 0 });

      yield* TestClock.adjust("30 minutes");
      assert.isNull(yield* pingCommand(threadId));
      yield* TestClock.adjust("28 minutes");
      assert.deepEqual(yield* projections.getCacheKeepAliveCandidates(), [threadId]);
      // The ping the mode replaced is refused even though the cache is nearly out.
      assert.isTrue(yield* refused(forcedPing(threadId, userRun.id)));
      const compaction = yield* pingCommand(threadId);
      expect(compaction).toMatchObject({
        cacheKeepAliveOfRunId: userRun.id,
        cacheKeepAliveAction: "compact",
        idleCompaction: "beforeCacheExpires",
        text: "/compact",
        createdBy: "system",
        creationSource: "server",
      });
      yield* orchestrator.dispatch(compaction!);

      const projection = yield* projections.getThreadProjection(threadId);
      const compactRun = projection.runs.find((run) => run.userMessageId === compaction!.messageId);
      assert.isDefined(compactRun);
      // Not the user writing, and not a ping: the ping budget is untouched.
      expect(projection.thread.cacheKeepAlive).toMatchObject({
        nudgeCount: 0,
        lastCompactRunId: compactRun!.id,
      });
      assert.isNull((yield* shellOf(threadId)).latestUserAuthoredMessageAt ?? null);

      // Once it has run, the idle period is done: nothing more until the user writes.
      yield* recordRun(compactRun!, { lastRequestAt: yield* DateTime.now });
      yield* TestClock.adjust("58 minutes");
      assert.isNull(yield* pingCommand(threadId));
      assert.isTrue(yield* refused({ ...compaction!, commandId: CommandId.make(nextId("again")) }));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "warm-then-compact pings through the budget, then compacts before the last cache lapses",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:keep-alive-warm-then-compact");
      yield* createIdleThread(threadId);
      yield* setKeepAlive(threadId, true, "warm-then-compact");
      for (let sent = 1; sent <= CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES; sent++) {
        yield* TestClock.adjust("55 minutes");
        yield* pingAndFinish(threadId);
      }
      assert.isNotNull((yield* keepAliveOf(threadId))?.pausedAt ?? null);

      // Spent pings do not drop the thread from the sweep: the compaction is next.
      assert.deepEqual(yield* projections.getCacheKeepAliveCandidates(), [threadId]);
      assert.isNull(yield* pingCommand(threadId));
      yield* TestClock.adjust("55 minutes");
      const compaction = yield* pingCommand(threadId);
      expect(compaction).toMatchObject({ cacheKeepAliveAction: "compact", text: "/compact" });
      yield* orchestrator.dispatch(compaction!);
      const projection = yield* projections.getThreadProjection(threadId);
      expect(projection.thread.cacheKeepAlive).toMatchObject({
        nudgeCount: CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES,
        lastCompactRunId: projection.runs.at(-1)!.id,
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("does not compact a thread whose last turn already was a /compact", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-compact-after-compact");
    const run = yield* createIdleThread(threadId);
    yield* write([
      {
        id: EventId.make(`event:${nextId("manual-compact")}`),
        type: "message.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: run.userMessageId,
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          role: "user",
          text: "/compact",
          attachments: [],
          streaming: false,
          createdAt: run.requestedAt,
          updatedAt: run.requestedAt,
        },
      },
    ]);
    yield* setKeepAlive(threadId, true, "compact");
    yield* TestClock.adjust("58 minutes");
    const compaction = yield* pingCommand(threadId);
    assert.isNotNull(compaction);
    assert.isTrue(yield* refused(compaction!));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the toggle, count and pause rebuild from the event log", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-rebuild");
    yield* createIdleThread(threadId);
    for (let sent = 1; sent <= CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES; sent++) {
      yield* TestClock.adjust("55 minutes");
      yield* pingAndFinish(threadId);
    }
    const live = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(threadId))
      .cacheKeepAlive;
    assert.isNotNull(live?.pausedAt ?? null);

    const stored = yield* (yield* EventStore.EventStoreV2)
      .read({ threadId })
      .pipe(Stream.runCollect);
    const rebuilt = yield* Effect.gen(function* () {
      const fresh = yield* ProjectionStore.ProjectionStoreV2;
      for (const { event } of stored) yield* fresh.apply(event);
      return (yield* fresh.getThread(threadId)).cacheKeepAlive;
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    );
    assert.deepEqual(rebuilt, live);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("usage-limit recovery does not resume a ping that hit the limit", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const limited = (threadId: ThreadId, userMessageId: string) =>
      Effect.gen(function* () {
        yield* createThread(threadId);
        const now = yield* DateTime.now;
        const run = {
          ...runFixture(threadId, 1, now),
          userMessageId: MessageId.make(userMessageId),
          status: "failed" as const,
        };
        yield* write([
          runUpdated(run),
          {
            id: EventId.make(`event:${threadId}:limit`),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:${threadId}:limit`),
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: run.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: ++fixtureCounter,
              status: "failed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "error",
              failure: {
                class: "usage_limit",
                message: "Usage limit reached",
                code: null,
                retryable: false,
                resetAt: DateTime.formatIso(yield* minutesFromNow(60)),
              },
            },
          },
        ]);
      });
    const realId = ThreadId.make("thread:limited-real");
    const pingId = ThreadId.make("thread:limited-ping");
    yield* limited(realId, "message:real");
    yield* limited(pingId, `cache-keep-alive:${pingId}:run`);

    const candidates = yield* projections.getLimitRecoveryCandidates({
      now: yield* DateTime.now,
      autoResume: true,
      snooze: false,
    });
    assert.deepEqual(
      candidates.map((thread) => thread.id),
      [realId],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the real sweep pings a due thread through the projection and the orchestrator", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:keep-alive-end-to-end");
    yield* createIdleThread(threadId);
    const layerWorker = CacheKeepAliveWorker.layer.pipe(
      Layer.provide(
        Layer.merge(
          ThreadManagementService.layer.pipe(
            // The dispatch chokepoint refuses provider work on an instance the
            // settings leave off; the fixture instance is not a default one.
            Layer.provide(
              ServerSettings.layerTest({
                providerInstances: { [instanceId]: { driver, enabled: true } },
              }),
            ),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
          ),
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("55 minutes");
      // The scheduler fiber runs the sweep after the tick; let it finish.
      let keepAlive = yield* keepAliveOf(threadId);
      for (let turn = 0; turn < 200 && keepAlive?.nudgeCount !== 1; turn++) {
        yield* Effect.yieldNow;
        keepAlive = yield* keepAliveOf(threadId);
      }
      expect(keepAlive).toMatchObject({ nudgeCount: 1 });
      const messages = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        threadId,
      )).messages;
      expect(messages.at(-1)).toMatchObject({
        createdBy: "system",
        text: CACHE_KEEP_ALIVE_NUDGE_TEXT,
      });
    }).pipe(Effect.provide(layerWorker));
  }).pipe(Effect.provide(layerTest)),
);

/**
 * The worker against a due thread, with the orchestrator mocked so a test can
 * script each dispatch's outcome.
 */
const runMockedSweep = (
  outcome: (attempt: number) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>,
  body: (state: {
    readonly commands: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>;
    readonly sweeps: Ref.Ref<number>;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const anchor = yield* DateTime.now;
    const threadId = ThreadId.make("thread:keep-alive-sweep");
    const runId = RunId.make("run:keep-alive-sweep");
    const shell = {
      id: threadId,
      cacheKeepAlive: {
        enabledAt: anchor,
        nudgeCount: 0,
        pausedAt: null,
        lastNudgeRunId: null,
        lastNudgeAfterRead: false,
      },
      cacheKeepAliveContext: {
        driver,
        run: {
          id: runId,
          status: "completed",
          completedAt: anchor,
          lastProviderActivityAt: anchor,
        },
        hasQueuedRun: false,
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
    } as unknown as OrchestrationV2ThreadShell;
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const sweeps = yield* Ref.make(0);
    const layerWorker = CacheKeepAliveWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getCacheKeepAliveCandidates: () =>
              Ref.update(sweeps, (count) => count + 1).pipe(Effect.as([threadId])),
            getThreadShell: () => Effect.succeed(shell),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: (command) =>
              Ref.updateAndGet(commands, (all) => [...all, command]).pipe(
                Effect.flatMap((all) => outcome(all.length)),
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          }),
        ),
      ),
      Layer.provide(Scheduler.layer),
    );
    yield* body({ commands, sweeps, runId, threadId }).pipe(Effect.provide(layerWorker));
  });

const commandIds = (commands: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>) =>
  Effect.map(Ref.get(commands), (all) => all.map((command) => command.commandId));

it.effect("the sweep runs every 30 seconds and sends each idle period's ping once", () =>
  runMockedSweep(
    () => Effect.void,
    ({ commands, sweeps, runId, threadId }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("55 minutes");
        expect(yield* Ref.get(commands)).toMatchObject([
          {
            type: "message.dispatch",
            commandId: `cache-keep-alive:${threadId}:${runId}:1`,
            messageId: `cache-keep-alive:${threadId}:${runId}:1`,
            cacheKeepAliveOfRunId: runId,
          },
        ]);
        // Scheduler ticks every 5 s; the keep-alive sweep runs at most every 30 s.
        const sweepsSoFar = yield* Ref.get(sweeps);
        yield* TestClock.adjust("25 seconds");
        assert.equal(yield* Ref.get(sweeps), sweepsSoFar);
        yield* TestClock.adjust("5 seconds");
        assert.equal(yield* Ref.get(sweeps), sweepsSoFar + 1);
        // The accepted ping is not sent again.
        assert.equal((yield* Ref.get(commands)).length, 1);
      }),
  ),
);

it.effect("an infrastructure failure is retried under a new command id, at most twice", () =>
  runMockedSweep(
    (attempt) =>
      attempt <= 3
        ? Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: CommandId.make(`failed:${attempt}`),
              commandType: "message.dispatch",
              cause: new Error("database is locked"),
            }),
          )
        : Effect.void,
    ({ commands, runId, threadId }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("55 minutes");
        yield* TestClock.adjust("30 seconds");
        yield* TestClock.adjust("30 seconds");
        yield* TestClock.adjust("30 seconds");
        assert.deepEqual(yield* commandIds(commands), [
          `cache-keep-alive:${threadId}:${runId}:1`,
          `cache-keep-alive:${threadId}:${runId}:2`,
          `cache-keep-alive:${threadId}:${runId}:3`,
        ]);
      }),
  ),
);

it.effect("a transient failure followed by success sends one ping", () =>
  runMockedSweep(
    (attempt) =>
      attempt === 1
        ? Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: CommandId.make("failed:once"),
              commandType: "message.dispatch",
              cause: new Error("database is locked"),
            }),
          )
        : Effect.void,
    ({ commands, runId, threadId }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("55 minutes");
        yield* TestClock.adjust("90 seconds");
        assert.deepEqual(yield* commandIds(commands), [
          `cache-keep-alive:${threadId}:${runId}:1`,
          `cache-keep-alive:${threadId}:${runId}:2`,
        ]);
      }),
  ),
);

it.effect("the guard's refusal is final for the idle period", () =>
  runMockedSweep(
    () =>
      Effect.fail(
        new Orchestrator.OrchestratorDispatchError({
          commandId: CommandId.make("refused"),
          commandType: "message.dispatch",
          cause: new Orchestrator.OrchestratorCacheKeepAliveRefusal({
            threadId: ThreadId.make("thread:keep-alive-sweep"),
            runId: RunId.make("run:keep-alive-sweep"),
          }),
        }),
      ),
    ({ commands }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("55 minutes");
        yield* TestClock.adjust("90 seconds");
        assert.equal((yield* Ref.get(commands)).length, 1);
      }),
  ),
);
