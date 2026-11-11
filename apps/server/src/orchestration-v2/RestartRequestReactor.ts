/**
 * Fork: raises the "agent asked for a server restart" flag on a thread when a finalized assistant
 * message belonging to a run (imported/legacy history has `runId: null`) matches the classifier,
 * unless a request is already pending. Cleared by the next user message or from the UI.
 * @module RestartRequestReactor
 */
import {
  CommandId,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { classifyRestartRequest } from "./restartRequestClassifier.ts";

/** Finalized assistant messages are re-emitted on later updates; remember a bounded window. */
const SEEN_MESSAGE_LIMIT = 2_048;

export class RestartRequestReactor extends Context.Service<
  RestartRequestReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves when every enqueued message has been classified (tests). */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/RestartRequestReactor") {}

/** Only completed assistant messages produced by a run carry a classifiable signal. */
export const isClassifiableAssistantMessage = (
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { readonly type: "message.updated" }> =>
  event.type === "message.updated" &&
  event.payload.role === "assistant" &&
  event.payload.streaming === false &&
  event.payload.runId !== null;

/** @public */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;

  const seen = new Set<MessageId>();
  const markSeen = (messageId: MessageId): boolean => {
    if (seen.has(messageId)) return false;
    seen.add(messageId);
    if (seen.size > SEEN_MESSAGE_LIMIT) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  };

  const processMessage = Effect.fn("RestartRequestReactor.processMessage")(function* (
    message: OrchestrationV2ConversationMessage,
  ) {
    const classification = classifyRestartRequest(message.text);
    if (!classification.matched) return;
    const shell = yield* orchestrator.getThreadShell(message.threadId);
    if (shell === null || shell.restartRequest != null || shell.archivedAt !== null) return;
    const uuid = yield* random.uuidV4();
    yield* orchestrator.dispatch({
      type: "thread.restart-request.set",
      commandId: CommandId.make(`server:restart-request-detected:${uuid}`),
      threadId: message.threadId,
      requesting: true,
      source: "auto",
      reason: classification.reason,
    });
  });

  const processMessageSafely = (message: OrchestrationV2ConversationMessage) =>
    processMessage(message).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("restart request reactor failed to process message", {
            threadId: message.threadId,
            messageId: message.id,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(processMessageSafely);

  const start: RestartRequestReactor["Service"]["start"] = Effect.fn("RestartRequestReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          isClassifiableAssistantMessage(event) && markSeen(event.payload.id)
            ? worker.enqueue(event.payload)
            : Effect.void,
        ).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("restart request reactor event stream failed", {
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      );
    },
  );

  return RestartRequestReactor.of({ start, drain: worker.drain });
});

export const layer = Layer.effect(RestartRequestReactor, make);

/** Starts the reactor for the server runtime. */
export const layerStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* RestartRequestReactor;
    yield* reactor.start();
  }),
).pipe(Layer.provideMerge(layer));
