import { backend } from '../app/backend';
import { localStore } from '../app/localStore';
import { extensionForMime } from '../domain/audioMime';
import type { Recording } from '../domain/types';
import { AppError } from '../lib/errors';
import { safeFileName } from '../lib/format';
import { saveBlob } from '../lib/download';

/** Returns the original audio from this browser, falling back to the private cloud copy. */
export async function getOriginalAudio(recording: Recording): Promise<Blob> {
  if (recording.hasLocalAudio) {
    const local = await localStore.getAudio(recording.id);
    if (local) return local;
  }
  if (backend && recording.remotePath) return backend.downloadAudio(recording.remotePath);
  throw new AppError('AUDIO_MISSING', 'The original audio is no longer available (it was deleted or never stored here).');
}

export async function downloadOriginalAudio(recording: Recording): Promise<void> {
  const blob = await getOriginalAudio(recording);
  saveBlob(blob, `${safeFileName(recording.title)}.${extensionForMime(recording.mimeType || blob.type)}`);
}
