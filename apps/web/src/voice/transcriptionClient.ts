import {
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

/** A transcription request that failed; `message` is safe to show the user. */
export class VoiceTranscriptionRequestError extends Error {
  override readonly name = "VoiceTranscriptionRequestError";
}

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

/**
 * Upload a recording to the primary environment's `/api/voice/transcribe`
 * and return the transcript. Auth (cookie in the browser, bearer token in the
 * desktop app) comes from the shared primary-environment HTTP layer.
 */
export function transcribeVoiceRecording(recording: Blob): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const bytes = new Uint8Array(yield* Effect.promise(() => recording.arrayBuffer()));
      const request = HttpClientRequest.post(
        resolvePrimaryEnvironmentHttpUrl(VOICE_TRANSCRIPTION_ROUTE_PATH),
      ).pipe(
        HttpClientRequest.bodyUint8Array(bytes, recording.type || DEFAULT_RECORDING_MIME_TYPE),
      );
      const response = yield* client
        .execute(request)
        .pipe(
          Effect.mapError(
            () => new VoiceTranscriptionRequestError("Could not reach the server to transcribe."),
          ),
        );
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      const result = response.status === 200 ? decodeResult(body) : Option.none();
      if (Option.isSome(result)) return result.value.text;
      return yield* Effect.fail(
        new VoiceTranscriptionRequestError(
          describeVoiceTranscriptionFailure(response.status, body),
        ),
      );
    }).pipe(Effect.provide(PrimaryEnvironmentHttp.layer)),
  );
}
