import type { OnDeviceModelId } from '../domain/types';

export interface OnDeviceModelInfo {
  id: OnDeviceModelId;
  /** Folder under public/models (see scripts/fetch-ondevice-assets.mjs). */
  dir: string;
  label: string;
  description: string;
  /** Approximate download, in megabytes. */
  approxMb: number;
}

export const ON_DEVICE_MODELS: Record<OnDeviceModelId, OnDeviceModelInfo> = {
  tiny: {
    id: 'tiny',
    dir: 'whisper-tiny',
    label: 'Fast',
    description: 'Whisper Tiny. Quickest, fine for clear speech.',
    approxMb: 44,
  },
  base: {
    id: 'base',
    dir: 'whisper-base',
    label: 'More accurate',
    description: 'Whisper Base. Fewer mistakes, roughly 2–3× slower.',
    approxMb: 80,
  },
};

/** Name of the Cache Storage bucket transformers.js keeps downloaded model files in. */
export const MODEL_CACHE_KEY = 'transformers-cache';

/** One Whisper window. The model cannot look at more than 30 s at a time. */
export const WINDOW_SECONDS = 30;
/** When a window has to be cut, the cut is placed at the quietest moment in its last few seconds. */
export const CUT_SEARCH_SECONDS = 5;

/** Recordings longer than this are likely to run a phone out of memory while decoding. */
export const LONG_RECORDING_WARNING_MS = 45 * 60_000;
