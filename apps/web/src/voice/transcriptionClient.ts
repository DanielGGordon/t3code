import {
  VOICE_TRANSCRIPTION_CONTEXT_PARAM,
  VOICE_TRANSCRIPTION_ROUTE_PATH,
  VoiceTranscriptionFailure,
  VoiceTranscriptionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as PrimaryEnvironmentHttp from "../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

/** A transcription request that failed; `message` is safe to show the user. `retryable` says the same audio may work on a retry. */
export class VoiceTranscriptionRequestError extends Schema.TaggedError<VoiceTranscriptionRequestError>()(
  "VoiceTranscriptionRequestError",
  { message: Schema.String, retryable: Schema.Boolean },
) {}

const DEFAULT_RECORDING_MIME_TYPE = "audio/webm";
const decodeResult = Schema.decodeUnknownOption(VoiceTranscriptionResult);
const decodeFailure = Schema.decodeUnknownOption(VoiceTranscriptionFailure);

/** Resolve a non-2xx (or malformed) answer into a user-facing message. */
export function describeVoiceTranscriptionFailure(status: number, body: unknown): string {
  const failure = decodeFailure(body);
  if (Option.isSome(failure)) return failure.value.message;
  if (status === 401 || status === 403) return "Your session expired; sign in again.";
  return `Transcription failed (HTTP ${status}).`;
}

/** Whether the same request is worth repeating: a network error, or an answer that says "busy". */
export function isRetryableVoiceTranscriptionFailure(status: number, body: unknown): boolean {
  const failure = decodeFailure(body);
  if (Option.isSome(failure)) return failure.value.reason === "upstream_error";
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Upload a recording to the primary environment's `/api/fork/voice/transcribe`
 * and return the transcript. Auth comes from the shared primary-environment
 * HTTP layer. `context` is the text already transcribed from the same recording.
 */
export function transcribeVoiceRecording(
  recording: Blob,
  options: { readonly context?: string } = {},
): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const bytes = new Uint8Array(yield* Effect.promise(() => recording.arrayBuffer()));
      const request = HttpClientRequest.post(
        resolvePrimaryEnvironmentHttpUrl(
          VOICE_TRANSCRIPTION_ROUTE_PATH,
          options.context ? { [VOICE_TRANSCRIPTION_CONTEXT_PARAM]: options.context } : undefined,
        ),
      ).pipe(
        HttpClientRequest.bodyUint8Array(bytes, recording.type || DEFAULT_RECORDING_MIME_TYPE),
      );
      const response = yield* client.execute(request).pipe(
        Effect.mapError(
          () =>
            new VoiceTranscriptionRequestError({
              message: "Could not reach the server to transcribe.",
              retryable: true,
            }),
        ),
      );
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      const result = response.status === 200 ? decodeResult(body) : Option.none();
      if (Option.isSome(result)) return result.value.text;
      return yield* new VoiceTranscriptionRequestError({
        message: describeVoiceTranscriptionFailure(response.status, body),
        retryable: isRetryableVoiceTranscriptionFailure(response.status, body),
      });
    }).pipe(Effect.provide(PrimaryEnvironmentHttp.layer)),
  );
}
