import { useCallback, useSyncExternalStore } from 'react';
import { recorder } from '../../app/container';
import { INITIAL_RECORDER_STATE } from '../../domain/recordingMachine';
import type { RecorderSnapshot } from '../../recording/recorder';

const IDLE_SNAPSHOT: RecorderSnapshot = {
  ...INITIAL_RECORDER_STATE,
  mimeType: null,
  quality: null,
  persistenceWarning: null,
  lastSavedAt: null,
  savedChunks: 0,
  micLabel: null,
  micMuted: false,
  moments: [],
};

const noopSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE_SNAPSHOT;

/** Live recorder state. `null` recorder (no MediaRecorder in this browser) behaves as idle. */
export function useRecorderSnapshot(): RecorderSnapshot {
  return useSyncExternalStore(recorder?.subscribe ?? noopSubscribe, recorder?.getSnapshot ?? idleSnapshot);
}

export function useLevelSubscription(): ((listener: (level: number) => void) => () => void) | null {
  return useCallback((listener: (level: number) => void) => recorder?.subscribeLevel(listener) ?? (() => undefined), []);
}
