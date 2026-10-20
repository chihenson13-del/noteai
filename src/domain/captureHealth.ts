import type { RecorderPhase } from './recordingMachine';

export type HealthTone = 'good' | 'warn' | 'bad' | 'idle';

export type WakeLockState = 'active' | 'inactive' | 'unsupported' | 'off';

export interface HealthInput {
  phase: RecorderPhase;
  now: number;
  /** Epoch ms when the newest chunk was confirmed written to this device. */
  lastSavedAt: number | null;
  micMuted: boolean;
  persistenceWarning: string | null;
  /**
   * active = lock held; inactive = wanted but not held (page hidden / denied);
   * off = the user turned the setting off; unsupported = browser has no Wake Lock API.
   */
  wakeLock: WakeLockState;
  freeBytes: number | null;
}

export interface HealthSummary {
  tone: HealthTone;
  label: string;
  /** Short, plain-language problems (empty when everything is fine). */
  issues: string[];
  savedAgoMs: number | null;
}

/** Saved-chunks older than this mean disk writes are falling behind or capture has stalled. */
export const SAVE_LAG_WARN_MS = 5_000;
export const LOW_SPACE_BYTES = 100 * 1024 * 1024;

/**
 * Collapses the live signals into one honest status. It never reports "good" unless the
 * recorder is capturing AND recent audio is confirmed on disk.
 */
export function summarizeCaptureHealth(input: HealthInput): HealthSummary {
  const savedAgoMs = input.lastSavedAt === null ? null : Math.max(0, input.now - input.lastSavedAt);

  if (input.phase === 'idle' || input.phase === 'requesting' || input.phase === 'stopping') {
    return { tone: 'idle', label: 'Not recording', issues: [], savedAgoMs };
  }
  if (input.phase === 'interrupted' || input.phase === 'error') {
    return {
      tone: 'bad',
      label: 'Not capturing',
      issues: ['Audio is not being captured right now. What was saved so far is safe.'],
      savedAgoMs,
    };
  }
  if (input.phase === 'paused') {
    return { tone: 'idle', label: 'Paused', issues: [], savedAgoMs };
  }

  const bad: string[] = [];
  const warn: string[] = [];
  if (input.micMuted) bad.push('The microphone is muted by the browser or system.');
  if (input.persistenceWarning) bad.push('Audio is not being saved to this device.');
  if (savedAgoMs !== null && savedAgoMs > SAVE_LAG_WARN_MS) warn.push('Saving to this device is running behind.');
  if (input.freeBytes !== null && input.freeBytes < LOW_SPACE_BYTES) warn.push('Free storage is very low.');
  if (input.wakeLock === 'inactive') warn.push('The screen may turn off. Keep this tab in front.');

  if (bad.length > 0) return { tone: 'bad', label: 'Needs attention', issues: [...bad, ...warn], savedAgoMs };
  if (warn.length > 0) return { tone: 'warn', label: 'Check', issues: warn, savedAgoMs };
  return { tone: 'good', label: 'All good', issues: [], savedAgoMs };
}

/** "0.8 s ago", "12 s ago", "2 min ago". */
export function formatSavedAgo(ms: number | null): string {
  if (ms === null) return 'Waiting for the first chunk';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s ago`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  return `${Math.round(ms / 60_000)} min ago`;
}

export type InputLevelLabel = 'Silent' | 'Low' | 'Good' | 'Loud';

/** Maps the 0..1 meter value to words. Silence while "recording" is worth surfacing to the user. */
export function describeInputLevel(level: number): InputLevelLabel {
  if (level < 0.08) return 'Silent';
  if (level < 0.3) return 'Low';
  if (level < 0.9) return 'Good';
  return 'Loud';
}
