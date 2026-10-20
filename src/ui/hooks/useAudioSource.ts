import { useEffect, useState } from 'react';
import { backend } from '../../app/backend';
import { localStore } from '../../app/localStore';
import type { Recording } from '../../domain/types';
import { errorMessage } from '../../lib/errors';

export interface AudioSourceState {
  url: string | null;
  source: 'device' | 'cloud' | null;
  loading: boolean;
  /** No audio is available anywhere (deleted, or only the metadata synced to this device). */
  missing: boolean;
  error: string | null;
}

/**
 * Resolves a playable URL for the original audio: the local IndexedDB blob when present,
 * otherwise a short-lived signed URL for the private cloud copy.
 */
export function useAudioSource(recording: Pick<Recording, 'id' | 'hasLocalAudio' | 'remotePath'> | undefined): AudioSourceState {
  const [state, setState] = useState<AudioSourceState>({ url: null, source: null, loading: !!recording, missing: false, error: null });
  const id = recording?.id;
  const hasLocalAudio = recording?.hasLocalAudio ?? false;
  const remotePath = recording?.remotePath ?? null;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, source: null, loading: true, missing: false, error: null });

    (async () => {
      try {
        if (hasLocalAudio) {
          const blob = await localStore.getAudio(id);
          if (blob && !cancelled) {
            objectUrl = URL.createObjectURL(blob);
            setState({ url: objectUrl, source: 'device', loading: false, missing: false, error: null });
            return;
          }
        }
        if (remotePath && backend) {
          const url = await backend.createAudioUrl(remotePath);
          if (!cancelled) setState({ url, source: 'cloud', loading: false, missing: false, error: null });
          return;
        }
        if (!cancelled) setState({ url: null, source: null, loading: false, missing: true, error: null });
      } catch (error) {
        if (!cancelled) setState({ url: null, source: null, loading: false, missing: false, error: errorMessage(error) });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, hasLocalAudio, remotePath]);

  return state;
}
