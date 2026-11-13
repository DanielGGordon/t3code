import { describe, expect, it } from "vite-plus/test";

import { describeEmptyRecording, type VoiceCaptureDiagnostics } from "./captureDiagnostics";

const heard: VoiceCaptureDiagnostics = {
  inputLabel: "Pixel mic",
  samplesReceived: 480_000,
  loudestDb: -35,
  interrupted: false,
};

describe("describeEmptyRecording", () => {
  it.each([
    [{ samplesReceived: 0 }, "No audio reached the page from the microphone (Pixel mic)"],
    [{ interrupted: true }, "paused the microphone (Pixel mic)"],
    [{ loudestDb: -90 }, "delivered only silence"],
    [{}, "No speech was detected (loudest sound -35 dB)."],
  ])("explains %j", (change, message) => {
    expect(describeEmptyRecording({ ...heard, ...change })).toContain(message);
  });

  it("puts a missing input label out of the sentence", () => {
    expect(describeEmptyRecording({ ...heard, inputLabel: "", loudestDb: -90 })).toBe(
      "The microphone delivered only silence. Check which input the phone is using.",
    );
  });
});
