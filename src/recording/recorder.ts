import { QUALITY_BITRATE, baseMimeType, pickRecorderMimeType } from '../domain/audioMime';
import {
  INITIAL_RECORDER_STATE,
  elapsedMs,
  isSessionLive,
  isStalled,
  recorderReducer,
  type RecorderEvent,
  type RecorderMachineState,
} from '../domain/recordingMachine';
import type { Moment, MomentKind, RecordingQuality, UnfinishedSession } from '../domain/types';
import { AppError, errorMessage, micErrorFrom } from '../lib/errors';
import { newId } from '../lib/id';
import { createLevelMeter, type LevelMeter } from './levelMeter';
import { holdSessionLock } from './sessionLock';

export interface RecordedAudio {
  sessionId: string;
  title: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  quality: RecordingQuality;
  startedAt: string;
  wasInterrupted: boolean;
  interruptionNote: string | null;
  moments: Moment[];
}

export interface RecorderStorePort {
  beginSession(session: UnfinishedSession): Promise<void>;
  appendChunk(
    sessionId: string,
    index: number,
    blob: Blob,
    progress: { elapsedMs: number; heartbeatAt: number; wasInterrupted: boolean },
  ): Promise<void>;
  updateSession(sessionId: string, patch: Partial<UnfinishedSession>): Promise<void>;
}

export interface RecorderDeps {
  mediaDevices: { getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> };
  MediaRecorderCtor: typeof MediaRecorder;
  store: RecorderStorePort;
  now?: () => number;
  createMeter?: (stream: MediaStream) => LevelMeter | null;
  /** No audio data for this long while "recording" => the recording is reported as interrupted. */
  stallMs?: number;
  tickMs?: number;
  /** Web Locks manager used to mark the session as alive (null disables; default navigator.locks). */
  locks?: Pick<LockManager, 'request'> | null;
  /** Document to watch for visibility changes (injectable for tests). */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
}

export interface RecorderSnapshot extends RecorderMachineState {
  mimeType: string | null;
  quality: RecordingQuality | null;
  /** Set when chunks could not be written to browser storage (crash recovery unavailable). */
  persistenceWarning: string | null;
  /** Epoch ms when the newest audio chunk was confirmed written to this device, or null. */
  lastSavedAt: number | null;
  /** Number of ~1 s chunks safely stored so far. */
  savedChunks: number;
  /** Label of the microphone in use (may be empty until the user has granted access). */
  micLabel: string | null;
  /** The browser reports the microphone track as muted. */
  micMuted: boolean;
  moments: Moment[];
}

const TIMESLICE_MS = 1000;
const STOP_TIMEOUT_MS = 4000;

type Listener = () => void;

/**
 * Browser recorder: getUserMedia + MediaRecorder with 1 s chunks persisted to IndexedDB.
 *
 * It never reports `recording` unless the MediaRecorder is running, the microphone track is
 * live and unmuted, and audio data is arriving. If capture silently stops (device unplugged,
 * OS reclaims the microphone, tab frozen) the phase flips to `interrupted` / `error` and the
 * audio captured so far is saved.
 */
export class BrowserRecorder {
  private machine: RecorderMachineState = INITIAL_RECORDER_STATE;
  private snapshot: RecorderSnapshot;
  private readonly listeners = new Set<Listener>();
  private readonly levelListeners = new Set<(level: number) => void>();
  private readonly finishedListeners = new Set<(audio: RecordedAudio) => void>();

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private meter: LevelMeter | null = null;
  private chunks: Blob[] = [];
  private chunkIndex = 0;
  private persistQueue: Promise<void> = Promise.resolve();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private mimeType: string | null = null;
  private quality: RecordingQuality | null = null;
  private startedAtIso = '';
  private persistenceWarning: string | null = null;
  private lastSavedAt: number | null = null;
  private savedChunks = 0;
  private micLabel: string | null = null;
  private moments: Moment[] = [];
  private finishing = false;
  private stopWaiter: (() => void) | null = null;
  private releaseSessionLock: (() => void) | null = null;

