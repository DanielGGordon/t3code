// Fork: end-to-end resume behaviour of threads written by `t3 import sync`.
//
//  1. The first send in an imported thread resumes the native Claude session
//     in place and does NOT also prepend the legacy-import summary handoff
//     (Claude already holds that history).
//  2. `t3 session reset` refuses while the provider session is loaded; once it
//     is released, reset detaches the thread and the next send opens a NEW
//     provider thread (fresh native session) with the thread's history handed
//     over as context.
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  layerImportEnvironment,
  makeTempDir,
  writeTranscript,
} from "../import/ClaudeImport.testkit.ts";
import * as ClaudeResumeBindings from "../import/ClaudeResumeBindings.ts";
import * as ClaudeTranscriptSync from "../import/ClaudeTranscriptSync.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { CLAUDE_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const IMPORTED_SESSION_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

interface CapturedTurn {
  readonly nativeThreadId: string | null;
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadHasTurns: boolean | undefined;
}

/** A Claude adapter that records how each turn was opened and completes it. */
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
                `provider-turn:import-resume:${turnInput.threadId}:${turnInput.runOrdinal}`,
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
          rollbackThread: () => unimplemented("rollbackThread unused"),
          forkThread: () => unimplemented("forkThread unused"),
        };
        return runtime;
      }),
  };
}

describe("Orchestrator with imported Claude threads", () => {
  it.live(
    "resumes the import without a summary handoff; after reset, hands off to a fresh session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("claude-import-resume");
          const projectsDir = makeTempDir("claude-import-resume-projects");
          writeTranscript({
            projectsDir,
            sessionId: IMPORTED_SESSION_ID,
            cwd,
            messages: [
              { uuid: "imp-u1", role: "user", text: "Fix the login bug" },
              { uuid: "imp-a1", role: "assistant", text: "Fixed the login bug." },
            ],
          });
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeCapturingClaudeAdapter({ modelSelection: CLAUDE_MODEL_SELECTION, capturedTurns }),
          ]);
          const layerDatabase = SqlitePersistence.layerMemory;
          const layerHarness = ProviderReplayHarness.layerWithRegistry(
            {
              name: "claude-import-resume",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            layerRegistry,
            { databaseLayer: layerDatabase },
          );
          const layerTest = Layer.mergeAll(
            ClaudeTranscriptSync.layer,
            ClaudeResumeBindings.layer,
          ).pipe(
            Layer.provideMerge(layerHarness),
            Layer.provideMerge(layerDatabase),
            Layer.provideMerge(layerImportEnvironment({ worktreesDir: makeTempDir("worktrees") })),
            Layer.provideMerge(IdAllocator.layer),
          );

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const sync = yield* ClaudeTranscriptSync.ClaudeTranscriptSync;
            const bindings = yield* ClaudeResumeBindings.ClaudeResumeBindings;

            const report = yield* sync.sync({ projectsDir });
            assert.strictEqual(report.counters.created, 1, report.lines.join("\n"));
            const threadId = ThreadId.make(`claude-import-${IMPORTED_SESSION_ID}`);

            const send = (ordinal: number) =>
              Effect.gen(function* () {
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`claude-import-resume:${ordinal}`),
                  threadId,
                  messageId: MessageId.make(`claude-import-resume:${ordinal}`),
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
              });

            yield* send(1);
            const afterFirst = yield* orchestrator.getThreadRecords(threadId, [
              "runs",
              "contextHandoffs",
            ]);
            const run1 = afterFirst.runs.find((run) => run.ordinal === 1)!;
            assert.strictEqual(run1.status, "completed");
            // Native history already contains the import: no summary handoff.
            assert.isNull(run1.contextHandoffId);
            assert.strictEqual(afterFirst.contextHandoffs.length, 0);
            const turns1 = yield* Ref.get(capturedTurns);
            assert.strictEqual(turns1[0]?.nativeThreadId, IMPORTED_SESSION_ID);
            assert.isTrue(turns1[0]?.nativeThreadHasTurns);
            const importedProviderThreadId = turns1[0]!.providerThreadId;

            // While the provider session is loaded its next provider-thread
            // update would re-attach the old session: reset refuses.
            const refused = yield* Effect.flip(bindings.reset({ threadId, apply: true }));
            assert.include(refused.message, "loaded provider session");
            const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const { providerSessions } = yield* orchestrator.getThreadRecords(threadId, [
              "providerSessions",
            ]);
            for (const session of providerSessions) {
              yield* sessions.release({ providerSessionId: session.id, reason: "idle_timeout" });
            }

            const reset = yield* bindings.reset({ threadId, apply: true });
            assert.isTrue(reset.reset, reset.lines.join("\n"));

            yield* send(2);
            const afterSecond = yield* orchestrator.getThreadRecords(threadId, [
              "runs",
              "contextHandoffs",
              "providerThreads",
            ]);
            const run2 = afterSecond.runs.find((run) => run.ordinal === 2)!;
            assert.strictEqual(run2.status, "completed");
            const turns2 = yield* Ref.get(capturedTurns);
            assert.strictEqual(turns2.length, 2);
            // A fresh provider thread / native session, not the imported one.
            assert.notStrictEqual(turns2[1]!.providerThreadId, importedProviderThreadId);
            assert.notStrictEqual(turns2[1]!.nativeThreadId, IMPORTED_SESSION_ID);
            assert.notStrictEqual(turns2[1]!.nativeThreadHasTurns, true);
            assert.strictEqual(
              afterSecond.thread.activeProviderThreadId,
              turns2[1]!.providerThreadId,
            );
            // ... carrying the thread's history as context.
            assert.isNotNull(run2.contextHandoffId);
            const handoff = afterSecond.contextHandoffs.find(
              (candidate) => candidate.id === run2.contextHandoffId,
            );
            assert.include(handoff?.summaryText ?? "", "Fix the login bug");
            assert.include(handoff?.summaryText ?? "", "Continue 1");
          }).pipe(Effect.provide(layerTest));
        }),
      ),
  );
});
