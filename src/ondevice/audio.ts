export const WHISPER_SAMPLE_RATE = 16_000;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function canDecodeAudio(): boolean {
  return audioContextCtor() !== null;
}

/**
 * Decodes a recording (webm/opus, mp4/aac, ogg ...) to what Whisper expects: mono, 16 kHz, float32.
 * Uses only the browser's own decoder; nothing is uploaded.
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const Ctor = audioContextCtor();
  if (!Ctor) throw new Error('This browser cannot decode audio (no Web Audio API).');

  let context: AudioContext;
  try {
    context = new Ctor({ sampleRate: WHISPER_SAMPLE_RATE });
  } catch {
    context = new Ctor();
  }
  try {
    const encoded = await blob.arrayBuffer();
    // Callback form: the only one older Safari versions understand; it also works everywhere else.
    const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      const maybe = context.decodeAudioData(encoded, resolve, (error) =>
        reject(error ?? new Error('The browser could not decode this audio.')),
      );
      if (maybe && typeof (maybe as Promise<AudioBuffer>).catch === 'function') {
        (maybe as Promise<AudioBuffer>).catch(reject);
      }
    });

    if (decoded.numberOfChannels === 1 && decoded.sampleRate === WHISPER_SAMPLE_RATE) {
      return decoded.getChannelData(0).slice();
    }

    // Down-mix and resample with an offline context (the browser mixes channels when the destination is mono).
    const length = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, length, WHISPER_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    void context.close().catch(() => undefined);
  }
}

export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

export function rmsAmplitude(samples: Float32Array, start = 0, end = samples.length): number {
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(samples.length, Math.ceil(end));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / (to - from));
}

/**
 * Splits audio into windows of at most `windowSamples`. A cut is placed at the quietest 100 ms frame in
 * the last `searchSamples` of a window so words are rarely sliced in half.
 */
export function planWindows(
  samples: Float32Array,
  windowSamples: number,
  searchSamples: number,
  sampleRate = WHISPER_SAMPLE_RATE,
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  const frame = Math.max(1, Math.floor(sampleRate / 10));
  let start = 0;
  while (start < samples.length) {
    let end = Math.min(samples.length, start + windowSamples);
    if (end < samples.length && searchSamples > 0) {
      let bestStart = end;
      let bestEnergy = Infinity;
      const from = Math.max(start + frame, end - searchSamples);
      for (let position = from; position + frame <= end; position += frame) {
        const energy = rmsAmplitude(samples, position, position + frame);
        if (energy < bestEnergy) {
          bestEnergy = energy;
          bestStart = position;
        }
      }
      end = Math.min(samples.length, bestStart + Math.floor(frame / 2));
      if (end <= start) end = Math.min(samples.length, start + windowSamples);
    }
    windows.push({ start, end });
    start = end;
  }
  return windows;
}
