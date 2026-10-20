import { DEFAULT_SETTINGS } from '../domain/types';
import type { ActionItem, AppSettings, Notes, Recording, Transcript, UnfinishedSession } from '../domain/types';
import { parseSettings } from '../domain/schemas';
import { coerceActionItem, coerceMoments, coerceNotes, withRecordingDefaults } from '../domain/migrate';
import { AppError } from '../lib/errors';
import { openNoteAIDB, type NoteAIDB } from './db';

const SETTINGS_KEY = 'app';

/**
 * All on-device persistence. IndexedDB is the source of truth for audio that has not (or
 * will never) reach the cloud, so every write that could lose audio is ordered "write the
 * new copy first, delete the old copy second".
 */
export class LocalStore {
  private dbPromise: Promise<NoteAIDB> | null = null;

  constructor(private readonly dbName = 'noteai') {}

  private db(): Promise<NoteAIDB> {
    if (!this.dbPromise) {
      this.dbPromise = openNoteAIDB(this.dbName).catch((error: unknown) => {
        this.dbPromise = null;
        throw new AppError('STORAGE_FAILED', 'Browser storage is unavailable (private mode or storage blocked?).', { cause: error });
      });
    }
    return this.dbPromise;
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
  }

  // --- recordings ---------------------------------------------------------

