/** What the microphone pipeline observed during one recording; says why a recording came out empty. */
export interface VoiceCaptureDiagnostics {
  /** The microphone the browser picked, as its label reads. */
  readonly inputLabel: string;
  /** Audio frames that reached the page; 0 means capture never delivered anything. */
  readonly samplesReceived: number;
  /** The loudest 20 ms frame in dBFS (-90 is digital silence). */
  readonly loudestDb: number;
  /** The browser paused the audio context or muted the microphone track at some point. */
  readonly interrupted: boolean;
}

const QUIET_DB = -60;

/** The message for a recording that held no speech, naming the likeliest cause. */
export function describeEmptyRecording(diagnostics: VoiceCaptureDiagnostics): string {
  const input = diagnostics.inputLabel ? ` (${diagnostics.inputLabel})` : "";
  if (diagnostics.samplesReceived === 0) {
    return `No audio reached the page from the microphone${input}. Tap the mic and try again.`;
  }
  if (diagnostics.interrupted) {
    return `The browser paused the microphone${input} while recording, so audio was lost. Keep the screen on and the page in front.`;
  }
  if (diagnostics.loudestDb <= QUIET_DB) {
    return `The microphone${input} delivered only silence. Check which input the phone is using.`;
  }
  return `No speech was detected (loudest sound ${Math.round(diagnostics.loudestDb)} dB).`;
}
