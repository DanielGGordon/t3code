import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { startVoiceDictationSession, type VoiceDictationSession } from "./voiceSession";

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
  const recordingRef = useRef<VoiceDictationSession | null>(null);
  const startedAtRef = useRef(0);
  // Bumped on cancel/unmount so a late start or transcript is ignored.
  const generationRef = useRef(0);
  const onTranscript = useStableCallback(options.onTranscript);
  const onError = useStableCallback(options.onError);

  const finish = useStableCallback((mode: VoiceDictationFinishMode) => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    const generation = generationRef.current;
    setPhase("transcribing");
    void recording
      .finish()
      .then(
        ({ text, error }) => {
          if (generation !== generationRef.current) return;
          const transcript = text.trim();
          if (transcript.length === 0) {
            onError(error ? error.message : "No speech was detected.");
          } else if (error) {
            // Part of the recording failed: let the user look at what was heard, even if they
            // asked to send it.
            onTranscript(transcript, "insert");
            onError(`Part of the recording could not be transcribed: ${error.message}`);
          } else {
            onTranscript(transcript, mode);
          }
        },
        (error: unknown) => {
          if (generation !== generationRef.current) return;
          onError(error instanceof Error ? error.message : "Transcription failed.");
        },
      )
      .finally(() => {
        if (generation === generationRef.current) setPhase("idle");
      });
  });

  const cancel = useStableCallback(() => {
    generationRef.current += 1;
    recordingRef.current?.cancel();
    recordingRef.current = null;
    setPhase("idle");
  });

  const start = useStableCallback(() => {
    if (recordingRef.current || phase !== "idle") return;
    const generation = ++generationRef.current;
    setPhase("starting");
    void startVoiceDictationSession().then(
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
        onError(error instanceof Error ? error.message : "Could not start the microphone.");
      },
    );
  });

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
