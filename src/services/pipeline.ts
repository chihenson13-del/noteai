import type { CloudBackend, CloudUser, ProcessOptions, ProcessStageRequest } from '../data/backend';
import type { LocalStore } from '../data/localStore';
import { isProcessing } from '../domain/status';
import type { AppSettings, ProcessingStage, Recording } from '../domain/types';
import { AppError, errorMessage, isAppError } from '../lib/errors';
import { withRetry, type RetryOptions } from '../lib/retry';
import { sha256Hex } from './recordingService';

type PipelineStore = Pick<
  LocalStore,
  'getRecording' | 'updateRecording' | 'getAudio' | 'putTranscript' | 'putNotes' | 'replaceActionItems'
>;

export interface PipelineDeps {
  store: PipelineStore;
  backend: CloudBackend;
  getUser: () => CloudUser | null;
  getSettings: () => AppSettings;
  onRecordingChanged?: (recording: Recording) => void;
  checksum?: (blob: Blob) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs'>;
}

export interface RunOptions {
  /** Re-run even if the recording is already completed. */
  force?: boolean;
  /** Only regenerate the AI notes from the stored transcript (no upload / transcription). */
  summarizeOnly?: boolean;
}

function isRetryable(error: unknown): boolean {
  if (isAppError(error)) return error.retryable || error.code === 'NETWORK';
  return true;
}

/**
 * Upload -> transcribe -> summarize, with these guarantees:
 *  - The original audio blob in IndexedDB is NEVER deleted or modified by any stage or failure.
 *  - One run per recording at a time (in-flight map), plus deterministic storage paths,
 *    insert-if-absent metadata rows and server-side job de-duplication => no duplicate uploads
 *    or duplicate processing records even across retries, tabs and double clicks.
 *  - Every failure is persisted (status failed + failed stage + message) so it can be retried
 *    from the failed stage.
 */
export class ProcessingPipeline {
  private readonly inFlight = new Map<string, Promise<Recording>>();
  private readonly checksum: (blob: Blob) => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(private readonly deps: PipelineDeps) {
    this.checksum = deps.checksum ?? sha256Hex;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
    this.pollTimeoutMs = deps.pollTimeoutMs ?? 20 * 60_000;
  }

  isRunning(recordingId: string): boolean {
    return this.inFlight.has(recordingId);
  }

  run(recordingId: string, options: RunOptions = {}): Promise<Recording> {
    const existing = this.inFlight.get(recordingId);
    if (existing) return existing;
    const promise = this.execute(recordingId, options).finally(() => {
      this.inFlight.delete(recordingId);
    });
    this.inFlight.set(recordingId, promise);
    return promise;
  }

  /** Regenerate summary / takeaways / decisions / action items from the stored transcript. */
  regenerateNotes(recordingId: string): Promise<Recording> {
    return this.run(recordingId, { force: true, summarizeOnly: true });
  }

  /**
   * Called on startup: recordings left in a transient status by a closed tab are either put
   * back to "on this device" (interrupted upload; audio is still here) or have their server
   * progress polled again.
   */
  async resume(recordings: Recording[]): Promise<void> {
    for (const recording of recordings) {
      if (!isProcessing(recording.status) || this.isRunning(recording.id)) continue;
      if (recording.status === 'uploading') {
        await this.update(recording.id, { status: recording.remotePath ? 'uploaded' : 'local' });
      } else {
        const promise = this.pollToCompletion(recording.id).finally(() => this.inFlight.delete(recording.id));
        this.inFlight.set(recording.id, promise);
        promise.catch(() => undefined);
      }
    }
  }

  // --- internals -----------------------------------------------------------------

