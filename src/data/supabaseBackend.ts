import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { appUrl } from '../config/base';
import { extensionForMime } from '../domain/audioMime';
import { coerceMoments, coerceNotes } from '../domain/migrate';
import { isCodeUserEmail } from '../../supabase/functions/_shared/accessCode';
import type {
  DataTransfer,
  ProcessingStage,
  Recording,
  RecordingQuality,
  RecordingStatus,
  ShareLink,
  Transcript,
  TranscriptSegment,
} from '../domain/types';
import { AppError } from '../lib/errors';
import type { AskRequest, AskResponse, CloudBackend, CloudUser, ProcessOptions, ProcessStageRequest } from './backend';

const BUCKET = 'recordings';

interface RecordingRow {
  id: string;
  title: string;
  duration_ms: number;
  size_bytes: number;
  mime_type: string;
  quality: string;
  status: string;
  failed_stage: string | null;
  error_message: string | null;
  storage_path: string | null;
  language: string | null;
  was_interrupted: boolean;
  interruption_note: string | null;
  checksum_sha256: string | null;
  audio_deleted_at: string | null;
  pinned: boolean | null;
  collection: string | null;
  moments: unknown;
  recorded_at: string;
  updated_at: string;
}

interface TranscriptRow {
  recording_id: string;
  language: string | null;
  full_text: string;
  segments: unknown;
  provider: string;
  model: string;
  created_at: string;
}

interface NotesRow {
  recording_id: string;
  summary: string;
  key_takeaways: unknown;
  decisions: unknown;
  chapters: unknown;
  topics: unknown;
  provider: string;
  model: string;
  user_edited: boolean;
  created_at: string;
  updated_at: string;
}

interface ActionItemRow {
  id: string;
  recording_id: string;
  text: string;
  assignee: string | null;
  due_date: string | null;
  done: boolean;
  sort_order: number;
  evidence_ms: number | null;
}

interface TransferRow {
  id: string;
  recording_id: string | null;
  kind: DataTransfer['kind'];
  provider: string | null;
  created_at: string;
}

const STATUSES: RecordingStatus[] = ['local', 'uploading', 'uploaded', 'transcribing', 'summarizing', 'completed', 'failed'];
const STAGES: ProcessingStage[] = ['upload', 'transcribe', 'summarize'];
const QUALITIES: RecordingQuality[] = ['economy', 'standard', 'high'];

function asSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TranscriptSegment[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { startMs, endMs, text } = entry as { startMs?: unknown; endMs?: unknown; text?: unknown };
    if (typeof startMs === 'number' && typeof endMs === 'number' && typeof text === 'string') {
      segments.push({ startMs, endMs, text });
    }
  }
  return segments;
}

export function mapRecordingRow(row: RecordingRow): Recording {
  const status = STATUSES.includes(row.status as RecordingStatus) ? (row.status as RecordingStatus) : 'failed';
  return {
    id: row.id,
    title: row.title,
    createdAt: row.recorded_at,
    updatedAt: row.updated_at,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    quality: QUALITIES.includes(row.quality as RecordingQuality) ? (row.quality as RecordingQuality) : 'standard',
    status,
    failedStage: STAGES.includes(row.failed_stage as ProcessingStage) ? (row.failed_stage as ProcessingStage) : null,
    errorMessage: row.error_message,
    hasLocalAudio: false,
    remotePath: row.storage_path,
    language: row.language,
    wasInterrupted: row.was_interrupted,
    interruptionNote: row.interruption_note,
    interruptionAcknowledged: false,
    checksumSha256: row.checksum_sha256,
    audioDeletedAt: row.audio_deleted_at,
    inCloud: true,
    pinned: row.pinned === true,
    collection: row.collection,
    moments: coerceMoments(row.moments),
  };
}

function toAppError(error: { message?: string; name?: string; status?: number } | null, fallback: string): AppError {
  const message = error?.message ?? fallback;
  const network = /failed to fetch|network|load failed/i.test(message);
  if (network) return new AppError('NETWORK', 'Could not reach the server. Check your connection and try again.', { cause: error, retryable: true });
  if (error?.status === 401 || error?.status === 403) {
    return new AppError('AUTH_REQUIRED', 'Your session has expired. Please sign in again.', { cause: error });
  }
  return new AppError('PROCESSING_FAILED', message, { cause: error, retryable: true });
}

