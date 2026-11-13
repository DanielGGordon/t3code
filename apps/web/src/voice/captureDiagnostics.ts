/** What the microphone pipeline observed during one recording; says why a recording came out empty. */
export interface VoiceCaptureDiagnostics {
  /** The microphone the browser picked, as its label reads. */
  readonly inputLabel: string;
  /** Audio samples that reached the page; 0 means capture never delivered anything. */
  readonly samplesReceived: number;
  /** The loudest 20 ms frame in dBFS (-90 is digital silence). */
  readonly loudestDb: number;
  /** Times the browser paused the audio context while recording. */
  readonly contextPauses: number;
  /** `mute` events on the microphone track while recording (Chrome also fires one at start-up). */
  readonly muteEvents: number;
  /** The microphone track was still muted when the recording ended. */
  readonly mutedAtStop: boolean;
  readonly sampleRate: number;
}

const QUIET_DB = -60;

function describeCause(diagnostics: VoiceCaptureDiagnostics, input: string): string {
  if (diagnostics.samplesReceived === 0) {
    return `No audio reached the page from the microphone${input}.`;
  }
  if (diagnostics.loudestDb > QUIET_DB) {
    return `No speech was detected (loudest sound ${Math.round(diagnostics.loudestDb)} dB).`;
  }
  if (diagnostics.contextPauses > 0) {
    return `The browser paused audio capture${input} while recording.`;
  }
  if (diagnostics.mutedAtStop || diagnostics.muteEvents > 0) {
    return `The browser muted the microphone${input}; another app may be using it.`;
  }
  return `The microphone${input} delivered only silence.`;
}

/** The message for a recording that held no speech, naming the likeliest cause plus the raw signals. */
export function describeEmptyRecording(diagnostics: VoiceCaptureDiagnostics): string {
  const input = diagnostics.inputLabel ? ` (${diagnostics.inputLabel})` : "";
  const signals = [
    `paused ${diagnostics.contextPauses}×`,
    `muted ${diagnostics.muteEvents}×${diagnostics.mutedAtStop ? " now" : ""}`,
    `loudest ${Math.round(diagnostics.loudestDb)} dB`,
    `${Math.round(diagnostics.sampleRate / 1000)} kHz`,
  ].join(", ");
  return `${describeCause(diagnostics, input)} [${signals}]`;
}
