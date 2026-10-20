import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudBackend, CloudUser, ProcessOptions, ProcessStageRequest } from '../data/backend';
import { LocalStore } from '../data/localStore';
import { AppError } from '../lib/errors';
import { DEFAULT_SETTINGS, type AppSettings, type Recording } from '../domain/types';
import { makeRecording } from '../test/factories';
import type { RecordedAudio } from '../recording/recorder';
import { ProcessingPipeline } from './pipeline';
import { SESSION_STALE_MS, recoverOrphanedSessions, saveRecordedAudio } from './recordingService';
import { applyAudioRetention, dueForAudioDeletion } from './retention';
import { syncFromCloud } from './syncService';

const USER: CloudUser = { id: 'user-1', email: 'u@example.com', name: null, contactEmail: null, viaCode: false };
const DAY = 86_400_000;

type Scenario = 'complete' | 'transcribe-fails' | 'summarize-fails';

class FakeBackend implements CloudBackend {
  rows = new Map<string, Recording>();
  uploads = new Map<string, Blob>();
  ensureCalls = 0;
  uploadCalls = 0;
  processCalls: Array<{ stage: ProcessStageRequest; force: boolean; options: ProcessOptions }> = [];
  failUploads = 0;
  failRequests = 0;
  scenario: Scenario = 'complete';
  pollsBeforeDone = 1;
  private pollCount = new Map<string, number>();

  async getUser() {
    return USER;
  }
  onAuthChange() {
    return () => undefined;
  }
  async signIn() {}
  async signUp() {
    return { needsEmailConfirmation: false };
  }
  async signInWithCode() {}
  async signOut() {}
  async sendPasswordReset() {}
  async updatePassword() {}

  async ensureRecordingRow(_userId: string, recording: Recording) {
    this.ensureCalls += 1;
    if (!this.rows.has(recording.id)) this.rows.set(recording.id, { ...recording, status: 'uploading', inCloud: true });
  }
  async uploadAudio(userId: string, recording: Recording, blob: Blob) {
    this.uploadCalls += 1;
    if (this.failUploads > 0) {
      this.failUploads -= 1;
      throw new AppError('NETWORK', 'Network down', { retryable: true });
    }
    const path = `${userId}/${recording.id}.webm`;
    this.uploads.set(path, blob);
    const row = this.rows.get(recording.id)!;
    this.rows.set(recording.id, { ...row, status: 'uploaded', remotePath: path });
    return path;
  }
  async markUploadFailed() {}
  async requestProcessing(recordingId: string, stage: ProcessStageRequest, force: boolean, options: ProcessOptions) {
    if (this.failRequests > 0) {
      this.failRequests -= 1;
      throw new AppError('NETWORK', 'Network down', { retryable: true });
    }
    this.processCalls.push({ stage, force, options });
    const row = this.rows.get(recordingId)!;
    this.rows.set(recordingId, { ...row, status: stage === 'all' ? 'transcribing' : 'summarizing' });
    this.pollCount.set(recordingId, 0);
  }
  async fetchRecording(id: string) {
    const row = this.rows.get(id);
    if (!row) return null;
    const polls = (this.pollCount.get(id) ?? 0) + 1;
    this.pollCount.set(id, polls);
    if ((row.status === 'transcribing' || row.status === 'summarizing') && polls > this.pollsBeforeDone) {
      if (this.scenario === 'transcribe-fails') {
        this.rows.set(id, { ...row, status: 'failed', failedStage: 'transcribe', errorMessage: 'Provider unavailable' });
      } else if (this.scenario === 'summarize-fails') {
        this.rows.set(id, { ...row, status: 'failed', failedStage: 'summarize', errorMessage: 'Notes failed' });
      } else {
        this.rows.set(id, { ...row, status: 'completed', language: 'en' });
      }
    }
    return this.rows.get(id) ?? null;
  }
  async fetchRecordings() {
    return [...this.rows.values()];
  }
  async fetchTranscript(recordingId: string) {
    return { recordingId, language: 'en', text: 'hello transcript', segments: [], provider: 'openai', model: 'whisper-1', createdAt: '' };
  }
  async fetchNotes(recordingId: string) {
    return {
      recordingId,
      summary: 'A summary',
      keyTakeaways: [{ text: 'one', atMs: 1000 }],
      decisions: [],
      chapters: [],
      topics: [],
      provider: 'anthropic',
      model: 'm',
      userEdited: false,
      createdAt: '',
      updatedAt: '',
    };
  }
  async fetchActionItems(recordingId: string) {
    return [{ id: 'ai-1', recordingId, text: 'Do the thing', assignee: null, dueDate: null, done: false, sortOrder: 0, atMs: null }];
  }
  async updateTitle() {}
  async updateRecordingMeta() {}
  async askRecordings() {
    return { found: false, answer: '', sources: [], searched: 0 };
  }
  async createShareLink() {
    return { id: 'share-1', token: 't'.repeat(43), expiresAt: '2030-01-01T00:00:00.000Z' };
  }
  async listShareLinks() {
    return [];
  }
  async revokeShareLink() {}
  async fetchTransfers() {
    return [];
  }
  async saveNotes() {}
  async replaceActionItems() {}
  async createAudioUrl() {
    return 'blob:fake';
  }
  async downloadAudio() {
    return new Blob(['x']);
  }
  deletedRemote: string[] = [];
  async deleteRemoteAudio(recordingId: string) {
    this.deletedRemote.push(recordingId);
  }
  async deleteRecording() {}
  async deleteAccount() {}
}

