import type { LocalStore } from '../data/localStore';
import { buildExtractiveNotes, cleanSegments } from '../domain/extractiveNotes';
import { isProcessing } from '../domain/status';
import type { AppSettings, ProcessingStage, Recording, RecordingStatus, Transcript } from '../domain/types';
import { AppError, errorMessage } from '../lib/errors';
import { newId } from '../lib/id';
import type { OnDevicePhase, SpeechEngine } from '../ondevice/transcriber';

type Store = Pick<
  LocalStore,
  'getRecording' | 'updateRecording' | 'getAudio' | 'getTranscript' | 'putTranscript' | 'putNotes' | 'replaceActionItems'
>;

export interface OnDeviceProgressUpdate {
  phase: OnDevicePhase | 'notes';
  pct: number | null;
}

export interface OnDeviceDeps {
  store: Store;
  engine: SpeechEngine;
  getSettings: () => AppSettings;
  onRecordingChanged?: (recording: Recording) => void;
  /** Called with null when a job ends. */
  onProgress?: (recordingId: string, progress: OnDeviceProgressUpdate | null) => void;
  /** Called after a transcript was stored, so search indexes can refresh. */
  onTranscriptStored?: () => void;
  now?: () => Date;
}

export interface OnDeviceRunOptions {
  /** Rebuild the notes from the stored transcript only. */
  summarizeOnly?: boolean;
}

/**
 * Transcribes and summarizes a recording entirely on this device.
 *
 *  - The original audio is only ever read. No stage or failure modifies or deletes it.
 *  - One job per recording at a time.
 *  - Every outcome is persisted: completed, failed (with the stage and a message), or put back
 *    to "on this device" when the user cancels.
 *  - Nothing is ever invented: an empty or silent recording is reported as such.
 */
export class OnDeviceProcessing {
  private readonly jobs = new Map<string, { promise: Promise<Recording>; abort: AbortController }>();

  constructor(private readonly deps: OnDeviceDeps) {}

  isSupported(): boolean {
    return this.deps.engine.isSupported();
  }

  isRunning(recordingId: string): boolean {
    return this.jobs.has(recordingId);
  }

  run(recordingId: string, options: OnDeviceRunOptions = {}): Promise<Recording> {
    const existing = this.jobs.get(recordingId);
    if (existing) return existing.promise;
    const abort = new AbortController();
    const promise = this.execute(recordingId, options, abort.signal).finally(() => {
      this.jobs.delete(recordingId);
      this.deps.onProgress?.(recordingId, null);
    });
    this.jobs.set(recordingId, { promise, abort });
    return promise;
  }

  cancel(recordingId: string): void {
    this.jobs.get(recordingId)?.abort.abort();
  }

  /**
   * After a reload, a recording can still say "transcribing" although the tab that was doing it is
   * gone. Those are marked as failed so the user gets a Retry button instead of an endless spinner.
   * Cloud jobs (the audio has a remote path) are left to the cloud pipeline.
   */
  async recoverInterrupted(recordings: Recording[]): Promise<number> {
    let count = 0;
    for (const recording of recordings) {
      if (!isProcessing(recording.status) || recording.status === 'uploading') continue;
      if (recording.remotePath || this.isRunning(recording.id)) continue;
      const failedStage: ProcessingStage = recording.status === 'summarizing' ? 'summarize' : 'transcribe';
      const next = await this.update(recording.id, {
        status: 'failed',
        failedStage,
        errorMessage: 'Processing was interrupted when the page was closed. Your recording is safe — press Retry to start again.',
      });
      this.deps.onRecordingChanged?.(next);
      count += 1;
    }
    return count;
  }

  // --- internals ---------------------------------------------------------------

