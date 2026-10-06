// Fork: imported native history must be resumed, not re-created.
//
// A provider thread written by an importer (upstream's AgentSessionImporter,
// the fork's `t3 import sync`, or the legacy v1 resume seeder) carries the
// native Claude session id as a strong `nativeThreadRef` but has no T3 turns.
// The first send in such a thread must open the native session with `resume:`
// — `sessionId:` would fail with "already in use" (or silently fork history).
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { providerThreadHasImportedNativeHistory } from "./ProviderTurnStartService.ts";
import { CLAUDE_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const IMPORTED_SESSION_ID = "9b0c7d52-5a35-4f1e-9a0c-3f7f1f0c2a11";

interface CapturedTurn {
  readonly nativeThreadId: string | null;
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadHasTurns: boolean | undefined;
}

function makeCapturingClaudeAdapter(input: {
  readonly modelSelection: ModelSelection;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
}): ProviderAdapterV2Shape {
  const unimplemented = (detail: string) =>
    Effect.fail(new ProviderAdapterProtocolError({ driver: CLAUDE_DRIVER, detail }));
  return {
    instanceId: input.modelSelection.instanceId,
    driver: CLAUDE_DRIVER,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: CLAUDE_DRIVER,
          providerInstanceId: input.modelSelection.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: ClaudeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: input.modelSelection.instanceId,
          driver: CLAUDE_DRIVER,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `fresh:${threadInput.threadId}`;
              return {
                id:
                  threadInput.existingProviderThread?.id ??
                  ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: CLAUDE_DRIVER,
                providerInstanceId: input.modelSelection.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: CLAUDE_DRIVER,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  providerThreadId: turnInput.providerThread.id,
                  nativeThreadHasTurns: turnInput.nativeThreadHasTurns,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:imported:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerEvents: ReadonlyArray<ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: CLAUDE_DRIVER,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: CLAUDE_DRIVER,
                      nativeId: `native-turn:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: CLAUDE_DRIVER,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:imported:${turnInput.runOrdinal}:assistant`),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(`message:imported:${turnInput.runOrdinal}:assistant`),
                    text: `response ${turnInput.runOrdinal}`,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: CLAUDE_DRIVER,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ];
              for (const event of providerEvents) {
                yield* PubSub.publish(events, event);
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused"),
          // Mirrors ClaudeAdapterV2: a rollback to thread start allocates a
          // fresh, never-created native session id.
          rollbackThread: (rollbackInput) =>
            rollbackInput.target.type !== "thread_start"
              ? unimplemented("only thread_start rollback is modeled")
              : Effect.gen(function* () {
                  const now = yield* DateTime.now;
                  const nativeThreadId = `rolled-back:${rollbackInput.providerThread.appThreadId}`;
                  return {
                    providerThread: {
                      ...rollbackInput.providerThread,
                      id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                      providerSessionId: sessionInput.providerSessionId,
                      nativeThreadRef: {
                        driver: CLAUDE_DRIVER,
                        nativeId: nativeThreadId,
                        strength: "strong",
                      },
                      nativeConversationHeadRef: null,
                      status: "idle",
                      firstRunOrdinal: null,
                      lastRunOrdinal: null,
                      nativeMetadata: null,
                      createdAt: now,
                      updatedAt: now,
                    },
                    providerTurns: [],
                    messages: [],
                    runtimeRequests: [],
                  };
                }),
          forkThread: () => unimplemented("forkThread unused"),
        };
        return runtime;
      }),
  };
}

