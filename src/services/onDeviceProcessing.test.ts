import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '../data/localStore';
import { DEFAULT_SETTINGS } from '../domain/types';
import type { AppSettings, Recording } from '../domain/types';
import type { OnDeviceProgress, SpeechEngine, SpeechResult } from '../ondevice/transcriber';
import { makeRecording } from '../test/factories';
import { OnDeviceProcessing } from './onDeviceProcessing';
import { localAsk } from './localAsk';

let store: LocalStore;
let counter = 0;

class FakeEngine implements SpeechEngine {
  calls = 0;
  supported = true;
  result: SpeechResult = {
    durationMs: 30_000,
    silent: false,
    segments: [
      { startMs: 0, endMs: 5000, text: 'We decided to ship the beta on Friday.' },
      { startMs: 5000, endMs: 10_000, text: 'Maria will email the customers about the beta.' },
    ],
  };
  fail: Error | null = null;
  wait: Promise<void> | null = null;

  isSupported() {
    return this.supported;
  }
  async transcribe(
    _audio: Blob,
    _options: unknown,
    onProgress: (progress: OnDeviceProgress) => void,
    signal: AbortSignal,
  ): Promise<SpeechResult> {
    this.calls += 1;
    onProgress({ phase: 'loading-model', pct: 50 });
    if (this.wait) await this.wait;
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (this.fail) throw this.fail;
    onProgress({ phase: 'transcribing', pct: 100 });
    return this.result;
  }
}

async function seed(overrides: Partial<Recording> = {}): Promise<Recording> {
  counter += 1;
  const recording = makeRecording(`rec-${counter}`, { status: 'local', hasLocalAudio: true, durationMs: 30_000, ...overrides });
  await store.putRecording(recording);
  await store.putAudio(recording.id, new Blob(['audio-bytes'], { type: 'audio/webm' }), 'audio/webm');
  return recording;
}

function setup(engine: FakeEngine, settings: Partial<AppSettings> = {}) {
  const changed: Recording[] = [];
  const progress: Array<[string, unknown]> = [];
  const service = new OnDeviceProcessing({
    store,
    engine,
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    onRecordingChanged: (r) => changed.push(r),
    onProgress: (id, p) => progress.push([id, p]),
  });
  return { service, changed, progress };
}

beforeEach(() => {
  store = new LocalStore(`ondevice-${Math.random()}`);
});

