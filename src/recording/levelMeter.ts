export interface LevelMeter {
  /** 0..1, dB-scaled so quiet speech is still visible. */
  read(): number;
  close(): void;
}

type AudioContextCtor = typeof AudioContext;

/** Maps an RMS amplitude (0..1) to a 0..1 meter value over a 60 dB range. */
export function rmsToLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/**
 * Creates an analyser on the microphone stream. Returns null when Web Audio is unavailable —
 * the recording itself never depends on the meter.
 */
export function createLevelMeter(stream: MediaStream, Ctor?: AudioContextCtor): LevelMeter | null {
  const AudioCtx: AudioContextCtor | undefined =
    Ctor ?? (typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) : undefined);
  if (!AudioCtx) return null;
  try {
    const context = new AudioCtx();
    void context.resume?.();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser); // intentionally NOT connected to the destination (no echo)
    const samples = new Uint8Array(analyser.fftSize);
    return {
      read() {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        return rmsToLevel(Math.sqrt(sum / samples.length));
      },
      close() {
        try {
          source.disconnect();
          void context.close();
        } catch {
          /* already closed */
        }
      },
    };
  } catch {
    return null;
  }
}