describe("ProviderTurnStartService imported native history", () => {
  it("classifies only importer-written provider threads as imported native history", () => {
    const base = {
      id: ProviderThreadId.make("provider-thread:classify"),
      driver: CLAUDE_DRIVER,
      nativeThreadRef: { driver: CLAUDE_DRIVER, nativeId: IMPORTED_SESSION_ID, strength: "strong" },
      firstRunOrdinal: null,
      nativeMetadata: { importedNativeHistory: true },
    } as unknown as OrchestrationV2ProviderThread;
    assert.isTrue(providerThreadHasImportedNativeHistory(base));
    // Adapters mint the same shape for brand-new native threads (e.g. Claude's
    // rollback to thread start): without the importer marker it is not history.
    assert.isFalse(providerThreadHasImportedNativeHistory({ ...base, nativeMetadata: null }));
    assert.isFalse(providerThreadHasImportedNativeHistory({ ...base, nativeMetadata: {} }));
    // T3 has already run a turn on it: the attempt history decides instead.
    assert.isFalse(providerThreadHasImportedNativeHistory({ ...base, firstRunOrdinal: 1 }));
    assert.isFalse(providerThreadHasImportedNativeHistory({ ...base, nativeThreadRef: null }));
    assert.isFalse(
      providerThreadHasImportedNativeHistory({
        ...base,
        nativeThreadRef: { driver: CLAUDE_DRIVER, nativeId: IMPORTED_SESSION_ID, strength: "weak" },
      }),
    );
  });

  it.live("resumes the imported native session on the first T3 turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("imported-native-resume");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeCapturingClaudeAdapter({ modelSelection: CLAUDE_MODEL_SELECTION, capturedTurns }),
        ]);
        const threadId = ThreadId.make("claude-import-imported-native-resume");
        const projectId = ProjectId.make("project:imported-native-resume");

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;

          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("imported-native-resume:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Imported Claude session",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          // Turn it into the importer's shape: v1_import history plus a provider
          // thread bound to the existing native Claude session (no T3 turns).
          const created = (yield* orchestrator.getThreadProjection(threadId)).thread;
          const providerThreadId = idAllocator.derive.providerThread({
            driver: CLAUDE_DRIVER,
            nativeThreadId: IMPORTED_SESSION_ID,
          });
          const importedProviderThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver: CLAUDE_DRIVER,
            providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CLAUDE_DRIVER,
              nativeId: IMPORTED_SESSION_ID,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            nativeMetadata: { importedNativeHistory: true },
            createdAt: created.createdAt,
            updatedAt: created.createdAt,
          };
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("imported-native-resume:provider-thread"),
                type: "provider-thread.updated",
                threadId,
                driver: CLAUDE_DRIVER,
                providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
                occurredAt: created.createdAt,
                payload: importedProviderThread,
              },
              {
                id: EventId.make("imported-native-resume:thread"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: created.createdAt,
                payload: {
                  ...created,
                  historyOrigin: "v1_import",
                  activeProviderThreadId: providerThreadId,
                },
              },
            ],
          });

          for (const ordinal of [1, 2]) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`imported-native-resume:${ordinal}`),
              threadId,
              messageId: MessageId.make(`imported-native-resume:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: `Continue ${ordinal}`,
              attachments: [],
              modelSelection: CLAUDE_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            });
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
          }

          const turns = yield* Ref.get(capturedTurns);
          assert.equal(turns.length, 2);
          assert.equal(turns[0]?.providerThreadId, providerThreadId);
          assert.equal(turns[0]?.nativeThreadId, IMPORTED_SESSION_ID);
          // The native session already has history: Claude must resume it.
          assert.isTrue(turns[0]?.nativeThreadHasTurns);
          assert.equal(turns[1]?.nativeThreadId, IMPORTED_SESSION_ID);
          assert.isTrue(turns[1]?.nativeThreadHasTurns);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "imported-native-resume",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              layerRegistry,
            ),
          ),
          Effect.provide(IdAllocator.layer),
        );
      }),
    ),
  );
  it.live("starts the fresh native session minted by a rollback to thread start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("rollback-start-fresh-session");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeCapturingClaudeAdapter({ modelSelection: CLAUDE_MODEL_SELECTION, capturedTurns }),
        ]);
        const threadId = ThreadId.make("rollback-start-fresh-session");
        const projectId = ProjectId.make("project:rollback-start-fresh-session");

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

          const sendAndSettle = (ordinal: number) =>
            Effect.gen(function* () {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`rollback-start-fresh-session:${ordinal}`),
                threadId,
                messageId: MessageId.make(`rollback-start-fresh-session:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text: `Message ${ordinal}`,
                attachments: [],
                modelSelection: CLAUDE_MODEL_SELECTION,
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
            });

          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("rollback-start-fresh-session:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Ordinary thread",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* sendAndSettle(1);

          const afterFirst = yield* orchestrator.getThreadProjection(threadId);
          const startCheckpoint = afterFirst.checkpoints.find(
            (checkpoint) => (checkpoint.appRunOrdinal ?? 0) === 0 && checkpoint.status === "ready",
          );
          assert.isDefined(startCheckpoint, "the thread-start checkpoint is captured");
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("rollback-start-fresh-session:rollback"),
            threadId,
            checkpointId: startCheckpoint!.id,
            scopeId: startCheckpoint!.scopeId,
            restoreFiles: false,
          });
          // The rollback effect runs on the background worker.
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                (event.type === "provider-thread.updated" &&
                  event.payload.nativeThreadRef?.nativeId === `rolled-back:${threadId}`) ||
                (event.type === "thread.metadata-updated" &&
                  event.payload.rollbackFailure !== null &&
                  event.payload.rollbackFailure !== undefined),
            ),
            Stream.runHead,
            Effect.timeout("10 seconds"),
          );
          yield* worker.drain();

          const afterRollback = yield* orchestrator.getThreadProjection(threadId);
          const minted = afterRollback.providerThreads.find(
            (candidate) => candidate.id === afterRollback.thread.activeProviderThreadId,
          );
          assert.equal(
            minted?.nativeThreadRef?.nativeId,
            `rolled-back:${threadId}`,
            afterRollback.thread.rollbackFailure?.message,
          );

          yield* sendAndSettle(2);

          const turns = yield* Ref.get(capturedTurns);
          assert.equal(turns.length, 2);
          assert.equal(turns[1]?.nativeThreadId, `rolled-back:${threadId}`);
          // The rollback minted a never-created native session: it must be
          // opened fresh (`sessionId:`), not resumed ("No conversation found").
          assert.isFalse(turns[1]?.nativeThreadHasTurns);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "rollback-start-fresh-session",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              layerRegistry,
            ),
          ),
          Effect.provide(IdAllocator.layer),
        );
      }),
    ),
  );
});
