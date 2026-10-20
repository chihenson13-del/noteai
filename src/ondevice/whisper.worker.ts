/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import { rmsAmplitude } from './audio';
import { ON_DEVICE_MODELS } from './config';
import type { WorkerCancel, WorkerEvent, WorkerRequest, WorkerSegment } from './protocol';

/**
 * Runs Whisper inside a dedicated worker so the page stays responsive. The model and the
 * WebAssembly runtime are served from this site (see scripts/fetch-ondevice-assets.mjs): nothing
 * is fetched from a third party and the audio never leaves the worker.
 */

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text?: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> }>;

let loaded: { key: string; transcriber: Transcriber } | null = null;
let cancelled = false;

/** A window quieter than this is skipped: Whisper tends to invent text for silence. */
const SILENT_WINDOW_RMS = 0.0015;

function post(event: WorkerEvent): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(event);
}

function configure(baseUrl: string): void {
  // The library only treats files as present when they come from its "remote host", so that host is this
  // site: <site root>/models/<model>/<file>. No request goes anywhere else.
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = baseUrl;
  env.remotePathTemplate = 'models/{model}/';
  // Loading the runtime's JS from a blob: URL would need a looser content-security policy.
  env.useWasmCache = false;
  const onnx = env.backends.onnx as unknown as { wasm?: Record<string, unknown> };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = {
      mjs: `${baseUrl}ort/ort-wasm-simd-threaded.mjs`,
      wasm: `${baseUrl}ort/ort-wasm-simd-threaded.wasm`,
    };
    // Without cross-origin isolation the runtime runs single-threaded anyway; be explicit.
    onnx.wasm.numThreads = 1;
    onnx.wasm.proxy = false;
  }
}

async function loadModel(request: WorkerRequest): Promise<Transcriber> {
  const key = `${request.baseUrl}|${request.model}`;
  if (loaded?.key === key) return loaded.transcriber;
  configure(request.baseUrl);

  const files = new Map<string, { loaded: number; total: number }>();
  const report = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (info.status !== 'progress' && info.status !== 'done') return;
    if (!info.file) return;
    const entry = files.get(info.file) ?? { loaded: 0, total: 0 };
    if (info.status === 'done') {
      entry.loaded = entry.total || entry.loaded;
    } else {
      entry.loaded = info.loaded ?? entry.loaded;
      entry.total = info.total ?? entry.total;
    }
    files.set(info.file, entry);
    let sumLoaded = 0;
    let sumTotal = 0;
    for (const value of files.values()) {
      sumLoaded += value.loaded;
      sumTotal += value.total;
    }
    if (sumTotal > 0) {
      post({ type: 'model-progress', id: request.id, pct: Math.min(100, Math.round((sumLoaded / sumTotal) * 100)) });
    }
  };

  const transcriber = (await pipeline('automatic-speech-recognition', ON_DEVICE_MODELS[request.model].dir, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    device: 'wasm',
    progress_callback: report,
  } as never)) as unknown as Transcriber;

  loaded = { key, transcriber };
  return transcriber;
}

async function handle(request: WorkerRequest): Promise<void> {
  cancelled = false;
  const transcriber = await loadModel(request);
  post({ type: 'model-ready', id: request.id });

  const total = request.windows.length;
  for (let index = 0; index < total; index += 1) {
    if (cancelled) return;
    const window = request.windows[index]!;
    const audio = request.samples.subarray(window.start, window.end);
    if (rmsAmplitude(audio) < SILENT_WINDOW_RMS) {
      post({ type: 'window-done', id: request.id, index, total, segments: [] });
      continue;
    }
    const offsetMs = (window.start / 16_000) * 1000;
    const lengthMs = ((window.end - window.start) / 16_000) * 1000;

    const options: Record<string, unknown> = { return_timestamps: true, task: 'transcribe' };
    if (request.language) options.language = request.language;
    const output = await transcriber(audio, options);

    const segments: WorkerSegment[] = [];
    for (const chunk of output.chunks ?? []) {
      const text = chunk.text.trim();
      if (!text) continue;
      const [start, end] = chunk.timestamp;
      const startMs = offsetMs + Math.round(start * 1000);
      const endMs = offsetMs + (end === null || end === undefined ? lengthMs : Math.round(end * 1000));
      segments.push({ startMs: Math.round(startMs), endMs: Math.round(Math.max(endMs, startMs)), text });
    }
    if (segments.length === 0 && (output.chunks ?? []).length === 0 && output.text && output.text.trim()) {
      segments.push({ startMs: Math.round(offsetMs), endMs: Math.round(offsetMs + lengthMs), text: output.text.trim() });
    }
    post({ type: 'window-done', id: request.id, index, total, segments });
  }
  post({ type: 'done', id: request.id });
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest | WorkerCancel>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  void handle(message).catch((error: unknown) => {
    post({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
  });
});
