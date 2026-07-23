import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentShellState, ShellSnapshotLoader } from "./shell.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const LIVE_SHELL_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-06-06T00:00:00.000Z",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("environment shell synchronization", () => {
  it.effect("publishes live state before persistence and preserves it when ready", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.never,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      // Cold cache with no HTTP snapshot available → falls back to the
      // socket-embedded snapshot.
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      const state = yield* SubscriptionRef.get(shellState);
      expect(state.status).toBe("live");
      expect(Option.getOrThrow(state.snapshot)).toEqual(LIVE_SHELL_SNAPSHOT);
    }),
  );

  it.effect("resumes a warm shell cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 5,
        projects: [],
        threads: [],
        updatedAt: "2026-06-06T00:00:00.000Z",
      };
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const capturedAfterSequence = yield* SubscriptionRef.make<number | undefined>(undefined);
      const loaderCalls = yield* SubscriptionRef.make(0);
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: { readonly afterSequence?: number }) =>
          Stream.unwrap(
            SubscriptionRef.set(capturedAfterSequence, input.afterSequence).pipe(
              Effect.as(Stream.fromQueue(events)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.some(cachedSnapshot)),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () =>
          SubscriptionRef.update(loaderCalls, (count) => count + 1).pipe(Effect.as(Option.none())),
      });
      yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
      );

      // Wait until the subscription is established from the warm cache.
      yield* SubscriptionRef.changes(capturedAfterSequence).pipe(
        Stream.filter((value) => value !== undefined),
        Stream.runHead,
      );

      expect(yield* SubscriptionRef.get(capturedAfterSequence)).toBe(5);
      expect(yield* SubscriptionRef.get(loaderCalls)).toBe(0);
    }),
  );

  it.effect("retries a failed shell stream and resumes from the latest applied sequence", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 5,
        projects: [],
        threads: [],
        updatedAt: "2026-06-06T00:00:00.000Z",
      };
      // Records the resume cursor the client asks for on each subscribe attempt.
      const attempts = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: { readonly afterSequence?: number }) =>
          Stream.unwrap(
            Ref.updateAndGet(attempts, (seen) => [...seen, input.afterSequence]).pipe(
              Effect.map((seen) =>
                // The first attempt advances the shell to sequence 9 and then
                // fails with a domain (non-transport) error; without a retry the
                // shell would stay on that snapshot for the life of the page.
                seen.length === 1
                  ? Stream.concat(
                      Stream.make({
                        kind: "thread-removed" as const,
                        sequence: 9,
                        threadId: ThreadId.make("thread-1"),
                      }),
                      Stream.fail(new Error("shell stream failed")),
                    )
                  : Stream.never,
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.some(cachedSnapshot)),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });
      yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
      );

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(attempts)).length >= 1) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(attempts)).toEqual([5]);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(attempts)).length >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }

      // Resubscribed (rather than ending the stream), and asked to resume from
      // the sequence it actually reached rather than the boot-time cursor.
      expect(yield* Ref.get(attempts)).toEqual([5, 9]);
    }),
  );
});
