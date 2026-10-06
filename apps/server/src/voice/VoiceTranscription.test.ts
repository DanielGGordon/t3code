import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

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
  readonly respond?: () => Response;
}) => {
  const captured: Array<CapturedRequest> = [];
  const httpClient = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      const form = request.body._tag === "FormData" ? request.body.formData : undefined;
      const file = form?.get("file");
      captured.push({
        url: request.url,
        authorization: request.headers.authorization,
        model: form?.get("model") ?? null,
        fileName: file instanceof File ? file.name : undefined,
        fileType: file instanceof File ? file.type : undefined,
      });
      return HttpClientResponse.fromWeb(
        request,
        options.respond?.() ?? Response.json({ text: "  hello world  " }, { status: 200 }),
      );
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
});
