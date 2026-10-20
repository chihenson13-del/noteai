import type { ProcessingStage, Recording, RecordingStatus } from './types';

export type StatusTone = 'neutral' | 'info' | 'busy' | 'success' | 'danger';

export const STATUS_LABEL: Record<RecordingStatus, string> = {
  local: 'On this device',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  transcribing: 'Transcribing',
  summarizing: 'Writing notes',
  completed: 'Completed',
  failed: 'Needs attention',
};

export const STATUS_TONE: Record<RecordingStatus, StatusTone> = {
  local: 'neutral',
  uploading: 'busy',
  uploaded: 'info',
  transcribing: 'busy',
  summarizing: 'busy',
  completed: 'success',
  failed: 'danger',
};

export const STAGE_LABEL: Record<ProcessingStage, string> = {
  upload: 'Upload',
  transcribe: 'Transcription',
  summarize: 'AI notes',
};

export const FILTERABLE_STATUSES: RecordingStatus[] = [
  'local',
  'uploading',
  'uploaded',
  'transcribing',
  'summarizing',
  'completed',
  'failed',
];

/** True while the cloud pipeline is working and the UI should keep polling. */
export function isProcessing(status: RecordingStatus): boolean {
  return status === 'uploading' || status === 'transcribing' || status === 'summarizing';
}

export function statusLabel(recording: Pick<Recording, 'status' | 'failedStage'>): string {
  if (recording.status === 'failed' && recording.failedStage) {
    return `${STAGE_LABEL[recording.failedStage]} failed`;
  }
  return STATUS_LABEL[recording.status];
}

/** The next stage the pipeline should (re)start from for a recording that is not finished. */
export function nextStage(recording: Pick<Recording, 'status' | 'failedStage' | 'remotePath'>): ProcessingStage | null {
  if (recording.status === 'completed') return null;
  if (recording.status === 'failed' && recording.failedStage) return recording.failedStage;
  if (recording.status === 'local') return 'upload';
  if (recording.status === 'uploaded') return 'transcribe';
  return null;
}
