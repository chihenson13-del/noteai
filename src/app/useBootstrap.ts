import { useEffect } from 'react';
import { backend } from './backend';
import { localStore } from './localStore';
import { onDevice, pipeline, recorder } from './container';
import { isSessionLockHeld } from '../recording/sessionLock';
import { applyAudioRetention } from '../services/retention';
import { recoverOrphanedSessions } from '../services/recordingService';
import { syncFromCloud } from '../services/syncService';
import { useAuthStore } from '../state/authStore';
import { useLibraryStore } from '../state/libraryStore';
import { useSettingsStore } from '../state/settingsStore';
import { toast } from '../state/toastStore';

/**
 * Startup sequence (runs once per page load):
 *  1. settings + library from IndexedDB
 *  2. recover recordings left behind by a closed / crashed tab
 *  3. auth, then cloud sync, pipeline resume and retention once signed in
 */
export function useBootstrap(): void {
  const loadSettings = useSettingsStore((s) => s.load);
  const loadLibrary = useLibraryStore((s) => s.load);
  const initAuth = useAuthStore((s) => s.init);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadSettings();
      try {
        const recovered = await recoverOrphanedSessions(localStore, {
          ownSessionId: recorder?.getSnapshot().sessionId ?? null,
          isHeld: (id) => isSessionLockHeld(id),
        });
        if (recovered.length > 0 && !cancelled) {
          toast.info(
            recovered.length === 1
              ? 'A recording that was interrupted was recovered and saved to your library.'
              : `${recovered.length} interrupted recordings were recovered and saved to your library.`,
          );
        }
      } catch {
        /* storage unavailable: surfaced by the library load below */
      }
      await loadLibrary();
      try {
        // A tab that was transcribing may have been closed; give those recordings a Retry button.
        const interrupted = await onDevice.recoverInterrupted(useLibraryStore.getState().recordings);
        if (interrupted > 0 && !cancelled) await loadLibrary();
      } catch {
        /* storage hiccup: the library still shows what it can */
      }
      if (!cancelled) initAuth();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSettings, loadLibrary, initAuth]);

  // Ask the browser not to evict our IndexedDB under storage pressure (best effort).
  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!backend || !userId || !settingsLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        await syncFromCloud(localStore, backend, (id) => pipeline?.isRunning(id) ?? false);
        if (cancelled) return;
        await useLibraryStore.getState().load();
        await pipeline?.resume(useLibraryStore.getState().recordings);
        const retentionDays = useSettingsStore.getState().settings.audioRetentionDays;
        if (retentionDays !== null) {
          const result = await applyAudioRetention(localStore, backend, retentionDays);
          if (result.localDeleted + result.cloudDeleted > 0) await useLibraryStore.getState().load();
        }
      } catch {
        // Offline or backend hiccup: the local library keeps working; sync retries on next load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, settingsLoaded]);
}