  private readonly now: () => number;
  private readonly stallMs: number;
  private readonly tickMs: number;
  private readonly doc: RecorderDeps['doc'];

  private readonly onVisibility = () => {
    const hidden = this.doc?.visibilityState === 'hidden';
    this.dispatch({ type: 'VISIBILITY', hidden, now: this.now() });
    if (!hidden) {
      // Back on screen: flush buffered data and verify capture is still alive right away.
      try {
        if (this.recorder?.state === 'recording') this.recorder.requestData();
      } catch {
        /* recorder may be inactive */
      }
      this.tick();
    }
  };

  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.stallMs = deps.stallMs ?? 4000;
    this.tickMs = deps.tickMs ?? 1000;
    this.doc = deps.doc === undefined ? (typeof document !== 'undefined' ? document : null) : deps.doc;
    this.snapshot = this.buildSnapshot();
  }

  // --- subscriptions (useSyncExternalStore compatible) -------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RecorderSnapshot => this.snapshot;

  subscribeLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  /** Fired exactly once per session with the recorded audio (user stop, or salvage after failure). */
  onFinished(listener: (audio: RecordedAudio) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  elapsed(): number {
    return elapsedMs(this.machine, this.now());
  }

  // --- commands ----------------------------------------------------------------

  async start(options: { sessionId: string; title: string; quality: RecordingQuality }): Promise<void> {
    if (this.machine.phase !== 'idle' && this.machine.phase !== 'error') {
      throw new AppError('ALREADY_RUNNING', 'A recording is already in progress.');
    }
    this.dispatch({ type: 'START_REQUESTED', sessionId: options.sessionId, title: options.title, now: this.now() });

    let stream: MediaStream;
    let mimeType: string | null;
    try {
      mimeType = pickRecorderMimeType((m) => this.deps.MediaRecorderCtor.isTypeSupported(m));
      if (!mimeType) throw new AppError('UNSUPPORTED_BROWSER', 'This browser has no supported audio recording format.');
      stream = await this.deps.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : micErrorFrom(error);
      this.dispatch({ type: 'START_FAILED', error: { code: appError.code, message: appError.message } });
      throw appError;
    }

    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      const error = new AppError('MIC_NOT_FOUND', 'No microphone track was available.');
      this.dispatch({ type: 'START_FAILED', error: { code: error.code, message: error.message } });
      throw error;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new this.deps.MediaRecorderCtor(stream, {
        mimeType,
        audioBitsPerSecond: QUALITY_BITRATE[options.quality],
      });
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      const appError = new AppError('UNSUPPORTED_BROWSER', 'The recorder could not be created in this browser.', { cause: error });
      this.dispatch({ type: 'START_FAILED', error: { code: appError.code, message: appError.message } });
      throw appError;
    }

    this.stream = stream;
    this.recorder = recorder;
    this.mimeType = mimeType;
    this.quality = options.quality;
    this.chunks = [];
    this.chunkIndex = 0;
    this.persistQueue = Promise.resolve();
    this.persistenceWarning = null;
    this.lastSavedAt = null;
    this.savedChunks = 0;
    this.moments = [];
    this.micLabel = track.label || null;
    this.finishing = false;
    this.startedAtIso = new Date(this.now()).toISOString();

    try {
      await this.deps.store.beginSession({
        id: options.sessionId,
        title: options.title,
        mimeType,
        quality: options.quality,
        startedAt: this.startedAtIso,
        elapsedMs: 0,
        heartbeatAt: this.now(),
        chunkCount: 0,
        wasInterrupted: false,
        moments: [],
      });
    } catch {
      this.persistenceWarning =
        'Auto-save to this browser is unavailable. Keep this tab open: if it closes, the recording cannot be recovered.';
    }

    this.wire(recorder, track);
    try {
      recorder.start(TIMESLICE_MS);
    } catch (error) {
      this.teardown();
      const appError = micErrorFrom(error);
      this.dispatch({ type: 'START_FAILED', error: { code: appError.code, message: appError.message } });
      throw appError;
    }

    this.releaseSessionLock = holdSessionLock(options.sessionId, this.deps.locks);
    this.meter = (this.deps.createMeter ?? createLevelMeter)(stream);
    this.dispatch({ type: 'STARTED', now: this.now() });
    this.startTimers();
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
  }

  pause(): void {
    if (this.machine.phase !== 'recording' || !this.recorder) return;
    try {
      this.recorder.pause();
    } catch (error) {
      void this.fail('recorder_pause_failed', `Could not pause: ${errorMessage(error)}`);
      return;
    }
    this.dispatch({ type: 'PAUSE', now: this.now() });
  }

  /**
   * Resumes a paused recording, or tries to recover an interrupted one.
   * Returns true when capture is verifiably running again.
   */
  resume(): boolean {
    const recorder = this.recorder;
    const track = this.stream?.getAudioTracks()[0];
    if (!recorder || !track) return false;

    if (track.readyState !== 'live') {
      void this.fail('mic_ended', 'The microphone was disconnected, so the recording could not continue.');
      return false;
    }

    if (this.machine.phase === 'paused') {
      try {
        recorder.resume();
      } catch (error) {
        void this.fail('recorder_resume_failed', `Could not resume: ${errorMessage(error)}`);
        return false;
      }
      this.dispatch({ type: 'RESUME', now: this.now() });
      return true;
    }

    if (this.machine.phase === 'interrupted') {
      if (recorder.state === 'paused') {
        try {
          recorder.resume();
        } catch {
          return false;
        }
      }
      if (recorder.state === 'recording' && !track.muted) {
        this.dispatch({ type: 'RECOVERED', now: this.now() });
        return true;
      }
    }
    return false;
  }

  /**
   * Drops a marker at the current point of the recording. Only while a session is live and
   * not already stopping. Persisted with the crash-recovery record so it survives a reload.
   */
  addMoment(kind: MomentKind, text = ''): Moment | null {
    const phase = this.machine.phase;
    if (phase !== 'recording' && phase !== 'paused' && phase !== 'interrupted') return null;
    if (this.moments.length >= 500) return null;
    const moment: Moment = {
      id: newId(),
      atMs: Math.round(elapsedMs(this.machine, this.now())),
      kind,
      text: text.trim().slice(0, 280),
    };
    this.moments = [...this.moments, moment];
    this.persistMoments();
    this.notifyExtras();
    return moment;
  }

  removeMoment(id: string): void {
    const next = this.moments.filter((m) => m.id !== id);
    if (next.length === this.moments.length) return;
    this.moments = next;
    this.persistMoments();
    this.notifyExtras();
  }

  private persistMoments(): void {
    const sessionId = this.machine.sessionId;
    if (!sessionId) return;
    void this.deps.store.updateSession(sessionId, { moments: this.moments }).catch(() => undefined);
  }

  rename(title: string): void {
    this.dispatch({ type: 'RENAME', title });
    const sessionId = this.machine.sessionId;
    if (sessionId && isSessionLive(this.machine)) {
      // Keep the crash-recovery record in step so a recovered recording has the user's title.
      void this.deps.store.updateSession(sessionId, { title }).catch(() => undefined);
    }
  }

  /** Stops, flushes all chunks to storage and returns the finished audio. */
  async stop(): Promise<RecordedAudio> {
    const phase = this.machine.phase;
    if (phase !== 'recording' && phase !== 'paused' && phase !== 'interrupted') {
      throw new AppError('UNKNOWN', 'There is no active recording to stop.');
    }
    this.finishing = true;
    this.dispatch({ type: 'STOP_REQUESTED', now: this.now() });
    await this.haltRecorder();
    const audio = this.buildAudio(null);
    this.teardown();
    this.dispatch({ type: 'STOPPED' });
    this.emitFinished(audio);
    return audio;
  }

  /**
   * Stops capture and drops the in-memory audio. Returns the discarded session id so the
   * caller can delete its stored chunks. The caller must confirm with the user first.
   */
  async discard(): Promise<string | null> {
    const sessionId = this.machine.sessionId;
    this.finishing = true;
    await this.haltRecorder();
    this.teardown();
    this.chunks = [];
    this.dispatch({ type: 'RESET' });
    this.finishing = false;
    return sessionId;
  }

  /** Clear an `error` phase after the UI has shown it. */
  acknowledgeError(): void {
    if (this.machine.phase === 'error') this.dispatch({ type: 'RESET' });
  }

  dispose(): void {
    this.teardown();
    this.listeners.clear();
    this.levelListeners.clear();
    this.finishedListeners.clear();
  }

  // --- internals -----------------------------------------------------------------

  private dispatch(event: RecorderEvent): void {
    const next = recorderReducer(this.machine, event);
    if (next === this.machine) return;
    this.machine = next;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): RecorderSnapshot {
    return {
      ...this.machine,
      mimeType: this.mimeType,
      quality: this.quality,
      persistenceWarning: this.persistenceWarning,
      lastSavedAt: this.lastSavedAt,
      savedChunks: this.savedChunks,
      micLabel: this.micLabel,
      micMuted: this.stream?.getAudioTracks()[0]?.muted ?? false,
      moments: this.moments,
    };
  }

  private notifyExtras(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private wire(recorder: MediaRecorder, track: MediaStreamTrack): void {
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        const index = this.chunkIndex++;
        this.chunks.push(event.data);
        this.enqueuePersist(index, event.data);
      }
      const now = this.now();
      this.dispatch({ type: 'CHUNK', now });
      const current = this.machine;
      if (
        current.phase === 'interrupted' &&
        current.interruption?.reason === 'stalled' &&
        recorder.state === 'recording' &&
        track.readyState === 'live' &&
        !track.muted
      ) {
        this.dispatch({ type: 'RECOVERED', now });
      }
    };

    recorder.onerror = (event: Event) => {
      const detail = (event as Event & { error?: unknown }).error;
      void this.fail('recorder_error', `The browser reported a recording error: ${errorMessage(detail, 'unknown error')}`);
    };

    recorder.onstop = () => {
      if (this.stopWaiter) {
        const waiter = this.stopWaiter;
        this.stopWaiter = null;
        waiter();
        return;
      }
      if (!this.finishing) {
        void this.fail('recorder_stopped', 'The browser stopped the recording unexpectedly.');
      }
    };

    track.onended = () => {
      if (!this.finishing) void this.fail('mic_ended', 'The microphone was disconnected or taken by another app.');
    };
    track.onmute = () => {
      if (this.machine.phase === 'recording') {
        this.dispatch({
          type: 'INTERRUPTED',
          reason: 'track_muted',
          message: 'The microphone was muted by the browser or system (another app, a call, or the device).',
          now: this.now(),
        });
      }
    };
    track.onunmute = () => {
      if (this.machine.phase === 'interrupted' && this.machine.interruption?.reason === 'track_muted') {
        this.resume();
      }
    };
  }

  private enqueuePersist(index: number, blob: Blob): void {
    const now = this.now();
    const progress = {
      elapsedMs: elapsedMs(this.machine, now),
      heartbeatAt: now,
      wasInterrupted: this.machine.interruptions.length > 0,
    };
    const sessionId = this.machine.sessionId;
    if (!sessionId || this.persistenceWarning) return;
    this.persistQueue = this.persistQueue
      .then(async () => {
        await this.deps.store.appendChunk(sessionId, index, blob, progress);
        this.lastSavedAt = this.now();
        this.savedChunks += 1;
        this.notifyExtras();
      })
      .catch(() => {
        this.persistenceWarning =
          'The browser could not save recording data (storage may be full). Stop and download soon so nothing is lost.';
        this.notifyExtras();
      });
  }

  private startTimers(): void {
    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    this.levelTimer = setInterval(() => {
      if (!this.meter || this.machine.phase !== 'recording') return;
      const level = this.meter.read();
      for (const listener of this.levelListeners) listener(level);
    }, 100);
  }

  private tick(): void {
    if (!isSessionLive(this.machine) || this.finishing) return;
    const now = this.now();
    this.tickCount += 1;
    const track = this.stream?.getAudioTracks()[0];

    if (track && track.readyState === 'ended') {
      void this.fail('mic_ended', 'The microphone was disconnected or taken by another app.');
      return;
    }
    if (this.machine.phase === 'recording' && this.recorder && this.recorder.state === 'inactive') {
      void this.fail('recorder_stopped', 'The browser stopped the recording unexpectedly.');
      return;
    }
    if (isStalled(this.machine, now, this.stallMs)) {
      // Count the gap as non-recorded time: settle at the last time data was seen.
      this.dispatch({
        type: 'INTERRUPTED',
        reason: 'stalled',
        message: 'Audio stopped arriving (the page may have been suspended or the microphone taken by the system).',
        now: this.machine.lastChunkAt ?? now,
      });
    }
    if (this.machine.phase !== 'recording' && this.tickCount % 5 === 0 && this.machine.sessionId) {
      // Chunks are not flowing while paused/interrupted; keep the session marked as live.
      void this.deps.store
        .updateSession(this.machine.sessionId, {
          heartbeatAt: now,
          elapsedMs: elapsedMs(this.machine, now),
          wasInterrupted: this.machine.interruptions.length > 0,
        })
        .catch(() => undefined);
    }
  }

  /** Capture cannot continue. Save everything captured so far and report the error truthfully. */
  private async fail(code: string, message: string): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    this.dispatch({ type: 'FAILED', error: { code, message }, now: this.now() });
    await this.haltRecorder();
    const audio = this.chunks.length > 0 ? this.buildAudio(message) : null;
    this.teardown();
    if (audio) this.emitFinished(audio);
  }

  /** Stops the MediaRecorder (if running), waits for its final chunk, then drains the persist queue. */
  private async haltRecorder(): Promise<void> {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stopped = new Promise<void>((resolve) => {
        this.stopWaiter = resolve;
        timeout = setTimeout(resolve, STOP_TIMEOUT_MS);
      });
      try {
        recorder.stop();
      } catch {
        this.stopWaiter = null;
      }
      await stopped;
      clearTimeout(timeout);
      this.stopWaiter = null;
    }
    await this.persistQueue.catch(() => undefined);
  }

  private buildAudio(failureNote: string | null): RecordedAudio {
    const mimeType = baseMimeType(this.mimeType ?? 'audio/webm');
    const interruptions = this.machine.interruptions;
    const notes: string[] = [];
    if (failureNote) notes.push(`Recording ended early: ${failureNote}`);
    if (interruptions.length > 0) {
      notes.push(
        `Capture was interrupted ${interruptions.length} time${interruptions.length === 1 ? '' : 's'}: ${[
          ...new Set(interruptions.map((i) => i.message)),
        ].join(' ')}`,
      );
    }
    return {
      sessionId: this.machine.sessionId ?? '',
      title: this.machine.title,
      blob: new Blob(this.chunks, { type: mimeType }),
      mimeType,
      durationMs: Math.round(this.machine.accumulatedMs),
      quality: this.quality ?? 'standard',
      startedAt: this.startedAtIso,
      wasInterrupted: interruptions.length > 0 || failureNote !== null,
      interruptionNote: notes.length ? notes.join(' ') : null,
      moments: [...this.moments],
    };
  }

  private emitFinished(audio: RecordedAudio): void {
    for (const listener of this.finishedListeners) listener(audio);
  }

  private teardown(): void {
    this.releaseSessionLock?.();
    this.releaseSessionLock = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.tickTimer = null;
    this.levelTimer = null;
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.meter?.close();
    this.meter = null;
    const recorder = this.recorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }
    const track = this.stream?.getAudioTracks()[0];
    if (track) {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
    }
    this.stream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* already stopped */
      }
    });
    this.stream = null;
    this.recorder = null;
  }
}
