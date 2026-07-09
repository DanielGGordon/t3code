/**
 * RestartRequestReactor - Detects "please restart the server/service" asks.
 *
 * Owns a background worker that classifies completed assistant messages and
 * raises a non-blocking restart-requested flag on the originating chat so the
 * sidebar and sibling chats can surface it.
 *
 * @module RestartRequestReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * RestartRequestReactorShape - Service API for restart-request detection.
 */
export interface RestartRequestReactorShape {
  /**
   * Start reacting to completed assistant `thread.message-sent` domain events.
   *
   * The returned effect must be run in a scope so the worker fiber is finalized
   * on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * RestartRequestReactor - Service tag for restart-request detection workers.
 */
export class RestartRequestReactor extends Context.Service<
  RestartRequestReactor,
  RestartRequestReactorShape
>()("t3/orchestration/Services/RestartRequestReactor") {}
