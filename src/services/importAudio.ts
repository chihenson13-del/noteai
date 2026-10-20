import type { LocalStore } from '../data/localStore';
import { baseMimeType } from '../domain/audioMime';
import type { Recording, RecordingQuality } from '../domain/types';
import { AppError } from '../lib/errors';
import { newId } from '../lib/id';
import { recordingFromAudio } from './recordingService';

type ImportStore = Pick<LocalStore, 'putAudio' | 'putRecording'>;

export const IMPORT_ACCEPT = 'audio/*,.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.webm,.flac,.caf,.mp4';
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  caf: 'audio/x-caf',
};

/** Title from a file name: "Team sync 2026-03-02.m4a" -> "Team sync 2026-03-02". */
export function titleFromFileName(name: string): string {
  const withoutExtension = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return withoutExtension.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function mimeForFile(file: Pick<File, 'name' | 'type'>): string | null {
  const declared = baseMimeType(file.type || '');
  if (declared.startsWith('audio/') || declared === 'video/mp4' || declared === 'video/webm') {
    return declared === 'video/mp4' ? 'audio/mp4' : declared === 'video/webm' ? 'audio/webm' : declared;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME[extension] ?? null;
}

/** Reads the length of an audio file from its metadata. Resolves 0 when the browser cannot tell. */
export function probeDurationMs(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined') return resolve(0);
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    let settled = false;
    const finish = (ms: number) => {
      if (settled) return;
      settled = true;
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) return finish(audio.duration * 1000);
      // Some webm files report Infinity until the end has been seeked to.
      audio.ontimeupdate = () => {
        audio.ontimeupdate = null;
        finish(audio.duration * 1000);
      };
      audio.currentTime = 1e6;
    };
    audio.onerror = () => finish(0);
    setTimeout(() => finish(0), 8000);
    audio.src = url;
  });
}

export interface ImportDeps {
  store: ImportStore;
  quality: RecordingQuality;
  probeDuration?: (blob: Blob) => Promise<number>;
  now?: () => Date;
}

/**
 * Adds an existing audio file (a voice memo, a downloaded call ...) to the library as a normal
 * on-device recording. The file is copied as-is; nothing is converted or uploaded.
 */
export async function importAudioFile(file: File, deps: ImportDeps): Promise<Recording> {
  const mimeType = mimeForFile(file);
  if (!mimeType) {
    throw new AppError('UNKNOWN', `“${file.name}” doesn’t look like an audio file. Choose an m4a, mp3, wav, ogg, webm or similar file.`);
  }
  if (file.size === 0) throw new AppError('UNKNOWN', `“${file.name}” is empty.`);
  if (file.size > MAX_IMPORT_BYTES) {
    throw new AppError('UNKNOWN', `“${file.name}” is larger than ${Math.round(MAX_IMPORT_BYTES / 1048576)} MB, which is more than a browser can handle reliably.`);
  }

  const blob = new Blob([file], { type: mimeType });
  const durationMs = await (deps.probeDuration ?? probeDurationMs)(blob);
  const now = deps.now?.() ?? new Date();
  const modified = file.lastModified ? new Date(file.lastModified) : now;

  const recording = recordingFromAudio({
    sessionId: newId(),
    title: titleFromFileName(file.name) || 'Imported audio',
    blob,
    mimeType,
    durationMs,
    quality: deps.quality,
    startedAt: modified.toISOString(),
    wasInterrupted: false,
    interruptionNote: null,
    moments: [],
  });
  await deps.store.putAudio(recording.id, blob, mimeType);
  await deps.store.putRecording(recording);
  return recording;
}
