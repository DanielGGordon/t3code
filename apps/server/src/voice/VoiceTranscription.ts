/**
 * Speech-to-text for the composer's voice input.
 *
 * The browser records a clip and the `/api/voice/transcribe` route hands its
 * bytes here; we forward them to OpenAI's transcription endpoint and return
 * the text. The API key comes from the server secret store
 * (`secrets/voice-transcription-openai-api-key.bin`, re-read on every request
 * so it can be set without a restart) and falls back to `OPENAI_API_KEY`.
 */
import {
  type VoiceTranscriptionFailureReason,
  VoiceTranscriptionFailureReason as VoiceTranscriptionFailureReasonSchema,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const VOICE_TRANSCRIPTION_API_KEY_SECRET = "voice-transcription-openai-api-key";
export const DEFAULT_VOICE_TRANSCRIPTION_MODEL = "gpt-transcribe";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT = Duration.seconds(90);

const VoiceTranscriptionEnvConfig = Config.all({
  apiKey: Config.redacted("OPENAI_API_KEY").pipe(Config.option),
  model: Config.string("T3CODE_VOICE_TRANSCRIPTION_MODEL").pipe(
    Config.withDefault(DEFAULT_VOICE_TRANSCRIPTION_MODEL),
  ),
});

export class VoiceTranscriptionError extends Schema.TaggedErrorClass<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    reason: VoiceTranscriptionFailureReasonSchema,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const OpenAiTranscriptionResponse = Schema.Struct({ text: Schema.String });

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly transcribe: (input: {
      readonly audio: Uint8Array;
      readonly mimeType: string;
    }) => Effect.Effect<string, VoiceTranscriptionError>;
  }
>()("t3/voice/VoiceTranscription") {}

/**
 * The transcription API infers the container from the upload's file name, so
 * map the recorder's MIME type (`audio/webm;codecs=opus`, `audio/mp4`, …) to
 * an extension it accepts.
 */
export function transcriptionFileNameForMimeType(mimeType: string): string {
  const essence = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (essence) {
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return "speech.mp4";
    case "audio/ogg":
      return "speech.ogg";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "speech.wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "speech.mp3";
    default:
      return "speech.webm";
  }
}

const fail = (reason: VoiceTranscriptionFailureReason, message: string, cause?: unknown) =>
  new VoiceTranscriptionError({ reason, message, ...(cause === undefined ? {} : { cause }) });

export const make = Effect.gen(function* () {
  const envConfig = yield* VoiceTranscriptionEnvConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const textDecoder = new TextDecoder();

  const resolveApiKey = secretStore.get(VOICE_TRANSCRIPTION_API_KEY_SECRET).pipe(
    Effect.map((stored) =>
      Option.isSome(stored) ? textDecoder.decode(stored.value).trim() : undefined,
    ),
    Effect.catch((cause) =>
      Effect.logWarning("failed to read the voice transcription API key secret", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
    Effect.map((stored) => {
      if (stored) return stored;
      const fromEnv = Option.map(envConfig.apiKey, Redacted.value);
      return Option.isSome(fromEnv) && fromEnv.value.trim() ? fromEnv.value.trim() : undefined;
    }),
  );

  const transcribe = Effect.fn("VoiceTranscription.transcribe")(function* (input: {
    readonly audio: Uint8Array;
    readonly mimeType: string;
  }) {
    if (input.audio.byteLength === 0) {
      return yield* fail("empty_audio", "The recording was empty.");
    }
    const apiKey = yield* resolveApiKey;
    if (!apiKey) {
      return yield* fail(
        "not_configured",
        "Voice input is not configured on this server: add an OpenAI API key to " +
          `secrets/${VOICE_TRANSCRIPTION_API_KEY_SECRET}.bin or set OPENAI_API_KEY.`,
      );
    }

    const form = new FormData();
    form.append("model", envConfig.model);
    form.append("response_format", "json");
    form.append(
      "file",
      new Blob([input.audio], { type: input.mimeType }),
      transcriptionFileNameForMimeType(input.mimeType),
    );

    const request = HttpClientRequest.post(OPENAI_TRANSCRIPTIONS_URL).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyFormData(form),
    );

    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(TRANSCRIPTION_TIMEOUT),
      Effect.mapError((cause) =>
        fail("upstream_error", "Could not reach the transcription service.", cause),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      yield* Effect.logWarning("voice transcription request failed", {
        status: response.status,
        body: body.slice(0, 500),
      });
      return yield* fail(
        "upstream_error",
        `The transcription service answered HTTP ${response.status}.`,
      );
    }
    const decoded = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OpenAiTranscriptionResponse)),
      Effect.mapError((cause) =>
        fail("upstream_error", "The transcription service sent an unexpected response.", cause),
      ),
    );
    return decoded.text.trim();
  });

  return VoiceTranscription.of({ transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
