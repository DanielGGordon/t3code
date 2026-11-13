import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceCaptureDiagnostics } from "./captureDiagnostics";

const heard: VoiceCaptureDiagnostics = {
  inputLabel: "Default",
  samplesReceived: 48_000,
  loudestDb: 0,
  contextPauses: 0,
  muteEvents: 0,
  mutedAtStop: false,
  sampleRate: 48_000,
};

const capture = vi.hoisted(() => ({
  pieces: [] as string[],
  diagnostics: undefined as unknown as VoiceCaptureDiagnostics,
  clip: null as Blob | null,
}));
const transcribe = vi.hoisted(() => vi.fn<(blob: Blob) => Promise<string>>());

vi.mock("./chunkedRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chunkedRecorder")>()),
  isChunkedVoiceRecordingSupported: () => true,
  startChunkedVoiceRecording: async (onPiece: (wav: Blob) => void) => ({
    stop: () => {
      for (const piece of capture.pieces) onPiece(new Blob([piece]));
    },
    cancel: () => {},
    fullClip: async () => capture.clip,
    diagnostics: () => capture.diagnostics,
  }),
}));
vi.mock("./transcriptionClient", () => ({
  transcribeVoiceRecording: (blob: Blob) => transcribe(blob),
}));

import { startVoiceDictationSession } from "./voiceSession";

async function finishWith(setup: {
  pieces: string[];
  diagnostics?: Partial<VoiceCaptureDiagnostics>;
  clip?: string;
}) {
  capture.pieces = setup.pieces;
  capture.diagnostics = { ...heard, ...setup.diagnostics };
  capture.clip = setup.clip === undefined ? null : new Blob([setup.clip]);
  const session = await startVoiceDictationSession();
  return session.finish();
}

describe("voice dictation session", () => {
  afterEach(() => transcribe.mockReset());

  it("uses the pieces when Web Audio kept running", async () => {
    transcribe.mockResolvedValue("hello");
    expect(await finishWith({ pieces: ["a"], clip: "whole" })).toEqual({
      text: "hello",
      error: null,
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("transcribes the full clip when the audio context paused mid-recording", async () => {
    transcribe.mockImplementation(async (blob) =>
      (await blob.text()) === "a" ? "hello" : "hello world",
    );
    expect(
      await finishWith({ pieces: ["a"], diagnostics: { contextPauses: 1 }, clip: "whole" }),
    ).toEqual({ text: "hello world", error: null });
  });

  it("keeps the pieces' text when the full clip comes back empty", async () => {
    transcribe.mockImplementation(async (blob) => ((await blob.text()) === "a" ? "hello" : ""));
    expect(
      await finishWith({ pieces: ["a"], diagnostics: { contextPauses: 1 }, clip: "whole" }),
    ).toEqual({ text: "hello", error: null });
  });

  it("falls back to the full clip when no piece held speech", async () => {
    transcribe.mockResolvedValue("rescued");
    expect(await finishWith({ pieces: [], clip: "whole" })).toEqual({
      text: "rescued",
      error: null,
    });
  });

  it("explains an empty recording when the full clip has nothing either", async () => {
    transcribe.mockResolvedValue("");
    const result = await finishWith({ pieces: [], diagnostics: { loudestDb: -90 }, clip: "whole" });
    expect(result.text).toBe("");
    expect(result.error?.message).toContain("delivered only silence");
  });
});
