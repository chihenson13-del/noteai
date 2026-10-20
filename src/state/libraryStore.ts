import { create } from 'zustand';
import { backend } from '../app/backend';
import { localStore } from '../app/localStore';
import type { Recording } from '../domain/types';
import { errorMessage } from '../lib/errors';

interface LibraryState {
  recordings: Recording[];
  /** recordingId -> transcript text, for library search. */
  transcriptIndex: Map<string, string>;
  loaded: boolean;
  loadError: string | null;
  load(): Promise<void>;
  applyRecording(recording: Recording): void;
  refreshTranscriptIndex(): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  /** Pass null to remove the recording from its collection. */
  setCollection(id: string, collection: string | null): Promise<void>;
  /** The user has seen the interruption notice; stop listing it under "Needs attention". */
  acknowledgeInterruption(id: string): Promise<void>;
  /** Deletes the recording locally and (when requested and possible) in the cloud. */
  remove(id: string, options?: { alsoCloud?: boolean }): Promise<void>;
  /** Deletes only the original audio; transcript and notes are kept. */
  removeAudio(id: string): Promise<void>;
}

function sortByDate(list: Recording[]): Recording[] {
  return [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  recordings: [],
  transcriptIndex: new Map(),
  loaded: false,
  loadError: null,

  async load() {
    try {
      const [recordings, transcriptIndex] = await Promise.all([localStore.listRecordings(), localStore.transcriptTextIndex()]);
      set({ recordings, transcriptIndex, loaded: true, loadError: null });
    } catch (error) {
      set({ loaded: true, loadError: errorMessage(error) });
    }
  },

  applyRecording(recording) {
    set((state) => {
      const others = state.recordings.filter((r) => r.id !== recording.id);
      return { recordings: sortByDate([...others, recording]) };
    });
  },

  async refreshTranscriptIndex() {
    set({ transcriptIndex: await localStore.transcriptTextIndex() });
  },

  async rename(id, title) {
    const updated = await localStore.updateRecording(id, { title });
    get().applyRecording(updated);
    const current = get().recordings.find((r) => r.id === id);
    if (backend && current?.inCloud) {
      // Best effort: the local rename already succeeded.
      await backend.updateTitle(id, title).catch(() => undefined);
    }
  },

  async setPinned(id, pinned) {
    const updated = await localStore.updateRecording(id, { pinned });
    get().applyRecording(updated);
    if (backend && updated.inCloud) await backend.updateRecordingMeta(id, { pinned }).catch(() => undefined);
  },

  async setCollection(id, collection) {
    const updated = await localStore.updateRecording(id, { collection });
    get().applyRecording(updated);
    if (backend && updated.inCloud) await backend.updateRecordingMeta(id, { collection }).catch(() => undefined);
  },

  async acknowledgeInterruption(id) {
    const updated = await localStore.updateRecording(id, { interruptionAcknowledged: true });
    get().applyRecording(updated);
  },

  async remove(id, options = {}) {
    const recording = get().recordings.find((r) => r.id === id);
    if (options.alsoCloud && backend && recording?.inCloud) {
      await backend.deleteRecording(id, recording.remotePath);
    }
    await localStore.deleteRecording(id);
    set((state) => {
      const next = new Map(state.transcriptIndex);
      next.delete(id);
      return { recordings: state.recordings.filter((r) => r.id !== id), transcriptIndex: next };
    });
  },

  async removeAudio(id) {
    const recording = get().recordings.find((r) => r.id === id);
    if (!recording) return;
    if (backend && recording.remotePath) {
      await backend.deleteRemoteAudio(id, recording.remotePath);
    }
    await localStore.deleteAudio(id);
    const updated = await localStore.updateRecording(id, {
      hasLocalAudio: false,
      remotePath: null,
      audioDeletedAt: new Date().toISOString(),
    });
    get().applyRecording(updated);
  },
}));
