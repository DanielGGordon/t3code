import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RestartRequestReactor from "./RestartRequestReactor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// Fork: replaces the v1 restart-flag tests from the deleted
// integration/orchestrationEngine.integration.test.ts.

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for restart-request tests"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "restart-request" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:restart-request"),
      title: "Restart request",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const assistantMessage = (input: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly text: string;
  readonly streaming?: boolean;
  readonly runId?: RunId | null;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      id: EventId.make(`message:${input.messageId}:${input.streaming === true}`),
      type: "message.updated" as const,
      threadId: input.threadId,
      occurredAt: now,
      payload: {
        createdBy: "agent" as const,
        creationSource: "server" as const,
        id: MessageId.make(input.messageId),
        threadId: input.threadId,
        runId: input.runId === undefined ? RunId.make(`run:${input.threadId}`) : input.runId,
        nodeId: null,
        role: "assistant" as const,
        text: input.text,
        attachments: [],
        streaming: input.streaming ?? false,
        createdAt: now,
        updatedAt: now,
      },
    };
  });

it.effect("sets and clears the restart request without bumping thread activity", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:restart-manual");
    yield* createThread(threadId);
    const before = yield* projections.getThreadProjection(threadId);

    yield* orchestrator.dispatch({
      type: "thread.restart-request.set",
      commandId: CommandId.make("restart-manual-on"),
      threadId,
      requesting: true,
      source: "manual",
      reason: "the dev server",
    });
    const flagged = yield* projections.getThreadProjection(threadId);
    assert.equal(flagged.thread.restartRequest?.source, "manual");
    assert.equal(flagged.thread.restartRequest?.reason, "the dev server");
    assert.deepEqual(flagged.thread.updatedAt, before.thread.updatedAt);
    const shell = yield* orchestrator.getThreadShell(threadId);
    assert.equal(shell?.restartRequest?.reason, "the dev server");

    yield* orchestrator.dispatch({
      type: "thread.restart-request.set",
      commandId: CommandId.make("restart-manual-off"),
      threadId,
      requesting: false,
      source: "manual",
    });
    assert.isNull((yield* projections.getThreadProjection(threadId)).thread.restartRequest);
    assert.isNull((yield* orchestrator.getThreadShell(threadId))?.restartRequest ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("clears a pending restart request when the user sends a message", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:restart-user-reply");
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "thread.restart-request.set",
      commandId: CommandId.make("restart-auto-on"),
      threadId,
      requesting: true,
      source: "auto",
      reason: null,
    });
    assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.restartRequest);

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-user-reply"),
      threadId,
      messageId: MessageId.make("restart-user-reply"),
      text: "Restarted it, carry on",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.isNull((yield* projections.getThreadProjection(threadId)).thread.restartRequest);
  }).pipe(Effect.provide(layerTest)),
);

it.live("flags a thread when a finalized run assistant message asks for a restart", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:restart-auto");
    const importedThreadId = ThreadId.make("thread:restart-imported");
    yield* createThread(threadId);
    yield* createThread(importedThreadId);

    const reactor = yield* RestartRequestReactor.make;
    yield* reactor.start();
    // The live tail subscribes from the latest sequence once its fiber runs;
    // let it attach before writing so the events are not behind the cursor.
    yield* Effect.sleep("100 millis");

    yield* eventSink.write({
      events: [
        // Streaming partials and run-less (imported/legacy) history are ignored.
        yield* assistantMessage({
          threadId,
          messageId: "partial",
          text: "Please restart the server so the config loads.",
          streaming: true,
        }),
        yield* assistantMessage({
          threadId: importedThreadId,
          messageId: "imported",
          text: "Please restart the server so the config loads.",
          runId: null,
        }),
        yield* assistantMessage({
          threadId,
          messageId: "unrelated",
          text: "All tests pass; nothing else to do.",
        }),
      ],
    });
    yield* eventSink.write({
      events: [
        yield* assistantMessage({
          threadId,
          messageId: "ask",
          text: "Done. Please restart the server so the new config loads.",
        }),
      ],
    });
    // The live tail is asynchronous; poll the drained worker until the flag lands.
    let shell = yield* orchestrator.getThreadShell(threadId);
    for (let attempt = 0; attempt < 50 && shell?.restartRequest == null; attempt++) {
      yield* Effect.sleep("20 millis");
      yield* reactor.drain;
      shell = yield* orchestrator.getThreadShell(threadId);
    }
    assert.equal(shell?.restartRequest?.source, "auto");
    // The single worker processes in order, so the earlier ignored messages
    // were classified before the ask: the imported thread stays unflagged.
    assert.isNull((yield* orchestrator.getThreadShell(importedThreadId))?.restartRequest ?? null);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerTest, NodeServices.layer))),
);
