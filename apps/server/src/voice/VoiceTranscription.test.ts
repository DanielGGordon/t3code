import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

interface CapturedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly model: File | string | null;
  readonly fileName: string | undefined;
  readonly fileType: string | undefined;
}

/** The layer can also fail with a ConfigError; these cases expect the domain error. */
const expectVoiceError = (error: { readonly _tag: string }) => {
  assert.instanceOf(error, VoiceTranscription.VoiceTranscriptionError);
  return error as VoiceTranscription.VoiceTranscriptionError;
};

const makeHarness = (options: {
  readonly storedKey?: string;
  readonly env?: Record<string, string>;
  /** `"unreachable"` fails the request at the transport layer, like a refused connection. */
  readonly respond?: (url: string) => Response | "unreachable";
}) => {
  const captured: Array<CapturedRequest> = [];
  const httpClient = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const form = request.body._tag === "FormData" ? request.body.formData : undefined;
      const file = form?.get("file");
      captured.push({
        url: request.url,
        authorization: request.headers.authorization,
        model: form?.get("model") ?? null,
        fileName: file instanceof File ? file.name : undefined,
        fileType: file instanceof File ? file.type : undefined,
      });
      const response =
        options.respond?.(request.url) ??
        Response.json({ text: "  hello world  " }, { status: 200 });
      if (response === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "connection refused" }),
        });
      }
      return HttpClientResponse.fromWeb(request, response);
    }),
  );

  const layer = VoiceTranscription.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) =>
          Effect.succeed(
            name === VoiceTranscription.VOICE_TRANSCRIPTION_API_KEY_SECRET &&
              options.storedKey !== undefined
              ? Option.some(new TextEncoder().encode(options.storedKey))
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} }))),
  );

  const transcribe = (audio = new Uint8Array([1, 2, 3]), mimeType = "audio/webm;codecs=opus") =>
    Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      return yield* service.transcribe({ audio, mimeType });
    }).pipe(Effect.provide(layer));

  return { captured, transcribe };
};

describe("transcriptionFileNameForMimeType", () => {
  it("maps recorder MIME types to extensions the transcription API accepts", () => {
    assert.equal(
      VoiceTranscription.transcriptionFileNameForMimeType("audio/webm;codecs=opus"),
      "speech.webm",
    );
    assert.equal(VoiceTranscription.transcriptionFileNameForMimeType("audio/mp4"), "speech.mp4");
    assert.equal(
      VoiceTranscription.transcriptionFileNameForMimeType("audio/ogg; codecs=opus"),
      "speech.ogg",
    );
    assert.equal(VoiceTranscription.transcriptionFileNameForMimeType("audio/x-wav"), "speech.wav");
    assert.equal(VoiceTranscription.transcriptionFileNameForMimeType(""), "speech.webm");
  });
});

describe("VoiceTranscription", () => {
  it.effect("prefers the stored secret over OPENAI_API_KEY and trims the transcript", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        storedKey: "sk-stored\n",
        env: { OPENAI_API_KEY: "sk-env" },
      });
      const text = yield* harness.transcribe();
      assert.equal(text, "hello world");
      assert.deepEqual(harness.captured, [
        {
          url: "https://api.openai.com/v1/audio/transcriptions",
          authorization: "Bearer sk-stored",
          model: VoiceTranscription.DEFAULT_VOICE_TRANSCRIPTION_MODEL,
          fileName: "speech.webm",
          fileType: "audio/webm;codecs=opus",
        },
      ]);
    }),
  );

  it.effect("falls back to OPENAI_API_KEY and honours the model override", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        env: { OPENAI_API_KEY: "sk-env", T3CODE_VOICE_TRANSCRIPTION_MODEL: "whisper-1" },
      });
      yield* harness.transcribe(new Uint8Array([9]), "audio/mp4");
      assert.equal(harness.captured[0]?.authorization, "Bearer sk-env");
      assert.equal(harness.captured[0]?.model, "whisper-1");
      assert.equal(harness.captured[0]?.fileName, "speech.mp4");
    }),
  );

  it.effect("fails as not_configured without calling upstream when no key exists", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const error = expectVoiceError(yield* Effect.flip(harness.transcribe()));
      assert.equal(error.reason, "not_configured");
      assert.equal(harness.captured.length, 0);
    }),
  );

  it.effect("rejects empty recordings", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ storedKey: "sk-stored" });
      const error = expectVoiceError(yield* Effect.flip(harness.transcribe(new Uint8Array())));
      assert.equal(error.reason, "empty_audio");
      assert.equal(harness.captured.length, 0);
    }),
  );

  it.effect("maps upstream HTTP errors to upstream_error", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        storedKey: "sk-stored",
        respond: () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
      });
      const error = expectVoiceError(yield* Effect.flip(harness.transcribe()));
      assert.equal(error.reason, "upstream_error");
      assert.include(error.message, "401");
    }),
  );

  it.effect("names an exhausted OpenAI quota instead of a bare 429", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        storedKey: "sk-stored",
        respond: () =>
          Response.json(
            {
              error: {
                message: "Your organization has reached its configured enforced spend limit.",
                type: "insufficient_quota",
                code: "organization_spend_limit_exceeded",
              },
            },
            { status: 429 },
          ),
      });
      const error = expectVoiceError(yield* Effect.flip(harness.transcribe()));
      assert.equal(error.reason, "upstream_error");
      assert.include(error.message, "quota or spend limit");
    }),
  );
});

