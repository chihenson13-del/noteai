import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type UnfinishedSession } from '../domain/types';
import { makeRecording as recording } from '../test/factories';
import { LocalStore } from './localStore';

let store: LocalStore;
let counter = 0;

beforeEach(() => {
  counter += 1;
  store = new LocalStore(`noteai-test-${counter}`);
});

afterEach(async () => {
  await store.close();
});

describe('LocalStore', () => {
  it('round-trips recordings newest first and updates atomically', async () => {
    await store.putRecording(recording('a', { createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.putRecording(recording('b', { createdAt: '2026-01-02T00:00:00.000Z' }));
    expect((await store.listRecordings()).map((r) => r.id)).toEqual(['b', 'a']);

    const updated = await store.updateRecording('a', { title: 'Renamed', status: 'uploading' });
    expect(updated.title).toBe('Renamed');
    expect((await store.getRecording('a'))?.status).toBe('uploading');
    await expect(store.updateRecording('missing', { title: 'x' })).rejects.toThrow();
  });

  it('keeps audio blobs and deletes everything derived from a recording', async () => {
    await store.putRecording(recording('a'));
    await store.putAudio('a', new Blob(['audio-bytes'], { type: 'audio/webm' }), 'audio/webm');
    await store.putTranscript({ recordingId: 'a', language: 'en', text: 'hello world', segments: [], provider: 'p', model: 'm', createdAt: '' });
    await store.replaceActionItems('a', [{ id: 'i1', recordingId: 'a', text: 'Do it', assignee: null, dueDate: null, done: false, sortOrder: 0, atMs: null }]);

    expect(await store.hasAudio('a')).toBe(true);
    expect((await store.getAudio('a'))?.size).toBe('audio-bytes'.length);
    expect((await store.transcriptTextIndex()).get('a')).toBe('hello world');

    await store.deleteRecording('a');
    expect(await store.getRecording('a')).toBeUndefined();
    expect(await store.hasAudio('a')).toBe(false);
    expect(await store.getTranscript('a')).toBeUndefined();
    expect(await store.listActionItems('a')).toEqual([]);
  });

  it('replaces action items for a recording without touching others', async () => {
    const item = (id: string, recordingId: string, order: number) => ({
      id,
      recordingId,
      text: id,
      assignee: null,
      dueDate: null,
      done: false,
      sortOrder: order, atMs: null,
    });
    await store.replaceActionItems('a', [item('a1', 'a', 1), item('a0', 'a', 0)]);
    await store.replaceActionItems('b', [item('b1', 'b', 0)]);
    expect((await store.listActionItems('a')).map((i) => i.id)).toEqual(['a0', 'a1']);
    await store.replaceActionItems('a', []);
    expect(await store.listActionItems('a')).toEqual([]);
    expect(await store.listActionItems('b')).toHaveLength(1);
  });

  it('stores settings and falls back to defaults', async () => {
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    await store.saveSettings({ ...DEFAULT_SETTINGS, quality: 'high', uploadConsentAt: '2026-01-01T00:00:00.000Z' });
    const loaded = await store.getSettings();
    expect(loaded.quality).toBe('high');
    expect(loaded.uploadConsentAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('persists session chunks in order and removes them with the session', async () => {
    const session: UnfinishedSession = {
      id: 's',
      title: 'T',
      mimeType: 'audio/webm',
      quality: 'standard',
      startedAt: '2026-01-10T10:00:00.000Z',
      elapsedMs: 0,
      heartbeatAt: 1,
      chunkCount: 0, moments: [],
      wasInterrupted: false,
    };
    await store.beginSession(session);
    await store.appendChunk('s', 1, new Blob(['two']), { elapsedMs: 2000, heartbeatAt: 5, wasInterrupted: false });
    await store.appendChunk('s', 0, new Blob(['one']), { elapsedMs: 1000, heartbeatAt: 4, wasInterrupted: true });

    const [stored] = await store.listSessions();
    expect(stored?.chunkCount).toBe(2);
    expect(stored?.heartbeatAt).toBe(4); // last write wins, as written
    const chunks = await store.loadSessionChunks('s');
    expect(await new Blob(chunks).text()).toBe('onetwo');

    await store.deleteSession('s');
    expect(await store.listSessions()).toEqual([]);
    expect(await store.loadSessionChunks('s')).toEqual([]);
  });

  it('sums local audio bytes from recording metadata', async () => {
    await store.putRecording(recording('a', { sizeBytes: 100 }));
    await store.putRecording(recording('b', { sizeBytes: 50, hasLocalAudio: false }));
    expect(await store.localAudioBytes()).toBe(100);
  });
});
