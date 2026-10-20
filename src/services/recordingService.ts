import type { Recording, UnfinishedSession } from '../domain/types';
import type { RecordedAudio } from '../recording/recorder';
import type { LocalStore } from '../data/localStore';
import { defaultRecordingTitle } from '../lib/format';

type SaveStore = Pick<LocalStore, 'putAudio' | 'putRecording' | 'deleteSession'>;
type RecoverStore = Pick<LocalStore, 'listSessions' | 'loadSessionChunks' | 'getRecording'> & SaveStore;

export function recordingFromAudio(audio: RecordedAudio): Recording {
  const nowIso = new Date().toISOString();
  return {
    id: audio.sessionId,
    title: audio.title.trim() || defaultRecordingTitle(new Date(audio.startedAt)),
    createdAt: audio.startedAt,
    updatedAt: nowIso,
    durationMs: audio.durationMs,
    sizeBytes: audio.blob.size,
    mimeType: audio.mimeType,
    quality: audio.quality,
    status: 'local',
    failedStage: null,
    errorMessage: null,
    hasLocalAudio: true,
    remotePath: null,
    language: null,
    wasInterrupted: audio.wasInterrupted,
    interruptionNote: audio.interruptionNote,
    interruptionAcknowledged: false,
    checksumSha256: null,
    audioDeletedAt: null,
    inCloud: false,
    pinned: false,
    collection: null,
    moments: audio.moments,
  };
}

/**
 * Persists a finished recording. Ordering matters: the audio blob and the library entry are
 * written BEFORE the crash-recovery chunks are removed, so a failure at any point never
 * leaves the user without a copy of the audio. Safe to call twice for the same session.
 */
export async function saveRecordedAudio(store: SaveStore, audio: RecordedAudio): Promise<Recording> {
  const recording = recordingFromAudio(audio);
  await store.putAudio(recording.id, audio.blob, audio.mimeType);
  await store.putRecording(recording);
  await store.deleteSession(audio.sessionId).catch(() => undefined);
  return recording;
}

/** A session whose heartbeat is older than this is assumed to belong to a closed/crashed tab. */
export const SESSION_STALE_MS = 20_000;

/**
 * Turns recordings that were in progress when a tab closed, crashed or reloaded into normal
 * library entries. Sessions with a fresh heartbeat (another tab still recording) and the
 * current tab's own session are left alone.
 */
export async function recoverOrphanedSessions(
  store: RecoverStore,
  options: {
    now?: number;
    ownSessionId?: string | null;
    staleMs?: number;
    /** true = a live tab holds the session, false = abandoned, null/undefined = unknown (use heartbeat). */
    isHeld?: (sessionId: string) => Promise<boolean | null>;
  } = {},
): Promise<Recording[]> {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? SESSION_STALE_MS;
  const sessions = await store.listSessions();
  const recovered: Recording[] = [];

  for (const session of sessions) {
    if (session.id === options.ownSessionId) continue;
    const held = options.isHeld ? await options.isHeld(session.id) : null;
    if (held === true) continue;
    // Without a definitive lock answer, fall back to "has the heartbeat gone quiet?".
    if (held === null && now - session.heartbeatAt < staleMs) continue;
    const chunks = await store.loadSessionChunks(session.id);
    const existing = await store.getRecording(session.id);
    if (existing) {
      // Already saved before the crash happened mid-cleanup: just drop the leftovers.
      await store.deleteSession(session.id);
      continue;
    }
    if (chunks.length === 0) {
      await store.deleteSession(session.id);
      continue;
    }
    recovered.push(await saveRecordedAudio(store, audioFromSession(session, chunks)));
  }
  return recovered;
}

function audioFromSession(session: UnfinishedSession, chunks: Blob[]): RecordedAudio {
  const base = (session.mimeType.split(';')[0] ?? session.mimeType).trim();
  return {
    sessionId: session.id,
    title: session.title,
    blob: new Blob(chunks, { type: base }),
    mimeType: base,
    durationMs: session.elapsedMs,
    quality: session.quality,
    startedAt: session.startedAt,
    wasInterrupted: true,
    moments: session.moments,
    interruptionNote:
      'This recording was recovered after the page was closed, reloaded or crashed while recording. The last few seconds may be missing.',
  };
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
