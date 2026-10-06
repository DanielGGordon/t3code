import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { voiceTranscriptionRouteLayer } from "./http.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

// Fork: moved from the deleted v1 `server.test.ts` (voice transcription, #58).

const OPERATE_TOKEN = "operate-token";
const READ_ONLY_TOKEN = "read-only-token";

/**
 * Bearer `operate-token` = operate scope, `read-only-token` = read scope, else
 * 401. Only `authenticateHttpRequest` is reachable from the raw route.
 */
const authenticateHttpRequest: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"] =
  (request) => {
    const authorization = request.headers["authorization"] ?? "";
    const scopes =
      authorization === `Bearer ${OPERATE_TOKEN}`
        ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
        : authorization === `Bearer ${READ_ONLY_TOKEN}`
          ? [AuthOrchestrationReadScope]
          : null;
    return scopes === null
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-voice-test"),
          subject: "voice-test",
          method: "bearer-access-token" as const,
          scopes,
        });
  };
const auth = { authenticateHttpRequest } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const makeHandler = () =>
  HttpRouter.toWebHandler(voiceTranscriptionRouteLayer.pipe(Layer.provide(NodeServices.layer)), {
    disableLogger: true,
  });

const post = (body: Uint8Array, contentType: string, token?: string) =>
  new Request("http://127.0.0.1/api/voice/transcribe", {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body,
  });

const run = (
  transcribe: VoiceTranscription.VoiceTranscription["Service"]["transcribe"],
  request: Request,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeHandler),
    ({ handler }) =>
      Effect.promise(() =>
        handler(
          request,
          Context.make(EnvironmentAuth.EnvironmentAuth, auth).pipe(
            Context.add(
              VoiceTranscription.VoiceTranscription,
              VoiceTranscription.VoiceTranscription.of({ transcribe }),
            ),
          ),
        ),
      ),
    ({ dispose }) => Effect.promise(() => dispose()),
  );

it.effect("transcribes voice recordings for authenticated sessions", () =>
  Effect.gen(function* () {
    const received: Array<{ bytes: number; mimeType: string }> = [];
    const response = yield* run(
      (input) =>
        Effect.sync(() => {
          received.push({ bytes: input.audio.byteLength, mimeType: input.mimeType });
          return "run the tests please";
        }),
      post(new Uint8Array([1, 2, 3, 4]), "audio/webm;codecs=opus", OPERATE_TOKEN),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ text: "run the tests please" });
    expect(received).toEqual([{ bytes: 4, mimeType: "audio/webm;codecs=opus" }]);
  }),
);

it.effect("rejects unauthenticated voice transcription requests", () =>
  Effect.gen(function* () {
    let called = false;
    const response = yield* run(
      () =>
        Effect.sync(() => {
          called = true;
          return "";
        }),
      post(new Uint8Array([1, 2, 3]), "audio/webm"),
    );
    expect(response.status).toBe(401);
    expect(called).toBe(false);
  }),
);

it.effect("requires the operate scope", () =>
  Effect.gen(function* () {
    let called = false;
    const response = yield* run(
      () =>
        Effect.sync(() => {
          called = true;
          return "";
        }),
      post(new Uint8Array([1, 2, 3]), "audio/webm", READ_ONLY_TOKEN),
    );
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  }),
);

it.effect("maps voice transcription failures to a typed error response", () =>
  Effect.gen(function* () {
    const response = yield* run(
      () =>
        Effect.fail(
          new VoiceTranscription.VoiceTranscriptionError({
            reason: "not_configured",
            message: "no key",
          }),
        ),
      post(new Uint8Array([1]), "audio/mp4", OPERATE_TOKEN),
    );
    expect(response.status).toBe(503);
    expect(yield* Effect.promise(() => response.json())).toEqual({
      reason: "not_configured",
      message: "no key",
    });
  }),
);
