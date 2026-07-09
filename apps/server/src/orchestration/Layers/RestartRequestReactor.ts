import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  RestartRequestReactor,
  type RestartRequestReactorShape,
} from "../Services/RestartRequestReactor.ts";
import { classifyRestartRequest } from "../restartRequestClassifier.ts";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Only completed assistant messages carry a full-text signal worth
 * classifying. Streaming deltas and user messages are ignored.
 */
const isClassifiableAssistantMessage = (event: OrchestrationEvent): event is ThreadMessageSentEvent =>
  event.type === "thread.message-sent" &&
  event.payload.role === "assistant" &&
  event.payload.streaming === false;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const processMessage = Effect.fn("processRestartRequestMessage")(function* (
    event: ThreadMessageSentEvent,
  ) {
    const classification = classifyRestartRequest(event.payload.text);
    if (!classification.matched) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.restart-request.set",
      commandId: yield* serverCommandId("restart-request-detected"),
      threadId: event.payload.threadId,
      requesting: true,
      source: "auto",
      reason: classification.reason,
      createdAt: yield* nowIso,
    });
  });

  const processMessageSafely = (event: ThreadMessageSentEvent) =>
    processMessage(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("restart request reactor failed to process message", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processMessageSafely);

  const start: RestartRequestReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!isClassifiableAssistantMessage(event)) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies RestartRequestReactorShape;
});

export const RestartRequestReactorLive = Layer.effect(RestartRequestReactor, make);
