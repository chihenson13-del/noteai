import type { CloudBackend } from '../data/backend';
import type { LocalStore } from '../data/localStore';
import type { Recording } from '../domain/types';

type SyncStore = Pick<LocalStore, 'listRecordings' | 'putRecording' | 'getRecording'>;

export interface SyncResult {
  added: number;
  updated: number;
  detached: number;
}

/**
 * Merges the cloud library into the local one.
 *  - Cloud-only recordings are added (audio stays in the cloud until opened).
 *  - Newer cloud metadata (title, status, errors) updates local entries that are not
 *    currently being processed by this tab.
 *  - A local recording that vanished from the cloud (deleted on another device) is KEPT:
 *    it is only detached from the cloud so the user never loses audio they still have here.
 */
export async function syncFromCloud(
  store: SyncStore,
  backend: Pick<CloudBackend, 'fetchRecordings'>,
  isBusy: (recordingId: string) => boolean = () => false,
): Promise<SyncResult> {
  const remote = await backend.fetchRecordings();
  const local = await store.listRecordings();
  const localById = new Map(local.map((r) => [r.id, r]));
  const remoteIds = new Set(remote.map((r) => r.id));
  const result: SyncResult = { added: 0, updated: 0, detached: 0 };

  for (const cloud of remote) {
    const existing = localById.get(cloud.id);
    if (!existing) {
      await store.putRecording({ ...cloud, hasLocalAudio: false });
      result.added += 1;
      continue;
    }
    if (isBusy(existing.id)) continue;
    if (Date.parse(cloud.updatedAt) <= Date.parse(existing.updatedAt)) continue;
    const merged: Recording = {
      ...existing,
      title: cloud.title,
      status: cloud.status,
      failedStage: cloud.failedStage,
      errorMessage: cloud.errorMessage,
      remotePath: cloud.remotePath,
      language: cloud.language,
      audioDeletedAt: cloud.audioDeletedAt,
      pinned: cloud.pinned,
      collection: cloud.collection,
      moments: cloud.moments.length ? cloud.moments : existing.moments,
      checksumSha256: cloud.checksumSha256 ?? existing.checksumSha256,
      updatedAt: cloud.updatedAt,
      inCloud: true,
    };
    await store.putRecording(merged);
    result.updated += 1;
  }

  for (const existing of local) {
    if (!existing.inCloud || remoteIds.has(existing.id) || isBusy(existing.id)) continue;
    if (existing.hasLocalAudio) {
      await store.putRecording({
        ...existing,
        inCloud: false,
        remotePath: null,
        status: existing.status === 'completed' ? 'completed' : 'local',
        updatedAt: new Date().toISOString(),
      });
      result.detached += 1;
    }
  }
  return result;
}
