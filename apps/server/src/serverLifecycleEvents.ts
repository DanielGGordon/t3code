import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "legacyThreadMigration" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "notice" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

/**
 * How long a late subscriber still sees an operator notice. Every other
 * lifecycle event describes the running server, so replaying it forever is
 * right; a notice ("restarted to deploy") would otherwise greet every page
 * load until the next restart.
 */
export const NOTICE_REPLAY_WINDOW_MS = 2 * 60_000;

export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  {
    readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
    readonly snapshot: Effect.Effect<SnapshotState>;
    readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
  }
>()("t3/serverLifecycleEvents") {}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
  const state = yield* Ref.make<SnapshotState>({
    sequence: 0,
    events: [],
  });
  const noticePublishedAtMs = yield* Ref.make<number | null>(null);

  return {
    publish: (event) =>
      (event.type === "notice"
        ? Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(noticePublishedAtMs, now)))
        : Effect.void
      ).pipe(
        Effect.andThen(
          Ref.modify(state, (current) => {
            const nextSequence = current.sequence + 1;
            const nextEvent = {
              ...event,
              sequence: nextSequence,
            } satisfies ServerLifecycleStreamEvent;
            const nextEvents = [
              nextEvent,
              ...current.events.filter((entry) => entry.type !== nextEvent.type),
            ];
            return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
          }),
        ),
        Effect.tap((event) => PubSub.publish(pubsub, event)),
      ),
    snapshot: Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const publishedAt = yield* Ref.get(noticePublishedAtMs);
      if (publishedAt === null) return current;
      const now = yield* Clock.currentTimeMillis;
      return now - publishedAt <= NOTICE_REPLAY_WINDOW_MS
        ? current
        : { ...current, events: current.events.filter((entry) => entry.type !== "notice") };
    }),
    get stream() {
      return Stream.fromPubSub(pubsub);
    },
  } satisfies ServerLifecycleEvents["Service"];
});

export const layer = Layer.effect(ServerLifecycleEvents, make);