let counter = 0;
let store: LocalStore;

beforeEach(() => {
  counter += 1;
  store = new LocalStore(`noteai-svc-${counter}`);
});
afterEach(async () => {
  await store.close();
});

function makePipeline(backend: FakeBackend, options: { settings?: Partial<AppSettings>; user?: CloudUser | null } = {}) {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, uploadConsentAt: '2026-01-01T00:00:00.000Z', ...options.settings };
  const changes: Recording[] = [];
  const pipeline = new ProcessingPipeline({
    store,
    backend,
    getUser: () => (options.user === undefined ? USER : options.user),
    getSettings: () => settings,
    onRecordingChanged: (r) => changes.push(r),
    checksum: async () => 'a'.repeat(64),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  });
  return { pipeline, changes };
}

async function seed(id: string, overrides: Partial<Recording> = {}) {
  const recording = makeRecording(id, overrides);
  await store.putRecording(recording);
  if (recording.hasLocalAudio) await store.putAudio(id, new Blob(['audio-123'], { type: 'audio/webm' }), 'audio/webm');
  return recording;
}

describe('ProcessingPipeline', () => {
  it('refuses to upload without consent or without an account', async () => {
    await seed('r1');
    const backend = new FakeBackend();
    await expect(makePipeline(backend, { settings: { uploadConsentAt: null } }).pipeline.run('r1')).rejects.toMatchObject({
      code: 'NOT_CONSENTED',
    });
    await expect(makePipeline(backend, { user: null }).pipeline.run('r1')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(backend.uploadCalls).toBe(0);
    expect((await store.getRecording('r1'))?.status).toBe('local');
  });

  it('uploads, transcribes and summarizes, caching results and keeping the original audio', async () => {
    await seed('r1');
    const backend = new FakeBackend();
    const { pipeline, changes } = makePipeline(backend);

    const result = await pipeline.run('r1');
    expect(result.status).toBe('completed');
    expect(result.remotePath).toBe('user-1/r1.webm');
    expect(result.inCloud).toBe(true);
    expect(result.checksumSha256).toBe('a'.repeat(64));
    expect(backend.uploadCalls).toBe(1);
    expect(backend.processCalls).toHaveLength(1);
    expect(backend.processCalls[0]).toMatchObject({ stage: 'all', force: false });

    expect((await store.getTranscript('r1'))?.text).toBe('hello transcript');
    expect((await store.getNotes('r1'))?.summary).toBe('A summary');
    expect(await store.listActionItems('r1')).toHaveLength(1);
    expect(await store.hasAudio('r1')).toBe(true);

    const statuses = changes.map((c) => c.status);
    expect(statuses).toContain('uploading');
    expect(statuses).toContain('uploaded');
    expect(statuses).toContain('transcribing');
    expect(statuses.at(-1)).toBe('completed');
  });

  it('keeps the audio and allows retry after an upload failure, without duplicate rows', async () => {
    await seed('r1');
    const backend = new FakeBackend();
    backend.failUploads = 99;
    const { pipeline } = makePipeline(backend);

    await expect(pipeline.run('r1')).rejects.toMatchObject({ code: 'NETWORK' });
    let stored = await store.getRecording('r1');
    expect(stored?.status).toBe('failed');
    expect(stored?.failedStage).toBe('upload');
    expect(stored?.errorMessage).toBe('Network down');
    expect(await store.hasAudio('r1')).toBe(true);
    expect(backend.uploadCalls).toBe(3); // 3 attempts with backoff

    backend.failUploads = 0;
    const retried = await pipeline.run('r1');
    expect(retried.status).toBe('completed');
    expect(backend.rows.size).toBe(1);
    stored = await store.getRecording('r1');
    expect(stored?.failedStage).toBeNull();
  });

  it('records a transcription failure, preserves audio, and retry does not re-upload', async () => {
    await seed('r1');
    const backend = new FakeBackend();
    backend.scenario = 'transcribe-fails';
    const { pipeline } = makePipeline(backend);

    await expect(pipeline.run('r1')).rejects.toMatchObject({ code: 'PROCESSING_FAILED', message: 'Provider unavailable' });
    const failed = await store.getRecording('r1');
    expect(failed).toMatchObject({ status: 'failed', failedStage: 'transcribe', errorMessage: 'Provider unavailable' });
    expect(failed?.remotePath).toBe('user-1/r1.webm');
    expect(await store.hasAudio('r1')).toBe(true);
    expect(await store.getTranscript('r1')).toBeUndefined();

    backend.scenario = 'complete';
    const retried = await pipeline.run('r1');
    expect(retried.status).toBe('completed');
    expect(backend.uploadCalls).toBe(1);
    expect(backend.processCalls).toHaveLength(2);
  });

  it('retries only the summary when that is the stage that failed', async () => {
    await seed('r1');
    const backend = new FakeBackend();
    backend.scenario = 'summarize-fails';
    const { pipeline } = makePipeline(backend);
    await expect(pipeline.run('r1')).rejects.toThrow('Notes failed');
    expect((await store.getRecording('r1'))?.failedStage).toBe('summarize');

    backend.scenario = 'complete';
    await pipeline.run('r1');
    expect(backend.processCalls.at(-1)?.stage).toBe('summarize');
    expect(backend.uploadCalls).toBe(1);
  });

  it('collapses concurrent runs into one (no duplicate uploads or jobs)', async () => {
    await seed('r1');
    const backend = new FakeBackend();
    const { pipeline } = makePipeline(backend);
    const [a, b, c] = [pipeline.run('r1'), pipeline.run('r1'), pipeline.run('r1')];
    expect(pipeline.isRunning('r1')).toBe(true);
    await Promise.all([a, b, c]);
    expect(backend.uploadCalls).toBe(1);
    expect(backend.processCalls).toHaveLength(1);
    expect(pipeline.isRunning('r1')).toBe(false);
  });

  it('does nothing for completed recordings unless forced; regenerate only summarizes', async () => {
    await seed('r1', { status: 'completed', remotePath: 'user-1/r1.webm', inCloud: true });
    const backend = new FakeBackend();
    backend.rows.set('r1', makeRecording('r1', { status: 'completed', remotePath: 'user-1/r1.webm', inCloud: true }));
    const { pipeline } = makePipeline(backend);

    await pipeline.run('r1');
    expect(backend.processCalls).toHaveLength(0);

    await pipeline.regenerateNotes('r1');
    expect(backend.processCalls).toEqual([expect.objectContaining({ stage: 'summarize', force: true })]);
    expect(backend.uploadCalls).toBe(0);
  });

  it('passes the user preferences to the server', async () => {
    await seed('r1');
    const backend = new FakeBackend();
    const { pipeline } = makePipeline(backend, {
      settings: { language: 'de', summaryLength: 'detailed', extractActionItems: false, extractDecisions: true },
    });
    await pipeline.run('r1');
    expect(backend.processCalls[0]?.options).toEqual({
      language: 'de',
      summaryLength: 'detailed',
      extractActionItems: false,
      extractDecisions: true,
    });
  });

  it('fails clearly when the original audio is no longer on this device', async () => {
    await seed('r1', { hasLocalAudio: false });
    const backend = new FakeBackend();
    const { pipeline } = makePipeline(backend);
    await expect(pipeline.run('r1')).rejects.toMatchObject({ code: 'AUDIO_MISSING' });
    expect(backend.uploadCalls).toBe(0);
    expect((await store.getRecording('r1'))?.failedStage).toBe('upload');
  });

  it('resume() repairs interrupted uploads and re-polls server-side work', async () => {
    await seed('stuck-upload', { status: 'uploading' });
    await seed('server-work', { status: 'transcribing', remotePath: 'user-1/server-work.webm', inCloud: true });
    const backend = new FakeBackend();
    backend.rows.set('server-work', makeRecording('server-work', { status: 'transcribing', remotePath: 'user-1/server-work.webm', inCloud: true }));
    const { pipeline } = makePipeline(backend);

    await pipeline.resume(await store.listRecordings());
    expect((await store.getRecording('stuck-upload'))?.status).toBe('local');

    await vi.waitFor(async () => {
      expect((await store.getRecording('server-work'))?.status).toBe('completed');
    });
  });
});

function audio(sessionId: string, bytes = 'chunk'): RecordedAudio {
  return {
    sessionId,
    title: 'Interview',
    blob: new Blob([bytes], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    durationMs: 12_000,
    quality: 'standard',
    startedAt: '2026-01-10T10:00:00.000Z',
    wasInterrupted: false,
    interruptionNote: null,
    moments: [{ id: 'm1', atMs: 4000, kind: 'key', text: 'Launch date' }],
  };
}

describe('saving and recovering recordings', () => {
  it('saves audio and the library entry, then drops the recovery chunks', async () => {
    await store.beginSession({
      id: 's1', title: 'Interview', mimeType: 'audio/webm', quality: 'standard',
      startedAt: '2026-01-10T10:00:00.000Z', elapsedMs: 0, heartbeatAt: 0, chunkCount: 0, moments: [], wasInterrupted: false,
    });
    await store.appendChunk('s1', 0, new Blob(['c']), { elapsedMs: 1, heartbeatAt: 1, wasInterrupted: false });

    const saved = await saveRecordedAudio(store, audio('s1'));
    expect(saved).toMatchObject({ id: 's1', title: 'Interview', status: 'local', hasLocalAudio: true, inCloud: false, sizeBytes: 5 });
    expect(await store.hasAudio('s1')).toBe(true);
    expect(await store.getRecording('s1')).toBeDefined();
    expect(await store.listSessions()).toEqual([]);
  });

  it('recovers only abandoned sessions, as interrupted recordings', async () => {
    const now = 10_000_000;
    const base = {
      title: 'Lecture', mimeType: 'audio/webm;codecs=opus', quality: 'standard' as const,
      startedAt: '2026-01-10T10:00:00.000Z', elapsedMs: 42_000, chunkCount: 1, moments: [], wasInterrupted: false,
    };
    await store.beginSession({ ...base, id: 'dead', heartbeatAt: now - SESSION_STALE_MS - 1 });
    await store.beginSession({ ...base, id: 'alive-in-other-tab', heartbeatAt: now - 2000 });
    await store.beginSession({ ...base, id: 'mine', heartbeatAt: now - 999_999 });
    await store.beginSession({ ...base, id: 'empty', heartbeatAt: now - 999_999 });
    for (const id of ['dead', 'alive-in-other-tab', 'mine']) {
      await store.appendChunk(id, 0, new Blob(['audio']), { elapsedMs: 42_000, heartbeatAt: id === 'alive-in-other-tab' ? now - 2000 : now - 999_999, wasInterrupted: false });
    }

    const recovered = await recoverOrphanedSessions(store, { now, ownSessionId: 'mine' });
    expect(recovered.map((r) => r.id)).toEqual(['dead']);
    expect(recovered[0]).toMatchObject({ wasInterrupted: true, durationMs: 42_000, mimeType: 'audio/webm' });
    expect(recovered[0]?.interruptionNote).toMatch(/recovered/i);
    expect(await store.hasAudio('dead')).toBe(true);

    const remaining = (await store.listSessions()).map((s) => s.id).sort();
    expect(remaining).toEqual(['alive-in-other-tab', 'mine']); // 'empty' is cleaned up, live ones untouched
  });
});

describe('lock-based recovery', () => {
  const base = {
    title: 'Call', mimeType: 'audio/webm', quality: 'standard' as const,
    startedAt: '2026-01-10T10:00:00.000Z', elapsedMs: 5000, chunkCount: 1, moments: [], wasInterrupted: false,
  };

  it('recovers a reloaded tab session immediately, even with a fresh heartbeat', async () => {
    const now = 5_000_000;
    await store.beginSession({ ...base, id: 'fresh', heartbeatAt: now - 500 });
    await store.appendChunk('fresh', 0, new Blob(['a']), { elapsedMs: 5000, heartbeatAt: now - 500, wasInterrupted: false });
    const recovered = await recoverOrphanedSessions(store, { now, isHeld: async () => false });
    expect(recovered.map((r) => r.id)).toEqual(['fresh']);
  });

  it('never touches a session another tab still holds, even with a stale heartbeat', async () => {
    const now = 5_000_000;
    await store.beginSession({ ...base, id: 'paused-elsewhere', heartbeatAt: now - 10 * SESSION_STALE_MS });
    await store.appendChunk('paused-elsewhere', 0, new Blob(['a']), { elapsedMs: 5000, heartbeatAt: now - 10 * SESSION_STALE_MS, wasInterrupted: false });
    const recovered = await recoverOrphanedSessions(store, { now, isHeld: async () => true });
    expect(recovered).toEqual([]);
    expect((await store.listSessions()).map((s) => s.id)).toEqual(['paused-elsewhere']);
  });
});

describe('audio retention', () => {
  const now = Date.parse('2026-03-01T00:00:00.000Z');
  const old = new Date(now - 40 * DAY).toISOString();
  const recent = new Date(now - 2 * DAY).toISOString();

  it('only selects completed recordings older than the retention window', () => {
    const list = [
      makeRecording('old-done', { status: 'completed', updatedAt: old }),
      makeRecording('recent-done', { status: 'completed', updatedAt: recent }),
      makeRecording('old-failed', { status: 'failed', failedStage: 'transcribe', updatedAt: old }),
      makeRecording('old-local', { status: 'local', updatedAt: old }),
      makeRecording('old-no-audio', { status: 'completed', updatedAt: old, hasLocalAudio: false, remotePath: null }),
    ];
    expect(dueForAudioDeletion(list, 30, now).map((r) => r.id)).toEqual(['old-done']);
    expect(dueForAudioDeletion(list, null, now)).toEqual([]);
  });

  it('deletes the cloud copy first, then the local audio, keeping the library entry', async () => {
    await seed('old-done', { status: 'completed', updatedAt: old, remotePath: 'user-1/old-done.webm', inCloud: true });
    await seed('old-failed', { status: 'failed', failedStage: 'transcribe', updatedAt: old, remotePath: 'user-1/x.webm', inCloud: true });
    const backend = new FakeBackend();

    const result = await applyAudioRetention(store, backend, 30, now);
    expect(result).toMatchObject({ cloudDeleted: 1, localDeleted: 1, errors: [] });
    expect(backend.deletedRemote).toEqual(['old-done']);
    expect(await store.hasAudio('old-done')).toBe(false);
    expect(await store.hasAudio('old-failed')).toBe(true);
    const kept = await store.getRecording('old-done');
    expect(kept).toMatchObject({ hasLocalAudio: false, remotePath: null });
    expect(kept?.audioDeletedAt).not.toBeNull();
  });

  it('keeps local audio if the cloud deletion fails', async () => {
    await seed('old-done', { status: 'completed', updatedAt: old, remotePath: 'user-1/old-done.webm', inCloud: true });
    const backend = new FakeBackend();
    backend.deleteRemoteAudio = async () => {
      throw new Error('offline');
    };
    const result = await applyAudioRetention(store, backend, 30, now);
    expect(result.errors).toHaveLength(1);
    expect(await store.hasAudio('old-done')).toBe(true);
  });
});

describe('cloud sync', () => {
  it('adds cloud-only recordings, applies newer metadata and never drops local audio', async () => {
    await seed('both', { updatedAt: '2026-01-10T10:00:00.000Z', title: 'Local title' });
    await seed('deleted-elsewhere', { inCloud: true, status: 'uploaded', remotePath: 'p', updatedAt: '2026-01-10T10:00:00.000Z' });
    await seed('busy', { updatedAt: '2026-01-10T10:00:00.000Z', title: 'Busy local' });
    const backend = new FakeBackend();
    backend.rows.set('both', makeRecording('both', { title: 'Cloud title', status: 'completed', inCloud: true, updatedAt: '2026-02-01T00:00:00.000Z' }));
    backend.rows.set('cloud-only', makeRecording('cloud-only', { status: 'completed', inCloud: true, hasLocalAudio: false, remotePath: 'u/cloud-only.webm' }));
    backend.rows.set('busy', makeRecording('busy', { title: 'Busy cloud', updatedAt: '2026-02-01T00:00:00.000Z', inCloud: true }));

    const result = await syncFromCloud(store, backend, (id) => id === 'busy');
    expect(result).toEqual({ added: 1, updated: 1, detached: 1 });

    expect(await store.getRecording('both')).toMatchObject({ title: 'Cloud title', status: 'completed', hasLocalAudio: true });
    expect(await store.getRecording('cloud-only')).toMatchObject({ hasLocalAudio: false, inCloud: true });
    expect(await store.getRecording('busy')).toMatchObject({ title: 'Busy local' });
    expect(await store.getRecording('deleted-elsewhere')).toMatchObject({ inCloud: false, status: 'local', remotePath: null, hasLocalAudio: true });
    expect(await store.hasAudio('deleted-elsewhere')).toBe(true);
  });
});