  private async execute(recordingId: string, options: OnDeviceRunOptions, signal: AbortSignal): Promise<Recording> {
    const { store, engine } = this.deps;
    const settings = this.deps.getSettings();

    const recording = await store.getRecording(recordingId);
    if (!recording) throw new AppError('UNKNOWN', 'That recording no longer exists.');
    const restoreStatus: RecordingStatus =
      recording.status === 'failed' ? (recording.remotePath ? 'uploaded' : 'local') : isProcessing(recording.status) ? 'local' : recording.status;

    let stage: ProcessingStage = options.summarizeOnly ? 'summarize' : 'transcribe';
    try {
      let transcript: Transcript | undefined;

      if (options.summarizeOnly) {
        transcript = await store.getTranscript(recordingId);
        if (!transcript) throw new AppError('UNKNOWN', 'There is no transcript to build notes from yet.');
      } else {
        if (!engine.isSupported()) {
          throw new AppError('UNKNOWN', 'This browser cannot run on-device transcription. Try a current version of Safari, Chrome or Edge.');
        }
        const blob = await store.getAudio(recordingId);
        if (!blob) {
          throw new AppError('AUDIO_MISSING', 'The original audio is no longer stored in this browser, so it cannot be transcribed.');
        }
        await this.update(recordingId, { status: 'transcribing', failedStage: null, errorMessage: null });
        this.deps.onProgress?.(recordingId, { phase: 'decoding', pct: null });

        const result = await engine.transcribe(
          blob,
          { model: settings.onDeviceModel, language: settings.language === 'auto' ? null : settings.language },
          (progress) => this.deps.onProgress?.(recordingId, progress),
          signal,
        );
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

        const segments = cleanSegments(result.segments);
        if (result.silent || segments.length === 0) {
          throw new AppError(
            'PROCESSING_FAILED',
            result.silent
              ? 'No sound was detected in this recording, so there is nothing to transcribe.'
              : 'No speech was recognised in this recording. If it does contain speech, try the “More accurate” model in Settings.',
          );
        }

        transcript = {
          recordingId,
          language: settings.language === 'auto' ? null : settings.language,
          text: segments.map((s) => s.text).join(' '),
          segments,
          provider: 'on-device',
          model: `whisper-${settings.onDeviceModel}`,
          createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
        };
        await store.putTranscript(transcript);
        this.deps.onTranscriptStored?.();
      }

      stage = 'summarize';
      await this.update(recordingId, { status: 'summarizing', failedStage: null, errorMessage: null });
      this.deps.onProgress?.(recordingId, { phase: 'notes', pct: null });
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      const built = buildExtractiveNotes(
        transcript,
        {
          summaryLength: settings.summaryLength,
          extractActionItems: settings.extractActionItems,
          extractDecisions: settings.extractDecisions,
        },
        recording.durationMs,
      );
      const stamp = (this.deps.now?.() ?? new Date()).toISOString();
      await store.putNotes({ ...built.notes, recordingId, createdAt: stamp, updatedAt: stamp });
      await store.replaceActionItems(
        recordingId,
        built.actionItems.map((item) => ({ ...item, id: newId(), recordingId })),
      );

      return await this.update(recordingId, {
        status: 'completed',
        failedStage: null,
        errorMessage: null,
        language: transcript.language,
      });
    } catch (error) {
      if (isAbort(error)) {
        // Cancelled by the user: back to where it was, no error shown.
        await this.update(recordingId, {
          status: restoreStatus,
          failedStage: null,
          errorMessage: null,
        });
        throw error;
      }
      if (options.summarizeOnly && recording.status === 'completed') {
        // A failed regeneration must not turn a good recording into a failed one.
        await this.update(recordingId, { status: 'completed', failedStage: null, errorMessage: null });
        throw error;
      }
      await this.update(recordingId, { status: 'failed', failedStage: stage, errorMessage: errorMessage(error) });
      throw error;
    }
  }

  private async update(id: string, patch: Partial<Recording>): Promise<Recording> {
    const next = await this.deps.store.updateRecording(id, patch);
    this.deps.onRecordingChanged?.(next);
    return next;
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
