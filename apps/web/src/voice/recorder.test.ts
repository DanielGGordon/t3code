import { describe, expect, it } from "@effect/vitest";

import { pickVoiceRecordingMimeType } from "./recorder";

describe("pickVoiceRecordingMimeType", () => {
  it("prefers webm/opus when the browser supports it", () => {
    expect(pickVoiceRecordingMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to mp4 for Safari-style recorders", () => {
    expect(pickVoiceRecordingMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("lets the browser choose when nothing preferred is supported", () => {
    expect(pickVoiceRecordingMimeType(() => false)).toBeUndefined();
  });

  it("treats a throwing isTypeSupported as unsupported", () => {
    expect(
      pickVoiceRecordingMimeType((type) => {
        if (type.startsWith("audio/webm")) throw new Error("boom");
        return type === "audio/ogg;codecs=opus";
      }),
    ).toBe("audio/ogg;codecs=opus");
  });
});
