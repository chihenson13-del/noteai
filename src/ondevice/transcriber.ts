import { AppError } from '../lib/errors';
import type { OnDeviceModelId } from '../domain/types';
import { BASE_PATH } from '../config/base';
import { CUT_SEARCH_SECONDS, MODEL_CACHE_KEY, ON_DEVICE_MODELS, WINDOW_SECONDS } from './config';
import { WHISPER_SAMPLE_RATE, decodeToMono16k, peakAmplitude, planWindows } from './audio';
import type { WorkerEvent, WorkerRequest, WorkerSegment } from './protocol';

export type OnDevicePhase = 'decoding' | 'loading-model' | 'transcribing';

export interface OnDeviceProgress {
  phase: OnDevicePhase;
  /** 0-100 within the phase, or null when unknown. */
  pct: number | null;
}

export interface SpeechResult {
  segments: WorkerSegment[];
  /** Length of the decoded audio. */
  durationMs: number;
  /** The audio was essentially silent, so the model was not run. */
  silent: boolean;
}

/** What the processing service needs from a speech engine. Faked in tests. */
export interface SpeechEngine {
  isSupported(): boolean;
  transcribe(
    audio: Blob,
    options: { model: OnDeviceModelId; language: string | null },
    onProgress: (progress: OnDeviceProgress) => void,
    signal: AbortSignal,
  ): Promise<SpeechResult>;
}

/** Below this peak (full scale = 1) a recording is treated as silence rather than fed to the model. */
const SILENCE_PEAK = 0.004;

export function isOnDeviceSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const hasAudio =
    typeof AudioContext !== 'undefined' || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined';
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && hasAudio;
}

export class WhisperWorkerEngine implements SpeechEngine {
  private worker: Worker | null = null;
  private nextId = 1;

  isSupported(): boolean {
    return isOnDeviceSupported();
  }

  async transcribe(
    audio: Blob,
    options: { model: OnDeviceModelId; language: string | null },
    onProgress: (progress: OnDeviceProgress) => void,
    signal: AbortSignal,
  ): Promise<SpeechResult> {
    if (!this.isSupported()) {
      throw new AppError(
        'UNKNOWN',
        'This browser cannot run on-device transcription (it needs Web Workers, WebAssembly and Web Audio).',
      );
    }
    throwIfAborted(signal);

    onProgress({ phase: 'decoding', pct: null });
    let samples: Float32Array;
    try {
      samples = await decodeToMono16k(audio);
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
      throw new AppError('UNKNOWN', `The audio could not be decoded in this browser${detail}.`, { cause: error });
    }
    throwIfAborted(signal);

    const durationMs = Math.round((samples.length / WHISPER_SAMPLE_RATE) * 1000);
    if (samples.length === 0 || peakAmplitude(samples) < SILENCE_PEAK) {
      return { segments: [], durationMs, silent: true };
    }

    const windows = planWindows(samples, WINDOW_SECONDS * WHISPER_SAMPLE_RATE, CUT_SEARCH_SECONDS * WHISPER_SAMPLE_RATE);
    const segments = await this.run(samples, windows, options, onProgress, signal);
    return { segments, durationMs, silent: false };
  }

  private run(
    samples: Float32Array,
    windows: Array<{ start: number; end: number }>,
    options: { model: OnDeviceModelId; language: string | null },
    onProgress: (progress: OnDeviceProgress) => void,
    signal: AbortSignal,
  ): Promise<WorkerSegment[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const request: WorkerRequest = {
      type: 'transcribe',
      id,
      model: options.model,
      baseUrl: new URL(BASE_PATH, window.location.origin).toString(),
      samples,
      windows,
      language: options.language && options.language !== 'auto' ? options.language : null,
    };

    return new Promise<WorkerSegment[]>((resolve, reject) => {
      const collected: WorkerSegment[] = [];
      onProgress({ phase: 'loading-model', pct: 0 });

      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        // Killing the worker is the only way to stop a running ONNX session immediately.
        this.terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        this.terminate();
        reject(new AppError('UNKNOWN', friendlyEngineError(event.message || 'The transcription engine crashed.')));
      };
      const onMessage = (event: MessageEvent<WorkerEvent>) => {
        const message = event.data;
        if (message.id !== id) return;
        switch (message.type) {
          case 'model-progress':
            onProgress({ phase: 'loading-model', pct: message.pct });
            break;
          case 'model-ready':
            onProgress({ phase: 'transcribing', pct: 0 });
            break;
          case 'window-done':
            collected.push(...message.segments);
            onProgress({ phase: 'transcribing', pct: Math.round(((message.index + 1) / message.total) * 100) });
            break;
          case 'done':
            cleanup();
            resolve(collected);
            break;
          case 'error':
            cleanup();
            this.terminate();
            reject(new AppError('UNKNOWN', friendlyEngineError(message.message)));
            break;
        }
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage(request, [samples.buffer]);
    });
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    }
    return this.worker;
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}

export function friendlyEngineError(message: string): string {
  if (/memory|alloc|out of/i.test(message)) {
    return 'The device ran out of memory while transcribing. Try the Fast model, close other tabs, or transcribe this recording on a computer.';
  }
  if (/404|not found|could not locate|failed to fetch|NetworkError|Load failed/i.test(message)) {
    return 'The speech model files could not be loaded. Check your connection and try again.';
  }
  return `Transcription failed: ${message}`;
}

/** How many model files are already stored in this browser (a repeat run then starts at once). */
export async function modelCacheSummary(): Promise<{ supported: boolean; files: number }> {
  if (typeof caches === 'undefined') return { supported: false, files: 0 };
  try {
    if (!(await caches.has(MODEL_CACHE_KEY))) return { supported: true, files: 0 };
    const cache = await caches.open(MODEL_CACHE_KEY);
    return { supported: true, files: (await cache.keys()).length };
  } catch {
    return { supported: false, files: 0 };
  }
}

export async function clearModelCache(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    return await caches.delete(MODEL_CACHE_KEY);
  } catch {
    return false;
  }
}

export function modelDownloadMb(model: OnDeviceModelId): number {
  return ON_DEVICE_MODELS[model].approxMb;
}
