import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnfinishedSession } from '../domain/types';
import { BrowserRecorder, type RecordedAudio, type RecorderStorePort } from './recorder';

class FakeTrack {
  label = 'Test microphone';
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  stop() {
    this.readyState = 'ended';
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getAudioTracks() {
    return [this.track];
  }
  getTracks() {
    return [this.track];
  }
}

let lastRecorder: FakeMediaRecorder | null = null;

class FakeMediaRecorder {
  static isTypeSupported(mime: string) {
    return mime === 'audio/webm;codecs=opus';
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    public stream: FakeStream,
    public options: { mimeType: string; audioBitsPerSecond: number },
  ) {
    lastRecorder = this;
  }
  start() {
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  requestData() {}
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['final']) });
    this.onstop?.();
  }
  emit(text = 'chunk') {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
  /** Simulates the browser killing the recorder without anyone asking. */
  dieSilently() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

interface Harness {
  recorder: BrowserRecorder;
  clock: { t: number };
  stream: FakeStream;
  store: RecorderStorePort & {
    chunks: Array<{ sessionId: string; index: number; size: number }>;
    sessions: UnfinishedSession[];
    sessionUpdates: Array<{ id: string; patch: Partial<UnfinishedSession> }>;
  };
  finished: RecordedAudio[];
  advance(ms: number): void;
}

function setup(options: { getUserMedia?: () => Promise<FakeStream> } = {}): Harness {
  const clock = { t: 1_000_000 };
  const stream = new FakeStream();
  const store = {
    chunks: [] as Array<{ sessionId: string; index: number; size: number }>,
    sessions: [] as UnfinishedSession[],
    sessionUpdates: [] as Array<{ id: string; patch: Partial<UnfinishedSession> }>,
    async beginSession(session: UnfinishedSession) {
      store.sessions.push(session);
    },
    async appendChunk(sessionId: string, index: number, blob: Blob) {
      store.chunks.push({ sessionId, index, size: blob.size });
    },
    async updateSession(id: string, patch: Partial<UnfinishedSession>) {
      store.sessionUpdates.push({ id, patch });
    },
  };
  const recorder = new BrowserRecorder({
    mediaDevices: { getUserMedia: options.getUserMedia ?? (async () => stream) } as never,
    MediaRecorderCtor: FakeMediaRecorder as never,
    store,
    now: () => clock.t,
    createMeter: () => null,
    doc: null,
    stallMs: 4000,
    tickMs: 1000,
  });
  const finished: RecordedAudio[] = [];
  recorder.onFinished((audio) => finished.push(audio));
  return {
    recorder,
    clock,
    stream,
    store,
    finished,
    advance(ms) {
      clock.t += ms;
      vi.advanceTimersByTime(Math.min(ms, 1000));
    },
  };
}

const START = { sessionId: 'session-1', title: 'Team sync', quality: 'standard' as const };

describe('BrowserRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastRecorder = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts, configures the bitrate for the chosen quality and persists chunks', async () => {
    const h = setup();
    await h.recorder.start(START);
    expect(h.recorder.getSnapshot().phase).toBe('recording');
    expect(lastRecorder?.options.audioBitsPerSecond).toBe(32_000);
    expect(lastRecorder?.options.mimeType).toBe('audio/webm;codecs=opus');
    expect(h.store.sessions[0]?.id).toBe('session-1');

    lastRecorder!.emit('aaaa');
    lastRecorder!.emit('bb');
    await vi.runAllTicks();
    await Promise.resolve();
    await h.recorder.stop();
    expect(h.store.chunks.map((c) => c.index)).toEqual([0, 1, 2]); // 2 chunks + final flush
  });

  it('reports a denied microphone as an error, never as recording', async () => {
    const h = setup({
      getUserMedia: async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      },
    });
    await expect(h.recorder.start(START)).rejects.toMatchObject({ code: 'MIC_DENIED' });
    const snap = h.recorder.getSnapshot();
    expect(snap.phase).toBe('error');
    expect(snap.error?.code).toBe('MIC_DENIED');
    expect(h.finished).toHaveLength(0);
  });

  it('flags capture as interrupted when audio stops arriving, then recovers when it resumes', async () => {
    const h = setup();
    await h.recorder.start(START);
    lastRecorder!.emit();
    h.advance(1000);
    expect(h.recorder.getSnapshot().phase).toBe('recording');

    // no data for > 4 s while the timer keeps running
    h.clock.t += 6000;
    vi.advanceTimersByTime(1000);
    const interrupted = h.recorder.getSnapshot();
    expect(interrupted.phase).toBe('interrupted');
    expect(interrupted.interruption?.reason).toBe('stalled');

    lastRecorder!.emit();
    expect(h.recorder.getSnapshot().phase).toBe('recording');
    expect(h.recorder.getSnapshot().interruptions).toHaveLength(1);
  });

  it('does not count a stalled gap as recorded time', async () => {
    const h = setup();
    await h.recorder.start(START);
    lastRecorder!.emit(); // last data at t0
    h.clock.t += 20_000; // page frozen for 20 s
    vi.advanceTimersByTime(1000);
    expect(h.recorder.getSnapshot().phase).toBe('interrupted');
    expect(h.recorder.getSnapshot().accumulatedMs).toBe(0);
  });

  it('shows a muted microphone as interrupted and recovers on unmute', async () => {
    const h = setup();
    await h.recorder.start(START);
    h.stream.track.muted = true;
    h.stream.track.onmute?.();
    expect(h.recorder.getSnapshot().phase).toBe('interrupted');
    expect(h.recorder.getSnapshot().interruption?.reason).toBe('track_muted');

    h.stream.track.muted = false;
    h.stream.track.onunmute?.();
    expect(h.recorder.getSnapshot().phase).toBe('recording');
  });

  it('salvages the audio and shows an error when the microphone track ends', async () => {
    const h = setup();
    await h.recorder.start(START);
    lastRecorder!.emit('hello');
    h.advance(2000);

    h.stream.track.readyState = 'ended';
    h.stream.track.onended?.();
    await vi.runAllTimersAsync();

    const snap = h.recorder.getSnapshot();
    expect(snap.phase).toBe('error');
    expect(snap.error?.code).toBe('mic_ended');
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0]?.wasInterrupted).toBe(true);
    expect(h.finished[0]?.interruptionNote).toContain('Recording ended early');
    expect(h.finished[0]?.blob.size).toBeGreaterThan(0);
  });

  it('treats an unexpected MediaRecorder stop as a failure instead of pretending to record', async () => {
    const h = setup();
    await h.recorder.start(START);
    lastRecorder!.emit('data');
    lastRecorder!.dieSilently();
    await vi.runAllTimersAsync();
    expect(h.recorder.getSnapshot().phase).toBe('error');
    expect(h.finished).toHaveLength(1);
  });

  it('pause and resume exclude paused time from the duration', async () => {
    const h = setup();
    await h.recorder.start(START);
    h.clock.t += 5000;
    h.recorder.pause();
    expect(h.recorder.getSnapshot().phase).toBe('paused');
    expect(lastRecorder!.state).toBe('paused');
    h.clock.t += 60_000;
    expect(h.recorder.resume()).toBe(true);
    h.clock.t += 3000;
    lastRecorder!.emit();
    const audio = await h.recorder.stop();
    expect(audio.durationMs).toBe(8000);
    expect(audio.mimeType).toBe('audio/webm');
    expect(h.recorder.getSnapshot().phase).toBe('idle');
    expect(h.stream.track.readyState).toBe('ended'); // microphone released
  });

  it('refuses to start twice', async () => {
    const h = setup();
    await h.recorder.start(START);
    await expect(h.recorder.start({ ...START, sessionId: 'session-2' })).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
  });

  it('discard releases the microphone and returns the session id', async () => {
    const h = setup();
    await h.recorder.start(START);
    lastRecorder!.emit();
    const id = await h.recorder.discard();
    expect(id).toBe('session-1');
    expect(h.recorder.getSnapshot().phase).toBe('idle');
    expect(h.stream.track.readyState).toBe('ended');
    expect(h.finished).toHaveLength(0);
  });

  it('keeps recording when browser storage fails but warns the user', async () => {
    const h = setup();
    h.store.appendChunk = async () => {
      throw new Error('QuotaExceededError');
    };
    await h.recorder.start(START);
    lastRecorder!.emit('data');
    await vi.advanceTimersByTimeAsync(10);
    expect(h.recorder.getSnapshot().phase).toBe('recording');
    expect(h.recorder.getSnapshot().persistenceWarning).toMatch(/storage may be full/);
    await h.recorder.discard(); // stop the intervals
  });

  it('marks moments at captured time (paused time excluded) and hands them over with the audio', async () => {
    const h = setup();
    expect(h.recorder.addMoment('key')).toBeNull(); // nothing is recording yet

    await h.recorder.start(START);
    h.clock.t += 5000;
    const first = h.recorder.addMoment('key', '  Launch date  ');
    expect(first).toMatchObject({ atMs: 5000, kind: 'key', text: 'Launch date' });

    h.recorder.pause();
    h.clock.t += 60_000;
    h.recorder.resume();
    h.clock.t += 2000;
    h.recorder.addMoment('action', 'Sam owns pricing');
    expect(h.recorder.getSnapshot().moments.map((m) => m.atMs)).toEqual([5000, 7000]);

    // each marker is also written to the crash-recovery record
    const lastPatch = h.store.sessionUpdates.at(-1);
    expect(lastPatch?.id).toBe('session-1');
    expect(lastPatch?.patch.moments).toHaveLength(2);

    lastRecorder!.emit();
    const audio = await h.recorder.stop();
    expect(audio.moments.map((m) => [m.atMs, m.kind])).toEqual([
      [5000, 'key'],
      [7000, 'action'],
    ]);
    expect(h.recorder.addMoment('note', 'too late')).toBeNull();
  });

  it('can remove a moment', async () => {
    const h = setup();
    await h.recorder.start(START);
    const moment = h.recorder.addMoment('question', 'Why?');
    h.recorder.removeMoment(moment!.id);
    expect(h.recorder.getSnapshot().moments).toEqual([]);
    await h.recorder.discard();
  });

  it('exposes measured capture-health facts', async () => {
    const h = setup();
    await h.recorder.start(START);
    expect(h.recorder.getSnapshot()).toMatchObject({ micLabel: 'Test microphone', micMuted: false, savedChunks: 0, lastSavedAt: null });

    h.clock.t += 1000;
    lastRecorder!.emit('chunk');
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = h.recorder.getSnapshot();
    expect(snapshot.savedChunks).toBe(1);
    expect(snapshot.lastSavedAt).toBe(h.clock.t);

    h.stream.track.muted = true;
    h.stream.track.onmute?.();
    expect(h.recorder.getSnapshot().micMuted).toBe(true);
    await h.recorder.discard();
  });
});