  async listRecordings(): Promise<Recording[]> {
    const db = await this.db();
    const all = await db.getAll('recordings');
    return all.map(withRecordingDefaults).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async getRecording(id: string): Promise<Recording | undefined> {
    const raw = await (await this.db()).get('recordings', id);
    return raw ? withRecordingDefaults(raw) : undefined;
  }

  async putRecording(recording: Recording): Promise<void> {
    await (await this.db()).put('recordings', recording);
  }

  /** Atomically merges `patch` into the stored recording. Returns the new value. */
  async updateRecording(id: string, patch: Partial<Recording>): Promise<Recording> {
    const db = await this.db();
    const tx = db.transaction('recordings', 'readwrite');
    const current = await tx.store.get(id);
    if (!current) {
      await tx.done;
      throw new AppError('UNKNOWN', 'That recording no longer exists.');
    }
    const next: Recording = { ...current, ...patch, id: current.id, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    await tx.store.put(next);
    await tx.done;
    return next;
  }

  /** Removes the recording and everything derived from it. */
  async deleteRecording(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['recordings', 'audio', 'transcripts', 'notes', 'actionItems'], 'readwrite');
    await Promise.all([
      tx.objectStore('recordings').delete(id),
      tx.objectStore('audio').delete(id),
      tx.objectStore('transcripts').delete(id),
      tx.objectStore('notes').delete(id),
      (async () => {
        const store = tx.objectStore('actionItems');
        const keys = await store.index('by-recording').getAllKeys(id);
        await Promise.all(keys.map((key) => store.delete(key)));
      })(),
    ]);
    await tx.done;
  }

  // --- audio ---------------------------------------------------------------

  async putAudio(id: string, blob: Blob, mimeType: string): Promise<void> {
    await (await this.db()).put('audio', { id, blob, mimeType, sizeBytes: blob.size });
  }

  async getAudio(id: string): Promise<Blob | undefined> {
    const stored = await (await this.db()).get('audio', id);
    return stored?.blob;
  }

  async deleteAudio(id: string): Promise<void> {
    await (await this.db()).delete('audio', id);
  }

  async hasAudio(id: string): Promise<boolean> {
    return (await (await this.db()).getKey('audio', id)) !== undefined;
  }

  // --- transcripts / notes / action items -------------------------------------

  async getTranscript(recordingId: string): Promise<Transcript | undefined> {
    return (await this.db()).get('transcripts', recordingId);
  }

  async putTranscript(transcript: Transcript): Promise<void> {
    await (await this.db()).put('transcripts', transcript);
  }

  /** recordingId -> full transcript text, for library search. */
  async transcriptTextIndex(): Promise<Map<string, string>> {
    const all = await (await this.db()).getAll('transcripts');
    return new Map(all.map((t) => [t.recordingId, t.text]));
  }

  async getNotes(recordingId: string): Promise<Notes | undefined> {
    return coerceNotes(await (await this.db()).get('notes', recordingId));
  }

  async putNotes(notes: Notes): Promise<void> {
    await (await this.db()).put('notes', notes);
  }

  async listActionItems(recordingId: string): Promise<ActionItem[]> {
    const items = await (await this.db()).getAllFromIndex('actionItems', 'by-recording', recordingId);
    return items.map(coerceActionItem).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async replaceActionItems(recordingId: string, items: ActionItem[]): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('actionItems', 'readwrite');
    const keys = await tx.store.index('by-recording').getAllKeys(recordingId);
    await Promise.all(keys.map((key) => tx.store.delete(key)));
    await Promise.all(items.map((item) => tx.store.put({ ...item, recordingId })));
    await tx.done;
  }

  // --- settings -------------------------------------------------------------

  async getSettings(): Promise<AppSettings> {
    const raw = await (await this.db()).get('settings', SETTINGS_KEY);
    return raw === undefined ? { ...DEFAULT_SETTINGS } : parseSettings(raw);
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await (await this.db()).put('settings', settings, SETTINGS_KEY);
  }

  // --- in-progress recording sessions (crash / reload recovery) -----------------

  async beginSession(session: UnfinishedSession): Promise<void> {
    await (await this.db()).put('sessions', session);
  }

  /** Appends one MediaRecorder chunk and refreshes the heartbeat in a single transaction. */
  async appendChunk(
    sessionId: string,
    index: number,
    blob: Blob,
    progress: { elapsedMs: number; heartbeatAt: number; wasInterrupted: boolean },
  ): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['chunks', 'sessions'], 'readwrite');
    await tx.objectStore('chunks').put({ sessionId, index, blob });
    const sessions = tx.objectStore('sessions');
    const session = await sessions.get(sessionId);
    if (session) {
      await sessions.put({ ...session, ...progress, chunkCount: Math.max(session.chunkCount, index + 1) });
    }
    await tx.done;
  }

  async updateSession(sessionId: string, patch: Partial<UnfinishedSession>): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('sessions', 'readwrite');
    const session = await tx.store.get(sessionId);
    if (session) await tx.store.put({ ...session, ...patch, id: sessionId });
    await tx.done;
  }

  async listSessions(): Promise<UnfinishedSession[]> {
    const sessions = await (await this.db()).getAll('sessions');
    return sessions.map((session) => ({ ...session, moments: coerceMoments(session.moments) }));
  }

  async loadSessionChunks(sessionId: string): Promise<Blob[]> {
    const chunks = await (await this.db()).getAllFromIndex('chunks', 'by-session', sessionId);
    return chunks.sort((a, b) => a.index - b.index).map((chunk) => chunk.blob);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['chunks', 'sessions'], 'readwrite');
    const chunkStore = tx.objectStore('chunks');
    const keys = await chunkStore.index('by-session').getAllKeys(sessionId);
    await Promise.all(keys.map((key) => chunkStore.delete(key)));
    await tx.objectStore('sessions').delete(sessionId);
    await tx.done;
  }

  // --- housekeeping ----------------------------------------------------------

  /** Bytes of audio held in this browser (from recording metadata; no blob reads). */
  async localAudioBytes(): Promise<number> {
    const recordings = await this.listRecordings();
    return recordings.filter((r) => r.hasLocalAudio).reduce((sum, r) => sum + r.sizeBytes, 0);
  }

  async clearEverything(): Promise<void> {
    const db = await this.db();
    const names = ['recordings', 'audio', 'transcripts', 'notes', 'actionItems', 'settings', 'sessions', 'chunks'] as const;
    const tx = db.transaction([...names], 'readwrite');
    await Promise.all(names.map((name) => tx.objectStore(name).clear()));
    await tx.done;
  }
}
