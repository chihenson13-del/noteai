import type {
  ActionItem,
  DataTransfer,
  Moment,
  Notes,
  Recording,
  ShareLink,
  SummaryLength,
  Transcript,
} from '../domain/types';

export interface CloudUser {
  id: string;
  /** Sign-in address. For access-code users this is a synthetic, non-routable address. */
  email: string | null;
  /** Full name given at the first login on a device (access-code users). */
  name: string | null;
  /** Contact email given at the first login on a device (access-code users). */
  contactEmail: string | null;
  /** Signed in with an access code rather than email + password. */
  viaCode: boolean;
}

/** Collected once, the first time a device uses an access code. */
export interface DeviceProfileInput {
  fullName: string;
  email: string;
}

export interface ProcessOptions {
  /** 'auto' or ISO-639-1 */
  language: string;
  summaryLength: SummaryLength;
  extractActionItems: boolean;
  extractDecisions: boolean;
}

/** One device that activated an access code (admin view). `deviceHash` identifies it for "free device". */
export interface AdminDevice {
  deviceHash: string;
  label: string | null;
  fullName: string | null;
  contactEmail: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AdminCode {
  id: string;
  label: string | null;
  status: 'unused' | 'in_use' | 'revoked';
  isAdmin: boolean;
  maxDevices: number;
  ownerName: string | null;
  ownerEmail: string | null;
  activatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  devices: AdminDevice[];
}

/** What is sent to the server to create a share link for notes that only exist on this device. */
export interface DeviceShareInput {
  title: string;
  recordedAt: string;
  durationMs: number;
  notes: {
    summary: string;
    keyTakeaways: Array<{ text: string }>;
    decisions: Array<{ text: string }>;
    chapters: Array<{ title: string; startMs: number | null; points: Array<{ text: string }> }>;
    provider: string;
    model: string;
    userEdited: boolean;
  };
  actionItems: Array<{ text: string; assignee: string | null; dueDate: string | null; done: boolean }>;
}

export interface AskRequest {
  question: string;
  recordingIds?: string[];
  sinceDays?: number;
}

export interface AskSourceView {
  recordingId: string;
  recordingTitle: string;
  atMs: number | null;
  quote: string;
}

export interface AskResponse {
  found: boolean;
  answer: string;
  sources: AskSourceView[];
  /** How many recordings were searched. */
  searched: number;
}

/** 'all' = transcribe then summarize. 'summarize' = reuse the stored transcript. */
export type ProcessStageRequest = 'all' | 'summarize';

/**
 * Everything the app needs from a cloud backend. The only implementation is Supabase
 * (src/data/supabaseBackend.ts); the interface exists so the processing pipeline can be
 * unit-tested with an in-memory fake and the app can run local-only without a backend.
 *
 * Provider API keys never reach the browser: transcription and AI calls happen inside the
 * `process-recording` server function, which this interface merely requests.
 */
export interface CloudBackend {
  getUser(): Promise<CloudUser | null>;
  /** `event` is the provider's auth event name, e.g. SIGNED_IN or PASSWORD_RECOVERY. */
  onAuthChange(listener: (user: CloudUser | null, event: string) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<{ needsEmailConfirmation: boolean }>;
  /**
   * Signs in with an access code (no account needed). Throws AppError('PROFILE_REQUIRED') when this is the
   * device's first login with the code and `profile` has not been supplied yet.
   */
  signInWithCode(code: string, device: { id: string; label: string }, profile?: DeviceProfileInput): Promise<void>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  /** Sets a new password for the signed-in user (also used after a reset-email link). */
  updatePassword(password: string): Promise<void>;

  /** Creates the metadata row if it does not exist yet. Idempotent. */
  ensureRecordingRow(userId: string, recording: Recording): Promise<void>;
  /** Uploads to private storage. Idempotent: an existing identical object counts as success. Returns the storage path. */
  uploadAudio(userId: string, recording: Recording, blob: Blob, checksumSha256: string): Promise<string>;
  /** Marks the upload as failed so other devices see it. Best effort. */
  markUploadFailed(recordingId: string, message: string): Promise<void>;
  requestProcessing(recordingId: string, stage: ProcessStageRequest, force: boolean, options: ProcessOptions): Promise<void>;

  fetchRecording(id: string): Promise<Recording | null>;
  fetchRecordings(): Promise<Recording[]>;
  fetchTranscript(recordingId: string): Promise<Transcript | null>;
  fetchNotes(recordingId: string): Promise<Notes | null>;
  fetchActionItems(recordingId: string): Promise<ActionItem[]>;

  updateTitle(recordingId: string, title: string): Promise<void>;
  updateRecordingMeta(
    recordingId: string,
    patch: { pinned?: boolean; collection?: string | null; moments?: Moment[] },
  ): Promise<void>;
  saveNotes(notes: Notes): Promise<void>;
  replaceActionItems(userId: string, recordingId: string, items: ActionItem[]): Promise<void>;

  /** Searches the caller's processed recordings. Retrieval is keyword based; answers cite sources or say "not found". */
  askRecordings(request: AskRequest): Promise<AskResponse>;
  /**
   * `device` carries the notes of a recording made on the device (it has no cloud copy). Without it the server reads the
   * notes of the cloud recording.
   */
  createShareLink(
    recordingId: string,
    expiresInDays: 1 | 7 | 30,
    device?: DeviceShareInput,
  ): Promise<{ id: string; token: string; expiresAt: string }>;
  listShareLinks(recordingId: string): Promise<ShareLink[]>;
  revokeShareLink(shareId: string): Promise<void>;
  /** What was uploaded or sent to a third party, newest first. */
  fetchTransfers(limit?: number): Promise<DataTransfer[]>;

  createAudioUrl(storagePath: string): Promise<string>;
  downloadAudio(storagePath: string): Promise<Blob>;
  /** Deletes the audio object (keeps transcript and notes). */
  deleteRemoteAudio(recordingId: string, storagePath: string): Promise<void>;
  /** Deletes the recording row (cascades to transcript/notes/items) and its audio object. */
  deleteRecording(recordingId: string, storagePath: string | null): Promise<void>;
  /** Deletes the account, all rows and all stored audio (server side). */
  deleteAccount(): Promise<void>;

  // Admin tools: the server only answers a user who signed in with an admin code.
  adminWhoAmI?(): Promise<boolean>;
  adminListCodes?(): Promise<AdminCode[]>;
  adminSetRevoked?(codeId: string, revoked: boolean): Promise<void>;
  adminReleaseDevice?(codeId: string, deviceHash: string): Promise<void>;
  /** Returns the new plain codes. They are never stored or shown again. */
  adminCreateCodes?(count: number, label: string): Promise<string[]>;
}
