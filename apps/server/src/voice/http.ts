import {
  AuthOrchestrationOperateScope,
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_ROUTE_PATH,
  type VoiceTranscriptionFailure,
  type VoiceTranscriptionFailureReason,
  type VoiceTranscriptionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const FAILURE_STATUS: Record<VoiceTranscriptionFailureReason, number> = {
  not_configured: 503,
  empty_audio: 400,
  audio_too_large: 413,
  upstream_error: 502,
};

const failureResponse = (reason: VoiceTranscriptionFailureReason, message: string) =>
  HttpServerResponse.jsonUnsafe({ reason, message } satisfies VoiceTranscriptionFailure, {
    status: FAILURE_STATUS[reason],
  });

/**
 * `POST /api/voice/transcribe` — body is the raw recording, `Content-Type` its
 * MIME type. Same auth as the other raw routes (an operate-scoped session).
 */
export const voiceTranscriptionRouteLayer = HttpRouter.add(
  "POST",
  VOICE_TRANSCRIPTION_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const voiceTranscription = yield* VoiceTranscription.VoiceTranscription;

    const declaredLength = Number(request.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > VOICE_TRANSCRIPTION_MAX_BYTES) {
      return failureResponse("audio_too_large", "The recording is too long to transcribe.");
    }
    const mimeType = request.headers["content-type"]?.trim() || "audio/webm";

    const body = yield* request.arrayBuffer.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        FileSystem.Size(VOICE_TRANSCRIPTION_MAX_BYTES),
      ),
      Effect.option,
    );
    if (body._tag === "None") {
      return failureResponse(
        "audio_too_large",
        "The recording could not be read; it may be too long to transcribe.",
      );
    }

    return yield* voiceTranscription
      .transcribe({ audio: new Uint8Array(body.value), mimeType })
      .pipe(
        Effect.map((text) =>
          HttpServerResponse.jsonUnsafe({ text } satisfies VoiceTranscriptionResult),
        ),
        Effect.catchTag("VoiceTranscriptionError", (error) =>
          Effect.succeed(failureResponse(error.reason, error.message)),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
