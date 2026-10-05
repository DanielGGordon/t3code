import { useCallback, useEffect, useRef, useState } from "react";

import { startVoiceRecording, type VoiceRecording } from "./recorder";
import { transcribeVoiceRecording } from "./transcriptionClient";

/** What to do with the transcript once it arrives. */
export type VoiceDictationFinishMode = "insert" | "send";

export type VoiceDictationPhase = "idle" | "starting" | "recording" | "transcribing";

/** Recordings auto-finish (as "insert") after this long. */
export const VOICE_DICTATION_MAX_DURATION_MS = 10 * 60 * 1000;

export interface VoiceDictation {
  readonly phase: VoiceDictationPhase;
  /** Milliseconds recorded so far (0 unless recording). */
  readonly elapsedMs: number;
  readonly start: () => void;
  readonly finish: (mode: VoiceDictationFinishMode) => void;
  readonly cancel: () => void;
}

export function useVoiceDictation(options: {
  readonly onTranscript: (text: string, mode: VoiceDictationFinishMode) => void;
  readonly onError: (message: string) => void;
}): VoiceDictation {
  const [phase, setPhase] = useState<VoiceDictationPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const recordingRef = useRef<VoiceRecording | null>(null);
  const startedAtRef = useRef(0);
  // Bumped on cancel/unmount so a late start or transcript is ignored.
  const generationRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback((mode: VoiceDictationFinishMode) => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    const generation = generationRef.current;
    setPhase("transcribing");
    void recording
      .stop()
      .then((audio) => transcribeVoiceRecording(audio))
      .then(
        (text) => {
          if (generation !== generationRef.current) return;
          if (text.trim().length === 0) {
            optionsRef.current.onError("No speech was detected.");
          } else {
            optionsRef.current.onTranscript(text.trim(), mode);
          }
        },
        (error: unknown) => {
          if (generation !== generationRef.current) return;
          optionsRef.current.onError(
            error instanceof Error ? error.message : "Transcription failed.",
          );
        },
      )
      .finally(() => {
        if (generation === generationRef.current) setPhase("idle");
      });
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setPhase("idle");
  }, []);

  const start = useCallback(() => {
    if (recordingRef.current || phase !== "idle") return;
    const generation = ++generationRef.current;
    setPhase("starting");
    void startVoiceRecording().then(
      (recording) => {
        if (generation !== generationRef.current) {
          recording.cancel();
          return;
        }
        recordingRef.current = recording;
        startedAtRef.current = performance.now();
        setElapsedMs(0);
        setPhase("recording");
      },
      (error: unknown) => {
        if (generation !== generationRef.current) return;
        setPhase("idle");
        optionsRef.current.onError(
          error instanceof Error ? error.message : "Could not start the microphone.",
        );
      },
    );
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= VOICE_DICTATION_MAX_DURATION_MS) finish("insert");
    }, 250);
    return () => window.clearInterval(interval);
  }, [finish, phase]);

  // Release the microphone if the composer unmounts mid-recording.
  useEffect(
    () => () => {
      generationRef.current += 1;
      recordingRef.current?.cancel();
      recordingRef.current = null;
    },
    [],
  );

  return { phase, elapsedMs: phase === "recording" ? elapsedMs : 0, start, finish, cancel };
}

export function formatVoiceDictationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
