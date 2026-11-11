/**
 * Speech-to-text for the composer's voice input: forwards the clip to an OpenAI-compatible endpoint.
 * `T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL` (self-hosted Whisper) is tried first, OpenAI is the fallback;
 * the key is re-read on every request. `T3CODE_VOICE_TRANSCRIPTION_PROMPT` goes to both as Whisper's
 * `prompt` hint, followed by any text already transcribed from the same recording.
 */
import {
  VOICE_TRANSCRIPTION_CONTEXT_MAX_CHARS,
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
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const VOICE_TRANSCRIPTION_API_KEY_SECRET = "voice-transcription-openai-api-key";
export const DEFAULT_VOICE_TRANSCRIPTION_MODEL = "gpt-transcribe";
// Not a distil-whisper model: those drop the tail of recordings longer than ~30s.
export const DEFAULT_LOCAL_VOICE_TRANSCRIPTION_MODEL = "Systran/faster-whisper-medium.en";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT = Duration.seconds(90);
// Bounded tighter than OpenAI so a wedged local server still leaves time for the fallback.
const LOCAL_TRANSCRIPTION_TIMEOUT = Duration.seconds(60);

const VoiceTranscriptionEnvConfig = Config.all({
  apiKey: Config.Redacted("OPENAI_API_KEY").pipe(Config.option),
  model: Config.String("T3CODE_VOICE_TRANSCRIPTION_MODEL").pipe(
    Config.withDefault(DEFAULT_VOICE_TRANSCRIPTION_MODEL),
  ),
  localUrl: Config.String("T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL").pipe(Config.option),
  localModel: Config.String("T3CODE_VOICE_TRANSCRIPTION_LOCAL_MODEL").pipe(
    Config.withDefault(DEFAULT_LOCAL_VOICE_TRANSCRIPTION_MODEL),
  ),
  prompt: Config.String("T3CODE_VOICE_TRANSCRIPTION_PROMPT").pipe(Config.option),
});

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    reason: VoiceTranscriptionFailureReasonSchema,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const OpenAiTranscriptionResponse = Schema.Struct({ text: Schema.String });

const OpenAiErrorBody = Schema.Struct({
  error: Schema.Struct({
    type: Schema.optional(Schema.NullOr(Schema.String)),
    code: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const decodeOpenAiErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(OpenAiErrorBody));

/**
 * Explains an upstream rejection. A 429 from OpenAI is usually not a burst
 * limit but an exhausted quota or spend limit, which only billing can fix, so
 * name it instead of surfacing a bare status code.
 */
export function describeUpstreamFailure(status: number, body: string): string {
  const error = Option.getOrUndefined(decodeOpenAiErrorBody(body))?.error;
  if (
    error?.type === "insufficient_quota" ||
    error?.code === "insufficient_quota" ||
    error?.code === "organization_spend_limit_exceeded"
  ) {
    return "OpenAI's quota or spend limit is used up; add credits or raise the limit at https://platform.openai.com/settings/organization/limits.";
  }
  if (status === 429) {
    return "The transcription service is rate limiting requests (HTTP 429); try again shortly.";
  }
  return `The transcription service answered HTTP ${status}.`;
}

/**
 * The text already transcribed from the same recording, made safe to put in Whisper's prompt:
 * control characters become spaces, whitespace collapses, and only the last
 * `VOICE_TRANSCRIPTION_CONTEXT_MAX_CHARS` characters are kept (from a whole word). Undefined when
 * nothing is left.
 */
export function normalizeTranscriptionContext(raw: string | undefined): string | undefined {
  let text = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > VOICE_TRANSCRIPTION_CONTEXT_MAX_CHARS) {
    text = text.slice(-VOICE_TRANSCRIPTION_CONTEXT_MAX_CHARS);
    const firstSpace = text.indexOf(" ");
    text = firstSpace === -1 ? text : text.slice(firstSpace + 1);
  }
  return text.length > 0 ? text : undefined;
}

/** The configured vocabulary hint followed by the recording's text so far, the way Whisper reads a transcript. */
function composeTranscriptionPrompt(
  vocabulary: string | undefined,
  context: string | undefined,
): string | undefined {
  if (!context) return vocabulary;
  if (!vocabulary) return context;
  return `${/[.!?]$/.test(vocabulary) ? vocabulary : `${vocabulary}.`} ${context}`;
}

/** Turns a configured base URL (`http://127.0.0.1:8650`) into its transcription endpoint. */
export function localTranscriptionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/v1/audio/transcriptions`;
}

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly transcribe: (input: {
      readonly audio: Uint8Array;
      readonly mimeType: string;
      /** The end of the text already transcribed from the same recording (see `normalizeTranscriptionContext`). */
      readonly context?: string | undefined;
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

  const prompt = Option.filter(envConfig.prompt, (value) => value.trim().length > 0).pipe(
    Option.map((value) => value.trim()),
  );

  const localUrl = Option.filter(envConfig.localUrl, (url) => url.trim().length > 0).pipe(
    Option.map(localTranscriptionsUrl),
  );

  const requestTranscription = Effect.fn("VoiceTranscription.requestTranscription")(function* (
    target: {
      readonly url: string;
      readonly model: string;
      readonly apiKey: string | undefined;
      readonly timeout: Duration.Duration;
    },
    input: {
      readonly audio: Uint8Array;
      readonly mimeType: string;
      readonly context?: string | undefined;
    },
  ) {
    const form = new FormData();
    form.append("model", target.model);
    form.append("response_format", "json");
    const requestPrompt = composeTranscriptionPrompt(
      Option.getOrUndefined(prompt),
      normalizeTranscriptionContext(input.context),
    );
    if (requestPrompt !== undefined) form.append("prompt", requestPrompt);
    form.append(
      "file",
      new Blob([input.audio], { type: input.mimeType }),
      transcriptionFileNameForMimeType(input.mimeType),
    );

    const request = HttpClientRequest.post(target.url).pipe(
      target.apiKey ? HttpClientRequest.bearerToken(target.apiKey) : (request) => request,
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyFormData(form),
    );

    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(target.timeout),
      Effect.mapError((cause) =>
        fail("upstream_error", "Could not reach the transcription service.", cause),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      yield* Effect.logWarning("voice transcription request failed", {
        url: target.url,
        status: response.status,
        body: body.slice(0, 500),
      });
      return yield* fail("upstream_error", describeUpstreamFailure(response.status, body));
    }
    const decoded = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OpenAiTranscriptionResponse)),
      Effect.mapError((cause) =>
        fail("upstream_error", "The transcription service sent an unexpected response.", cause),
      ),
    );
    return decoded.text.trim();
  });

  const transcribe = Effect.fn("VoiceTranscription.transcribe")(function* (input: {
    readonly audio: Uint8Array;
    readonly mimeType: string;
    readonly context?: string | undefined;
  }) {
    if (input.audio.byteLength === 0) {
      return yield* fail("empty_audio", "The recording was empty.");
    }
    const apiKey = yield* resolveApiKey;
    const viaOpenAi = (apiKey: string) =>
      requestTranscription(
        {
          url: OPENAI_TRANSCRIPTIONS_URL,
          model: envConfig.model,
          apiKey,
          timeout: TRANSCRIPTION_TIMEOUT,
        },
        input,
      );

    if (Option.isNone(localUrl)) {
      if (!apiKey) {
        return yield* fail(
          "not_configured",
          "Voice input is not configured on this server: set T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL " +
            `to a local Whisper server, add an OpenAI API key to secrets/${VOICE_TRANSCRIPTION_API_KEY_SECRET}.bin, ` +
            "or set OPENAI_API_KEY.",
        );
      }
      return yield* viaOpenAi(apiKey);
    }

    return yield* requestTranscription(
      {
        url: localUrl.value,
        model: envConfig.localModel,
        apiKey: undefined,
        timeout: LOCAL_TRANSCRIPTION_TIMEOUT,
      },
      input,
    ).pipe(
      Effect.catch((localError) => {
        const localFailure = `Local transcription failed: ${localError.message}`;
        if (!apiKey) return Effect.fail(fail("upstream_error", localFailure, localError));
        return Effect.logWarning("local voice transcription failed; falling back to OpenAI", {
          cause: localError,
        }).pipe(
          Effect.andThen(viaOpenAi(apiKey)),
          Effect.mapError((openAiError) =>
            fail(
              "upstream_error",
              `${localFailure} The OpenAI fallback also failed: ${openAiError.message}`,
              openAiError,
            ),
          ),
        );
      }),
    );
  });

  return VoiceTranscription.of({ transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