describe("VoiceTranscription with a local Whisper server", () => {
  const LOCAL_URL = "http://127.0.0.1:8650/v1/audio/transcriptions";

  it.effect("uses the local server without an OpenAI key and sends no auth", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        env: { T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL: "http://127.0.0.1:8650/" },
      });
      const text = yield* harness.transcribe();
      assert.equal(text, "hello world");
      assert.deepEqual(harness.captured, [
        {
          url: LOCAL_URL,
          authorization: undefined,
          model: VoiceTranscription.DEFAULT_LOCAL_VOICE_TRANSCRIPTION_MODEL,
          fileName: "speech.webm",
          fileType: "audio/webm;codecs=opus",
        },
      ]);
    }),
  );

  it.effect("prefers the local server over OpenAI when both are configured", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        storedKey: "sk-stored",
        env: {
          T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL: "http://127.0.0.1:8650",
          T3CODE_VOICE_TRANSCRIPTION_LOCAL_MODEL: "Systran/faster-whisper-small.en",
        },
      });
      yield* harness.transcribe();
      assert.deepEqual(
        harness.captured.map((request) => [request.url, request.model]),
        [[LOCAL_URL, "Systran/faster-whisper-small.en"]],
      );
    }),
  );

  it.effect("falls back to OpenAI when the local server is unreachable or errors", () =>
    Effect.gen(function* () {
      for (const localResponse of ["unreachable", new Response("boom", { status: 500 })] as const) {
        const harness = makeHarness({
          storedKey: "sk-stored",
          env: { T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL: "http://127.0.0.1:8650" },
          respond: (url) =>
            url === LOCAL_URL ? localResponse : Response.json({ text: "from openai" }),
        });
        const text = yield* harness.transcribe();
        assert.equal(text, "from openai");
        assert.deepEqual(
          harness.captured.map((request) => [request.url, request.authorization]),
          [
            [LOCAL_URL, undefined],
            ["https://api.openai.com/v1/audio/transcriptions", "Bearer sk-stored"],
          ],
        );
      }
    }),
  );

  it.effect("reports the local failure when there is no OpenAI fallback", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        env: { T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL: "http://127.0.0.1:8650" },
        respond: () => "unreachable",
      });
      const error = expectVoiceError(yield* Effect.flip(harness.transcribe()));
      assert.equal(error.reason, "upstream_error");
      assert.include(error.message, "Local transcription failed");
      assert.equal(harness.captured.length, 1);
    }),
  );

  it.effect("reports both failures when the OpenAI fallback also fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        storedKey: "sk-stored",
        env: { T3CODE_VOICE_TRANSCRIPTION_LOCAL_URL: "http://127.0.0.1:8650" },
        respond: (url) =>
          url === LOCAL_URL
            ? "unreachable"
            : Response.json({ error: { type: "insufficient_quota" } }, { status: 429 }),
      });
      const error = expectVoiceError(yield* Effect.flip(harness.transcribe()));
      assert.include(error.message, "Local transcription failed");
      assert.include(error.message, "quota or spend limit");
    }),
  );
});