  private async execute(recordingId: string, options: RunOptions): Promise<Recording> {
    const { backend, store } = this.deps;
    const settings = this.deps.getSettings();
    if (!settings.uploadConsentAt) {
      throw new AppError('NOT_CONSENTED', 'Allow cloud processing in Settings → Privacy before uploading audio.');
    }
    const user = this.deps.getUser();
    if (!user) throw new AppError('AUTH_REQUIRED', 'Sign in to transcribe and summarize recordings.');

    let recording = await store.getRecording(recordingId);
    if (!recording) throw new AppError('UNKNOWN', 'That recording no longer exists.');
    if (recording.status === 'completed' && !options.force) return recording;

    if (!options.summarizeOnly && !recording.remotePath) {
      recording = await this.uploadStage(recording, user);
    }

    const stage: ProcessStageRequest =
      options.summarizeOnly || recording.failedStage === 'summarize' ? 'summarize' : 'all';
    const failedStage: ProcessingStage = stage === 'summarize' ? 'summarize' : 'transcribe';
    const processOptions: ProcessOptions = {
      language: settings.language,
      summaryLength: settings.summaryLength,
      extractActionItems: settings.extractActionItems,
      extractDecisions: settings.extractDecisions,
    };

    recording = await this.update(recording.id, {
      status: stage === 'summarize' ? 'summarizing' : 'transcribing',
      failedStage: null,
      errorMessage: null,
    });

    try {
      await withRetry(() => backend.requestProcessing(recording!.id, stage, options.force ?? false, processOptions), {
        ...this.deps.retry,
        shouldRetry: isRetryable,
      });
    } catch (error) {
      await this.update(recording.id, { status: 'failed', failedStage, errorMessage: errorMessage(error) });
      throw error;
    }

    return this.pollToCompletion(recording.id);
  }

  private async uploadStage(recording: Recording, user: CloudUser): Promise<Recording> {
    const { backend, store } = this.deps;
    await this.update(recording.id, { status: 'uploading', failedStage: null, errorMessage: null });
    try {
      const blob = await store.getAudio(recording.id);
      if (!blob) {
        throw new AppError('AUDIO_MISSING', 'The original audio is no longer stored in this browser, so it cannot be uploaded.');
      }
      const checksum = recording.checksumSha256 ?? (await this.checksum(blob));
      const retry = { ...this.deps.retry, shouldRetry: isRetryable };
      await withRetry(() => backend.ensureRecordingRow(user.id, recording), retry);
      const path = await withRetry(() => backend.uploadAudio(user.id, recording, blob, checksum), retry);
      return await this.update(recording.id, {
        status: 'uploaded',
        remotePath: path,
        checksumSha256: checksum,
        sizeBytes: blob.size,
        inCloud: true,
        failedStage: null,
        errorMessage: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      await this.update(recording.id, { status: 'failed', failedStage: 'upload', errorMessage: message });
      void backend.markUploadFailed(recording.id, message).catch(() => undefined);
      throw error;
    }
  }

  private async pollToCompletion(recordingId: string): Promise<Recording> {
    const { backend } = this.deps;
    const deadline = this.now() + this.pollTimeoutMs;
    for (;;) {
      const remote = await withRetry(() => backend.fetchRecording(recordingId), {
        ...this.deps.retry,
        shouldRetry: isRetryable,
      });
      if (!remote) throw new AppError('PROCESSING_FAILED', 'The recording was not found in the cloud.');

      if (remote.status === 'completed') {
        await this.pullResults(recordingId);
        return this.update(recordingId, {
          status: 'completed',
          failedStage: null,
          errorMessage: null,
          language: remote.language,
          remotePath: remote.remotePath,
          inCloud: true,
        });
      }
      if (remote.status === 'failed') {
        const message = remote.errorMessage ?? 'Processing failed.';
        await this.update(recordingId, {
          status: 'failed',
          failedStage: remote.failedStage ?? 'transcribe',
          errorMessage: message,
        });
        throw new AppError('PROCESSING_FAILED', message);
      }
      if (remote.status === 'transcribing' || remote.status === 'summarizing') {
        await this.update(recordingId, { status: remote.status });
      }
      if (this.now() > deadline) {
        throw new AppError(
          'PROCESSING_FAILED',
          'Processing is taking longer than expected. It continues on the server — reopen this recording in a minute to see the result.',
          { retryable: true },
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async pullResults(recordingId: string): Promise<void> {
    const { backend, store } = this.deps;
    const [transcript, notes, items] = await Promise.all([
      backend.fetchTranscript(recordingId),
      backend.fetchNotes(recordingId),
      backend.fetchActionItems(recordingId),
    ]);
    if (transcript) await store.putTranscript(transcript);
    if (notes) await store.putNotes(notes);
    await store.replaceActionItems(recordingId, items);
  }

  private async update(id: string, patch: Partial<Recording>): Promise<Recording> {
    const next = await this.deps.store.updateRecording(id, patch);
    this.deps.onRecordingChanged?.(next);
    return next;
  }
}