export function createSupabaseBackend(url: string, anonKey: string): CloudBackend {
  const client: SupabaseClient = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const mapUser = (
    user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null | undefined,
  ): CloudUser | null => {
    if (!user) return null;
    const meta = user.user_metadata ?? {};
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return {
      id: user.id,
      email: user.email ?? null,
      name: text(meta.full_name),
      contactEmail: text(meta.contact_email),
      viaCode: isCodeUserEmail(user.email),
    };
  };

  /** Calls an Edge Function and converts every failure into an actionable AppError. */
  async function invoke<T>(name: string, body: object): Promise<T> {
    const { data, error } = await client.functions.invoke(name, { body: body as Record<string, unknown> });
    if (!error) return data as T;
    let message = error.message;
    let status: number | undefined;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      status = context.status;
      try {
        const parsed = (await context.json()) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* non-JSON error body */
      }
    }
    if (error.name === 'FunctionsFetchError') {
      throw new AppError('NETWORK', 'Could not reach the server. Check your connection and retry.', { cause: error, retryable: true });
    }
    if (status === 401) throw new AppError('AUTH_REQUIRED', 'Your session has expired. Please sign in again.', { cause: error });
    if (status === 413) throw new AppError('FILE_TOO_LARGE', message, { cause: error });
    if (status === 503) throw new AppError('BACKEND_NOT_CONFIGURED', message, { cause: error });
    throw new AppError('PROCESSING_FAILED', message, { cause: error, retryable: (status ?? 500) >= 500 });
  }

  return {
    async getUser() {
      const { data } = await client.auth.getSession();
      return mapUser(data.session?.user);
    },

    onAuthChange(listener) {
      const { data } = client.auth.onAuthStateChange((event, session) => listener(mapUser(session?.user), event));
      return () => data.subscription.unsubscribe();
    },

    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new AppError('AUTH_REQUIRED', error.message, { cause: error });
    },

    async signInWithCode(code, device, profile) {
      const { data, error } = await client.functions.invoke('redeem-code', {
        body: {
          code,
          deviceId: device.id,
          deviceLabel: device.label,
          ...(profile ? { fullName: profile.fullName, email: profile.email } : {}),
        },
      });
      if (error) {
        let message = 'Could not sign in with that code.';
        let status: number | undefined;
        let needsProfile = false;
        const context = (error as { context?: unknown }).context;
        if (context instanceof Response) {
          status = context.status;
          try {
            const parsed = (await context.json()) as { error?: string; needsProfile?: boolean };
            if (parsed.error) message = parsed.error;
            needsProfile = parsed.needsProfile === true;
          } catch {
            /* non-JSON error body */
          }
        }
        if (error.name === 'FunctionsFetchError') {
          throw new AppError('NETWORK', 'Could not reach the server. Check your connection and try again.', { cause: error, retryable: true });
        }
        if (needsProfile || status === 422) throw new AppError('PROFILE_REQUIRED', message, { cause: error });
        if (status === 503) throw new AppError('BACKEND_NOT_CONFIGURED', message, { cause: error });
        throw new AppError('AUTH_REQUIRED', message, { cause: error });
      }
      const tokenHash = (data as { tokenHash?: unknown } | null)?.tokenHash;
      if (typeof tokenHash !== 'string') throw new AppError('AUTH_REQUIRED', 'The server did not return a session. Please try again.');
      const { error: verifyError } = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
      if (verifyError) throw new AppError('AUTH_REQUIRED', 'Could not start your session. Please try again.', { cause: verifyError });
    },

    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: typeof window !== 'undefined' ? appUrl('/') : undefined },
      });
      if (error) throw new AppError('AUTH_REQUIRED', error.message, { cause: error });
      return { needsEmailConfirmation: data.session === null };
    },

    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw new AppError('AUTH_REQUIRED', error.message, { cause: error });
    },

    async sendPasswordReset(email) {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: typeof window !== 'undefined' ? appUrl('/') : undefined,
      });
      if (error) throw new AppError('AUTH_REQUIRED', error.message, { cause: error });
    },

    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw new AppError('AUTH_REQUIRED', error.message, { cause: error });
    },

    async ensureRecordingRow(userId, recording) {
      const { error } = await client.from('recordings').upsert(
        {
          id: recording.id,
          user_id: userId,
          title: recording.title,
          duration_ms: Math.round(recording.durationMs),
          size_bytes: recording.sizeBytes,
          mime_type: recording.mimeType,
          quality: recording.quality,
          status: 'uploading',
          language: recording.language,
          was_interrupted: recording.wasInterrupted,
          interruption_note: recording.interruptionNote,
          pinned: recording.pinned,
          collection: recording.collection,
          moments: recording.moments,
          recorded_at: recording.createdAt,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      );
      if (error) throw toAppError(error, 'Could not create the recording in the cloud.');
    },

    async uploadAudio(userId, recording, blob, checksumSha256) {
      const path = `${userId}/${recording.id}.${extensionForMime(recording.mimeType)}`;
      const { error } = await client.storage.from(BUCKET).upload(path, blob, {
        contentType: recording.mimeType,
        upsert: false,
        cacheControl: '3600',
      });
      if (error) {
        const info = error as { statusCode?: string | number; message: string };
        const duplicate = String(info.statusCode) === '409' || /already exists|duplicate/i.test(info.message);
        if (!duplicate) throw toAppError(error, 'Upload failed.');
        // Same recording id uploaded before (e.g. a retry after a dropped response): verify size, then reuse.
        const folder = path.slice(0, path.lastIndexOf('/'));
        const { data: listing } = await client.storage.from(BUCKET).list(folder, { search: path.slice(folder.length + 1) });
        const existing = listing?.find((o) => `${folder}/${o.name}` === path);
        const existingSize = (existing?.metadata as { size?: number } | undefined)?.size;
        if (existingSize !== undefined && existingSize !== blob.size) {
          throw new AppError('UPLOAD_FAILED', 'A different file already exists for this recording. Contact support or re-record.', {
            retryable: false,
          });
        }
      }
      const { error: updateError } = await client
        .from('recordings')
        .update({
          storage_path: path,
          checksum_sha256: checksumSha256,
          size_bytes: blob.size,
          status: 'uploaded',
          failed_stage: null,
          error_message: null,
          audio_deleted_at: null,
        })
        .eq('id', recording.id);
      if (updateError) throw toAppError(updateError, 'The upload finished but could not be recorded.');
      // Trust-center log: best effort, never blocks the upload.
      await client
        .from('data_transfers')
        .insert({ user_id: userId, recording_id: recording.id, kind: 'audio_upload', provider: 'supabase-storage' })
        .then(() => undefined, () => undefined);
      return path;
    },

    async markUploadFailed(recordingId, message) {
      await client
        .from('recordings')
        .update({ status: 'failed', failed_stage: 'upload', error_message: message.slice(0, 500) })
        .eq('id', recordingId);
    },

    async requestProcessing(recordingId, stage: ProcessStageRequest, force: boolean, options: ProcessOptions) {
      await invoke('process-recording', { recordingId, stage, force, options });
    },

    async fetchRecording(id) {
      const { data, error } = await client.from('recordings').select('*').eq('id', id).maybeSingle();
      if (error) throw toAppError(error, 'Could not load the recording.');
      return data ? mapRecordingRow(data as RecordingRow) : null;
    },

    async fetchRecordings() {
      const { data, error } = await client
        .from('recordings')
        .select('*')
        .order('recorded_at', { ascending: false })
        .limit(500);
      if (error) throw toAppError(error, 'Could not load your recordings.');
      return (data as RecordingRow[]).map(mapRecordingRow);
    },

    async fetchTranscript(recordingId) {
      const { data, error } = await client.from('transcripts').select('*').eq('recording_id', recordingId).maybeSingle();
      if (error) throw toAppError(error, 'Could not load the transcript.');
      if (!data) return null;
      const row = data as TranscriptRow;
      return {
        recordingId: row.recording_id,
        language: row.language,
        text: row.full_text,
        segments: asSegments(row.segments),
        provider: row.provider,
        model: row.model,
        createdAt: row.created_at,
      } satisfies Transcript;
    },

    async fetchNotes(recordingId) {
      const { data, error } = await client.from('summaries').select('*').eq('recording_id', recordingId).maybeSingle();
      if (error) throw toAppError(error, 'Could not load the notes.');
      if (!data) return null;
      const row = data as NotesRow;
      return (
        coerceNotes({
          recordingId: row.recording_id,
          summary: row.summary,
          keyTakeaways: row.key_takeaways,
          decisions: row.decisions,
          chapters: row.chapters,
          topics: row.topics,
          provider: row.provider,
          model: row.model,
          userEdited: row.user_edited,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }) ?? null
      );
    },

    async fetchActionItems(recordingId) {
      const { data, error } = await client
        .from('action_items')
        .select('*')
        .eq('recording_id', recordingId)
        .order('sort_order', { ascending: true });
      if (error) throw toAppError(error, 'Could not load action items.');
      return (data as ActionItemRow[]).map((row) => ({
        id: row.id,
        recordingId: row.recording_id,
        text: row.text,
        assignee: row.assignee,
        dueDate: row.due_date,
        done: row.done,
        sortOrder: row.sort_order,
        atMs: row.evidence_ms,
      }));
    },

    async updateTitle(recordingId, title) {
      const { error } = await client.from('recordings').update({ title }).eq('id', recordingId);
      if (error) throw toAppError(error, 'Could not rename the recording.');
    },

    async updateRecordingMeta(recordingId, patch) {
      const update: Record<string, unknown> = {};
      if (patch.pinned !== undefined) update.pinned = patch.pinned;
      if (patch.collection !== undefined) update.collection = patch.collection;
      if (patch.moments !== undefined) update.moments = patch.moments;
      if (Object.keys(update).length === 0) return;
      const { error } = await client.from('recordings').update(update).eq('id', recordingId);
      if (error) throw toAppError(error, 'Could not update the recording.');
    },

    async saveNotes(notes) {
      const { error } = await client
        .from('summaries')
        .update({
          summary: notes.summary,
          key_takeaways: notes.keyTakeaways,
          decisions: notes.decisions,
          chapters: notes.chapters,
          topics: notes.topics,
          user_edited: true,
        })
        .eq('recording_id', notes.recordingId);
      if (error) throw toAppError(error, 'Could not save your edits.');
    },

    async replaceActionItems(userId, recordingId, items) {
      const del = await client.from('action_items').delete().eq('recording_id', recordingId);
      if (del.error) throw toAppError(del.error, 'Could not save action items.');
      if (items.length === 0) return;
      const { error } = await client.from('action_items').insert(
        items.map((item, index) => ({
          id: item.id,
          user_id: userId,
          recording_id: recordingId,
          text: item.text,
          assignee: item.assignee,
          due_date: item.dueDate,
          done: item.done,
          evidence_ms: item.atMs,
          sort_order: index,
        })),
      );
      if (error) throw toAppError(error, 'Could not save action items.');
    },

    async askRecordings(request: AskRequest) {
      return invoke<AskResponse>('ask-recordings', request);
    },

    async createShareLink(recordingId, expiresInDays, device) {
      return invoke<{ id: string; token: string; expiresAt: string }>('share-notes', {
        action: 'create',
        recordingId,
        expiresInDays,
        ...(device ? { device } : {}),
      });
    },

    async listShareLinks(recordingId) {
      const result = await invoke<{ links: ShareLink[] }>('share-notes', { action: 'list', recordingId });
      return result.links;
    },

    async revokeShareLink(shareId) {
      await invoke('share-notes', { action: 'revoke', shareId });
    },

    async fetchTransfers(limit = 30) {
      const { data, error } = await client
        .from('data_transfers')
        .select('id, recording_id, kind, provider, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw toAppError(error, 'Could not load the activity log.');
      return (data as TransferRow[]).map((row) => ({
        id: row.id,
        recordingId: row.recording_id,
        kind: row.kind,
        provider: row.provider,
        createdAt: row.created_at,
      })) satisfies DataTransfer[];
    },

    async createAudioUrl(storagePath) {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(storagePath, 3600);
      if (error || !data) throw toAppError(error, 'Could not open the cloud copy of the audio.');
      return data.signedUrl;
    },

    async downloadAudio(storagePath) {
      const { data, error } = await client.storage.from(BUCKET).download(storagePath);
      if (error || !data) throw toAppError(error, 'Could not download the audio.');
      return data;
    },

    async deleteRemoteAudio(recordingId, storagePath) {
      const { error } = await client.storage.from(BUCKET).remove([storagePath]);
      if (error) throw toAppError(error, 'Could not delete the cloud audio.');
      const { error: updateError } = await client
        .from('recordings')
        .update({ storage_path: null, audio_deleted_at: new Date().toISOString() })
        .eq('id', recordingId);
      if (updateError) throw toAppError(updateError, 'Audio was deleted but the record could not be updated.');
    },

    async deleteRecording(recordingId, storagePath) {
      if (storagePath) {
        const { error } = await client.storage.from(BUCKET).remove([storagePath]);
        if (error) throw toAppError(error, 'Could not delete the cloud audio.');
      }
      const { error } = await client.from('recordings').delete().eq('id', recordingId);
      if (error) throw toAppError(error, 'Could not delete the recording.');
    },

    async deleteAccount() {
      const { error } = await client.functions.invoke('delete-account', { body: { confirm: true } });
      if (error) throw toAppError(error, 'Could not delete the account.');
      await client.auth.signOut();
    },
  };
}