describe('OnDeviceProcessing', () => {
  it('transcribes, stores transcript, notes and action items, and completes', async () => {
    const recording = await seed();
    const engine = new FakeEngine();
    const { service, changed } = setup(engine);

    const done = await service.run(recording.id);

    expect(done.status).toBe('completed');
    expect(changed.map((r) => r.status)).toEqual(['transcribing', 'summarizing', 'completed']);
    const transcript = await store.getTranscript(recording.id);
    expect(transcript?.provider).toBe('on-device');
    expect(transcript?.text).toContain('ship the beta on Friday');
    const notes = await store.getNotes(recording.id);
    expect(notes?.provider).toBe('on-device');
    expect(notes?.decisions.map((d) => d.text)).toEqual(['We decided to ship the beta on Friday.']);
    const items = await store.listActionItems(recording.id);
    expect(items.map((i) => i.text)).toEqual(['Maria will email the customers about the beta.']);
    // The original audio is untouched.
    expect(await store.hasAudio(recording.id)).toBe(true);
  });

  it('never fabricates: a silent recording fails with a clear message and no transcript', async () => {
    const recording = await seed();
    const engine = new FakeEngine();
    engine.result = { durationMs: 30_000, silent: true, segments: [] };
    const { service } = setup(engine);

    await expect(service.run(recording.id)).rejects.toThrow(/no sound was detected/i);
    const after = await store.getRecording(recording.id);
    expect(after?.status).toBe('failed');
    expect(after?.failedStage).toBe('transcribe');
    expect(await store.getTranscript(recording.id)).toBeUndefined();
    expect(await store.getNotes(recording.id)).toBeUndefined();
    expect(await store.hasAudio(recording.id)).toBe(true);
  });

  it('records engine failures so they can be retried, and keeps the audio', async () => {
    const recording = await seed();
    const engine = new FakeEngine();
    engine.fail = new Error('model files could not be loaded');
    const { service } = setup(engine);

    await expect(service.run(recording.id)).rejects.toThrow();
    const failed = await store.getRecording(recording.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.errorMessage).toMatch(/could not be loaded/);

    engine.fail = null;
    const retried = await service.run(recording.id);
    expect(retried.status).toBe('completed');
  });

  it('runs one job per recording at a time', async () => {
    const recording = await seed();
    const engine = new FakeEngine();
    let release!: () => void;
    engine.wait = new Promise((resolve) => (release = resolve));
    const { service } = setup(engine);

    const first = service.run(recording.id);
    const second = service.run(recording.id);
    expect(service.isRunning(recording.id)).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(engine.calls).toBe(1);
    expect(service.isRunning(recording.id)).toBe(false);
  });

  it('puts the recording back when cancelled, without an error status', async () => {
    const recording = await seed();
    const engine = new FakeEngine();
    let release!: () => void;
    engine.wait = new Promise((resolve) => (release = resolve));
    const { service } = setup(engine);

    const job = service.run(recording.id);
    await vi.waitFor(async () => expect((await store.getRecording(recording.id))?.status).toBe('transcribing'));
    service.cancel(recording.id);
    release();
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    const after = await store.getRecording(recording.id);
    expect(after?.status).toBe('local');
    expect(after?.errorMessage).toBeNull();
  });

  it('rebuilds only the notes from a stored transcript', async () => {
    const recording = await seed();
    const engine = new FakeEngine();
    const { service } = setup(engine, { summaryLength: 'brief' });
    await service.run(recording.id);
    expect(engine.calls).toBe(1);

    const rebuilt = await service.run(recording.id, { summarizeOnly: true });
    expect(rebuilt.status).toBe('completed');
    expect(engine.calls).toBe(1);
  });

  it('refuses when the audio is no longer stored', async () => {
    const recording = await seed();
    await store.deleteAudio(recording.id);
    const { service } = setup(new FakeEngine());
    await expect(service.run(recording.id)).rejects.toThrow(/no longer stored/i);
  });

  it('refuses on browsers that cannot run the engine', async () => {
    const recording = await seed();
    const engine = new FakeEngine();
    engine.supported = false;
    const { service } = setup(engine);
    await expect(service.run(recording.id)).rejects.toThrow(/cannot run on-device transcription/i);
    expect(engine.calls).toBe(0);
  });

  it('marks recordings left in a transient state by a closed tab as retryable', async () => {
    const stuck = await seed({ status: 'transcribing' });
    const cloud = await seed({ status: 'transcribing', remotePath: 'u/x.webm' });
    const fine = await seed({ status: 'local' });
    const { service } = setup(new FakeEngine());

    const count = await service.recoverInterrupted(await store.listRecordings());

    expect(count).toBe(1);
    expect((await store.getRecording(stuck.id))?.status).toBe('failed');
    expect((await store.getRecording(stuck.id))?.errorMessage).toMatch(/interrupted/i);
    expect((await store.getRecording(cloud.id))?.status).toBe('transcribing');
    expect((await store.getRecording(fine.id))?.status).toBe('local');
  });
});

describe('localAsk', () => {
  it('returns matching passages with times, and "not found" otherwise', async () => {
    const recording = await seed({ title: 'Launch meeting' });
    const engine = new FakeEngine();
    const { service } = setup(engine);
    await service.run(recording.id);
    const transcript = (await store.getTranscript(recording.id))!;
    const recordings = await store.listRecordings();

    const hit = localAsk({ question: 'When do we ship the beta?' }, recordings, () => transcript);
    expect(hit.found).toBe(true);
    expect(hit.sources[0]).toMatchObject({ recordingTitle: 'Launch meeting', atMs: 0 });
    expect(hit.sources[0]!.quote).toContain('ship the beta');

    const miss = localAsk({ question: 'What is the weather forecast?' }, recordings, () => transcript);
    expect(miss.found).toBe(false);
    expect(miss.searched).toBe(1);
  });
});
