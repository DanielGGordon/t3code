import { describe, expect, it } from "vite-plus/test";

import { describeEmptyRecording, type VoiceCaptureDiagnostics } from "./captureDiagnostics";

const heard: VoiceCaptureDiagnostics = {
  inputLabel: "Pixel mic",
  samplesReceived: 480_000,
  loudestDb: -35,
  contextPauses: 0,
  muteEvents: 0,
  mutedAtStop: false,
  sampleRate: 48_000,
};

describe("describeEmptyRecording", () => {
  it.each([
    [{ samplesReceived: 0 }, "No audio reached the page from the microphone (Pixel mic)."],
    [{ loudestDb: -90, contextPauses: 1 }, "The browser paused audio capture (Pixel mic)"],
    [{ loudestDb: -90, muteEvents: 1 }, "The browser muted the microphone (Pixel mic)"],
    [{ loudestDb: -90, mutedAtStop: true }, "The browser muted the microphone (Pixel mic)"],
    [{ loudestDb: -90 }, "The microphone (Pixel mic) delivered only silence."],
    // A pause or mute that left audible sound behind did not cause the empty result.
    [{ contextPauses: 1, muteEvents: 1 }, "No speech was detected (loudest sound -35 dB)."],
  ])("explains %j", (change, message) => {
    expect(describeEmptyRecording({ ...heard, ...change })).toContain(message);
  });

  it("lists the raw signals so a screenshot of the toast is enough to diagnose", () => {
    expect(
      describeEmptyRecording({ ...heard, inputLabel: "", loudestDb: -90, muteEvents: 2 }),
    ).toBe(
      "The browser muted the microphone; another app may be using it. [paused 0×, muted 2×, loudest -90 dB, 48 kHz]",
    );
  });
});
