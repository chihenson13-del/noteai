import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ActionItem, Notes, Recording, Transcript, UnfinishedSession } from '../domain/types';

export interface StoredAudio {
  id: string;
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
}

export interface StoredChunk {
  sessionId: string;
  index: number;
  blob: Blob;
}

export interface NoteAIDBSchema extends DBSchema {
  recordings: { key: string; value: Recording; indexes: { 'by-created': string } };
  audio: { key: string; value: StoredAudio };
  transcripts: { key: string; value: Transcript };
  notes: { key: string; value: Notes };
  actionItems: { key: string; value: ActionItem; indexes: { 'by-recording': string } };
  settings: { key: string; value: unknown };
  sessions: { key: string; value: UnfinishedSession };
  chunks: { key: [string, number]; value: StoredChunk; indexes: { 'by-session': string } };
}

export type NoteAIDB = IDBPDatabase<NoteAIDBSchema>;

export const DB_VERSION = 1;

export function openNoteAIDB(name = 'noteai'): Promise<NoteAIDB> {
  return openDB<NoteAIDBSchema>(name, DB_VERSION, {
    upgrade(db) {
      const recordings = db.createObjectStore('recordings', { keyPath: 'id' });
      recordings.createIndex('by-created', 'createdAt');
      db.createObjectStore('audio', { keyPath: 'id' });
      db.createObjectStore('transcripts', { keyPath: 'recordingId' });
      db.createObjectStore('notes', { keyPath: 'recordingId' });
      const items = db.createObjectStore('actionItems', { keyPath: 'id' });
      items.createIndex('by-recording', 'recordingId');
      db.createObjectStore('settings');
      db.createObjectStore('sessions', { keyPath: 'id' });
      const chunks = db.createObjectStore('chunks', { keyPath: ['sessionId', 'index'] });
      chunks.createIndex('by-session', 'sessionId');
    },
  });
}
