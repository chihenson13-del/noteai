import { useCallback, useEffect, useState } from 'react';
import { backend } from '../../app/backend';
import { localStore } from '../../app/localStore';
import type { ActionItem, Notes, Recording, Transcript } from '../../domain/types';
import { useAuthStore } from '../../state/authStore';
import { useLibraryStore } from '../../state/libraryStore';

export interface RecordingDetails {
  transcript: Transcript | null;
  notes: Notes | null;
  items: ActionItem[];
  loading: boolean;
  reload(): Promise<void>;
}

/**
 * Transcript, notes and action items for one recording. Reads the local cache first and, for
 * completed recordings that were processed on another device, pulls them from the cloud once.
 */
export function useRecordingDetails(recording: Recording | undefined): RecordingDetails {
  const user = useAuthStore((s) => s.user);
  const refreshTranscriptIndex = useLibraryStore((s) => s.refreshTranscriptIndex);
  const [state, setState] = useState<Omit<RecordingDetails, 'reload'>>({ transcript: null, notes: null, items: [], loading: true });
  const id = recording?.id;
  const status = recording?.status;
  const updatedAt = recording?.updatedAt;
  const inCloud = recording?.inCloud ?? false;

  const load = useCallback(async () => {
    if (!id) return;
    let [transcript, notes, items] = await Promise.all([
      localStore.getTranscript(id),
      localStore.getNotes(id),
      localStore.listActionItems(id),
    ]);

    if (status === 'completed' && inCloud && backend && user && (!transcript || !notes)) {
      try {
        const [remoteTranscript, remoteNotes, remoteItems] = await Promise.all([
          transcript ? Promise.resolve(transcript) : backend.fetchTranscript(id),
          notes ? Promise.resolve(notes) : backend.fetchNotes(id),
          items.length ? Promise.resolve(items) : backend.fetchActionItems(id),
        ]);
        if (remoteTranscript && !transcript) {
          await localStore.putTranscript(remoteTranscript);
          void refreshTranscriptIndex();
        }
        if (remoteNotes && !notes) await localStore.putNotes(remoteNotes);
        if (items.length === 0 && remoteItems.length > 0) await localStore.replaceActionItems(id, remoteItems);
        transcript = remoteTranscript ?? transcript;
        notes = remoteNotes ?? notes;
        items = items.length ? items : remoteItems;
      } catch {
        // Offline: show whatever is cached.
      }
    }
    setState({ transcript: transcript ?? null, notes: notes ?? null, items, loading: false });
  }, [id, status, inCloud, user, refreshTranscriptIndex]);

  useEffect(() => {
    setState((prev) => ({ ...prev, loading: true }));
    void load();
    // `updatedAt` makes the details refresh when the pipeline finishes while the screen is open.
  }, [load, updatedAt]);

  return { ...state, reload: load };
}
