// Fork (F7 thread spend): finished provider turns without an adapter-reported
// cost are priced by TurnCostEstimator during ingestion.
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnCostEstimator from "../usage/TurnCostEstimator.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);
const layerEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStores, SqlitePersistence.layerMemory)),
);
const layerIngestor = (estimator: TurnCostEstimator.TurnCostEstimatorShape) =>
  Layer.mergeAll(
    IdAllocator.layer,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerStores,
          layerEventSink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          Layer.succeed(TurnCostEstimator.TurnCostEstimator, estimator),
        ),
      ),
    ),
  );

const normalizeTurn = (turnTokenUsage: TurnTokenUsage, status: "completed" | "running") =>
  Effect.gen(function* () {
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: idAllocator.derive.providerTurn({ driver: CODEX_DRIVER, nativeTurnId: "cost-turn" }),
      providerThreadId: idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "cost-thread",
      }),
      nodeId: NodeId.make("node:cost-turn"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      turnTokenUsage,
    };
    const events = yield* ingestor.normalize({
      providerSessionId: ProviderSessionId.make("provider-session:cost"),
      providerInstanceId: modelSelection.instanceId,
      threadId: ThreadId.make("thread:cost"),
      analyticsContext: { modelSelection },
      event: { type: "provider_turn.updated", driver: CODEX_DRIVER, providerTurn },
    });
    const event = events.find((candidate) => candidate.type === "provider-turn.updated");
    return event?.type === "provider-turn.updated" ? event.payload.turnTokenUsage : undefined;
  });

const usage: TurnTokenUsage = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: 40,
  cachedInputTokens: 30,
  outputTokens: 10,
};

it.effect("prices a finished turn that arrived without a cost", () => {
  const seen: Array<TurnCostEstimator.TurnCostEstimateInput> = [];
  return Effect.gen(function* () {
    const priced = yield* normalizeTurn(usage, "completed");
    assert.deepEqual(priced, { ...usage, costUsd: 0.125 });
    assert.equal(seen[0]?.modelSelection.model, "gpt-5.4");
    assert.equal(seen[0]?.driver, CODEX_DRIVER);
  }).pipe(
    Effect.provide(
      layerIngestor({
        estimate: (input) =>
          Effect.sync(() => {
            seen.push(input);
            return { costUsd: 0.125, incomplete: false };
          }),
      }),
    ),
  );
});

it.effect("keeps adapter-reported cost and skips unfinished turns", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const reported = yield* normalizeTurn({ ...usage, costUsd: 2 }, "completed");
    assert.equal(reported?.costUsd, 2);
    const running = yield* normalizeTurn(usage, "running");
    assert.isUndefined(running?.costUsd);
    assert.equal(calls, 0);
  }).pipe(
    Effect.provide(
      layerIngestor({
        estimate: () =>
          Effect.sync(() => {
            calls += 1;
            return { costUsd: 1, incomplete: false };
          }),
      }),
    ),
  );
});

it.effect("flags a turn whose model has no rate", () =>
  Effect.gen(function* () {
    const priced = yield* normalizeTurn(usage, "completed");
    assert.deepEqual(priced, { ...usage, costUsdIncomplete: true });
  }).pipe(
    Effect.provide(
      layerIngestor({
        estimate: () => Effect.succeed({ costUsd: undefined, incomplete: true }),
      }),
    ),
  ),
);

it.effect("leaves turns untouched with the default (no-op) estimator", () =>
  Effect.gen(function* () {
    const priced = yield* normalizeTurn(usage, "completed");
    assert.deepEqual(priced, usage);
  }).pipe(Effect.provide(layerIngestor({ estimate: () => Effect.succeed(undefined) }))),
);
