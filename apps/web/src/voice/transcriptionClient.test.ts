import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatVoiceDictationElapsed } from "./useVoiceDictation";
import {
  describeVoiceTranscriptionFailure,
  isRetryableVoiceTranscriptionFailure,
  transcribeVoiceRecording,
  VoiceTranscriptionRequestError,
} from "./transcriptionClient";

function stubBrowserPrimary() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://203.0.113.10/chat",
        origin: "https://203.0.113.10",
      },
    },
  });
}

describe("transcribeVoiceRecording", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it("uploads the recording with its MIME type and cookie credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ text: "run the tests" }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    stubBrowserPrimary();

    const text = await transcribeVoiceRecording(
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" }),
    );

    expect(text).toBe("run the tests");
    const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/fork/voice/transcribe");
    expect(request.credentials).toBe("include");
    expect(request.headers.get("content-type")).toBe("audio/webm;codecs=opus");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("passes the text so far as the context parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "more" }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    stubBrowserPrimary();

    await transcribeVoiceRecording(new Blob([new Uint8Array([1])], { type: "audio/wav" }), {
      context: "Move the migration step & retry",
    });

    const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
    expect(new URL(request.url).searchParams.get("context")).toBe(
      "Move the migration step & retry",
    );
  });

  it("marks failures worth retrying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    stubBrowserPrimary();
    const offline = await transcribeVoiceRecording(new Blob([new Uint8Array([1])])).catch(
      (error: VoiceTranscriptionRequestError) => error,
    );
    expect((offline as VoiceTranscriptionRequestError).retryable).toBe(true);

    expect(
      isRetryableVoiceTranscriptionFailure(502, { reason: "upstream_error", message: "x" }),
    ).toBe(true);
    expect(
      isRetryableVoiceTranscriptionFailure(503, { reason: "not_configured", message: "x" }),
    ).toBe(false);
    expect(
      isRetryableVoiceTranscriptionFailure(413, { reason: "audio_too_large", message: "x" }),
    ).toBe(false);
    expect(isRetryableVoiceTranscriptionFailure(503, null)).toBe(true);
    expect(isRetryableVoiceTranscriptionFailure(401, null)).toBe(false);
  });

  it("surfaces the server's failure message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ reason: "not_configured", message: "No key set." }, { status: 503 }),
        ),
    );
    stubBrowserPrimary();

    const failure = transcribeVoiceRecording(new Blob([new Uint8Array([1])]));
    await expect(failure).rejects.toBeInstanceOf(VoiceTranscriptionRequestError);
    await expect(failure).rejects.toThrow("No key set.");
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    stubBrowserPrimary();

    await expect(transcribeVoiceRecording(new Blob([new Uint8Array([1])]))).rejects.toThrow(
      "Could not reach the server to transcribe.",
    );
  });
});

describe("describeVoiceTranscriptionFailure", () => {
  it("explains expired sessions and unknown failures", () => {
    expect(describeVoiceTranscriptionFailure(401, null)).toBe(
      "Your session expired; sign in again.",
    );
    expect(describeVoiceTranscriptionFailure(500, "nope")).toBe("Transcription failed (HTTP 500).");
  });
});

describe("formatVoiceDictationElapsed", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatVoiceDictationElapsed(0)).toBe("0:00");
    expect(formatVoiceDictationElapsed(7_900)).toBe("0:07");
    expect(formatVoiceDictationElapsed(125_000)).toBe("2:05");
  });
});
