import type { CloudBackend } from '../data/backend';
import type { LocalStore } from '../data/localStore';
import type { Recording } from '../domain/types';

type RetentionStore = Pick<LocalStore, 'listRecordings' | 'deleteAudio' | 'updateRecording'>;

export interface RetentionResult {
  localDeleted: number;
  cloudDeleted: number;
  errors: string[];
}

/** Recordings whose original audio is due for deletion under the retention policy. */
export function dueForAudioDeletion(recordings: Recording[], retentionDays: number | null, now: number): Recording[] {
  if (retentionDays === null) return [];
  const cutoff = now - retentionDays * 86_400_000;
  return recordings.filter(
    (r) =>
      // Only after the pipeline completed successfully: failed / unprocessed audio is never auto-deleted.
      r.status === 'completed' &&
      (r.hasLocalAudio || r.remotePath !== null) &&
      Date.parse(r.updatedAt) <= cutoff,
  );
}

export async function applyAudioRetention(
  store: RetentionStore,
  backend: Pick<CloudBackend, 'deleteRemoteAudio'> | null,
  retentionDays: number | null,
  now: number = Date.now(),
): Promise<RetentionResult> {
  const result: RetentionResult = { localDeleted: 0, cloudDeleted: 0, errors: [] };
  const due = dueForAudioDeletion(await store.listRecordings(), retentionDays, now);

  for (const recording of due) {
    let remotePath = recording.remotePath;
    try {
      if (remotePath && backend) {
        await backend.deleteRemoteAudio(recording.id, remotePath);
        remotePath = null;
        result.cloudDeleted += 1;
      }
      // Local audio is only removed once the cloud copy is gone (or never existed).
      if (recording.hasLocalAudio && (remotePath === null || !recording.inCloud)) {
        await store.deleteAudio(recording.id);
        result.localDeleted += 1;
        await store.updateRecording(recording.id, {
          hasLocalAudio: false,
          remotePath,
          audioDeletedAt: new Date(now).toISOString(),
        });
      } else if (remotePath === null && recording.remotePath !== null) {
        await store.updateRecording(recording.id, { remotePath: null, audioDeletedAt: new Date(now).toISOString() });
      }
    } catch (error) {
      result.errors.push(`${recording.title}: ${error instanceof Error ? error.message : 'could not delete audio'}`);
    }
  }
  return result;
}
