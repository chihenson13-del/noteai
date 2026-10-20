export type RecordingQuality = 'economy' | 'standard' | 'high';

/** Lifecycle of a saved recording. `recording` is NOT a stored status: an in-progress session lives in the recorder. */
export type RecordingStatus =
  | 'local'
  | 'uploading'
  | 'uploaded'
  | 'transcribing'
  | 'summarizing'
  | 'completed'
  | 'failed';

export type ProcessingStage = 'upload' | 'transcribe' | 'summarize';

export type MomentKind = 'key' | 'action' | 'question' | 'note';

/** A marker the user dropped while recording, anchored to the recording's own timeline. */
export interface Moment {
  id: string;
  /** Milliseconds of captured audio at the time the marker was dropped. */
  atMs: number;
  kind: MomentKind;
  text: string;
}

export interface Recording {
  /** Client-generated UUID. Also the primary key in the cloud, which makes uploads idempotent. */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  quality: RecordingQuality;
  status: RecordingStatus;
  failedStage: ProcessingStage | null;
  errorMessage: string | null;
  /** The original audio blob is stored in this browser. */
  hasLocalAudio: boolean;
  /** Object path in private cloud storage, or null when the audio was never uploaded / was deleted. */
  remotePath: string | null;
  language: string | null;
  /** The browser/OS interrupted capture at some point (muted mic, stall, recovery after reload ...). */
  wasInterrupted: boolean;
  interruptionNote: string | null;
  /** The user has seen and dismissed the interruption notice for this recording. */
  interruptionAcknowledged: boolean;
  checksumSha256: string | null;
  audioDeletedAt: string | null;
  /** The row exists in the cloud database. */
  inCloud: boolean;
  pinned: boolean;
  /** User-chosen collection name (e.g. "Meetings"), or null. */
  collection: string | null;
  moments: Moment[];
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  recordingId: string;
  language: string | null;
  text: string;
  segments: TranscriptSegment[];
  provider: string;
  model: string;
  createdAt: string;
}

/** A statement in the notes plus the audio time that supports it (null when no evidence is known). */
export interface NoteItem {
  text: string;
  atMs: number | null;
}

export interface Chapter {
  title: string;
  /** Verified start time, or null when the transcript has no timestamps. */
  startMs: number | null;
  endMs: number | null;
  points: NoteItem[];
}

/** Legacy (pre-chapters) grouping, kept so older notes still display. */
export interface NoteTopic {
  title: string;
  points: string[];
}

export interface Notes {
  recordingId: string;
  summary: string;
  keyTakeaways: NoteItem[];
  decisions: NoteItem[];
  chapters: Chapter[];
  topics: NoteTopic[];
  provider: string;
  model: string;
  userEdited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActionItem {
  id: string;
  recordingId: string;
  text: string;
  assignee: string | null;
  dueDate: string | null;
  done: boolean;
  sortOrder: number;
  /** Audio time the task was stated at, when known. */
  atMs: number | null;
}

export type SummaryLength = 'brief' | 'standard' | 'detailed';

/** Which Whisper model the on-device transcriber uses. */
export type OnDeviceModelId = 'tiny' | 'base';

export interface AppSettings {
  quality: RecordingQuality;
  /** BCP-47 / ISO-639-1 code, or 'auto' to let the provider detect it. */
  language: string;
  summaryLength: SummaryLength;
  extractActionItems: boolean;
  extractDecisions: boolean;
  keepScreenAwake: boolean;
  /** Speech model used when transcribing on this device. */
  onDeviceModel: OnDeviceModelId;
  /** Show the recording-consent reminder card before each recording. */
  showRecordingReminder: boolean;
  /** Delete original audio (local + cloud) this many days after processing completed. null = keep forever. */
  audioRetentionDays: number | null;
  /** ISO timestamp when the user agreed to upload audio to the cloud backend and AI providers. */
  uploadConsentAt: string | null;
  /** ISO timestamp when the user acknowledged the recording-consent reminder. */
  recordingReminderAckAt: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  quality: 'standard',
  language: 'auto',
  summaryLength: 'standard',
  extractActionItems: true,
  extractDecisions: true,
  keepScreenAwake: true,
  onDeviceModel: 'tiny',
  showRecordingReminder: true,
  audioRetentionDays: null,
  uploadConsentAt: null,
  recordingReminderAckAt: null,
};

export interface UnfinishedSession {
  id: string;
  title: string;
  mimeType: string;
  quality: RecordingQuality;
  startedAt: string;
  elapsedMs: number;
  heartbeatAt: number;
  chunkCount: number;
  wasInterrupted: boolean;
  moments: Moment[];
}

/** Something that left this device (or was processed by a third party), shown in the Trust center. */
export interface DataTransfer {
  id: string;
  recordingId: string | null;
  kind: 'audio_upload' | 'transcription' | 'notes' | 'ask';
  provider: string | null;
  createdAt: string;
}

export interface ShareLink {
  id: string;
  recordingId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
