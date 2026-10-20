import type { OnDeviceModelId } from '../domain/types';

export interface WorkerSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export type WorkerRequest = {
  type: 'transcribe';
  id: number;
  model: OnDeviceModelId;
  /** Absolute URL of the site root the model and runtime files are served from. */
  baseUrl: string;
  /** Mono 16 kHz audio. */
  samples: Float32Array;
  /** [start, end) sample ranges to transcribe, in order. */
  windows: Array<{ start: number; end: number }>;
  /** ISO-639-1, or null to let the model detect the language. */
  language: string | null;
};

export type WorkerCancel = { type: 'cancel' };

export type WorkerEvent =
  | { type: 'model-progress'; id: number; pct: number }
  | { type: 'model-ready'; id: number }
  | { type: 'window-done'; id: number; index: number; total: number; segments: WorkerSegment[] }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string };
