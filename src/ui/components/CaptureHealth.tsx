import { useEffect, useRef, useState } from 'react';
import { describeInputLevel, formatSavedAgo, summarizeCaptureHealth, type HealthTone, type InputLevelLabel } from '../../domain/captureHealth';
import { formatBytes } from '../../lib/format';
import type { RecorderSnapshot } from '../../recording/recorder';
import { useWakeLockStore } from '../../state/wakeLockStore';
import { useStorageEstimate } from '../hooks/useStorageEstimate';

const TONE_CLASS: Record<HealthTone, string> = {
  good: 'badge badge--success',
  warn: 'badge badge--warning',
  bad: 'badge badge--danger',
  idle: 'badge',
};

/** Peak input level over the last ~1.5 s, as a word. Re-renders at <1 Hz, not per audio frame. */
function useRecentLevel(
  subscribe: ((listener: (level: number) => void) => () => void) | null,
  active: boolean,
): InputLevelLabel {
  const [label, setLabel] = useState<InputLevelLabel>('Silent');
  const peak = useRef(0);
  useEffect(() => {
    if (!subscribe || !active) return;
    peak.current = 0;
    const unsubscribe = subscribe((level) => {
      peak.current = Math.max(peak.current, level);
    });
    const timer = setInterval(() => {
      setLabel(describeInputLevel(peak.current));
      peak.current = 0;
    }, 1500);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [subscribe, active]);
  return label;
}

const WAKE_TEXT = {
  active: 'Staying awake',
  inactive: 'May turn off: keep this tab in front',
  off: 'Not requested (see Settings)',
  unsupported: 'Not supported by this browser',
} as const;

/**
 * Live "is my recording actually being captured and saved?" card. Everything shown is measured
 * (last confirmed write, track mute state, storage estimate); nothing is assumed.
 */
export function CaptureHealth({
  snapshot,
  subscribeLevel,
  now,
}: {
  snapshot: RecorderSnapshot;
  subscribeLevel: ((listener: (level: number) => void) => () => void) | null;
  now: number;
}) {
  const wakeLock = useWakeLockStore((s) => s.state);
  const storage = useStorageEstimate();
  const capturing = snapshot.phase === 'recording';
  const level = useRecentLevel(subscribeLevel, capturing);

  const summary = summarizeCaptureHealth({
    phase: snapshot.phase,
    now,
    lastSavedAt: snapshot.lastSavedAt,
    micMuted: snapshot.micMuted,
    persistenceWarning: snapshot.persistenceWarning,
    wakeLock,
    freeBytes: storage.freeBytes,
  });

  return (
    <section className="card health" aria-label="Capture health">
      <div className="spread">
        <h2 className="h3">Capture health</h2>
        <span className={TONE_CLASS[summary.tone]} role="status">
          {summary.label}
        </span>
      </div>

      <dl className="health-rows">
        <div>
          <dt>Microphone</dt>
          <dd>{snapshot.micMuted ? 'Muted by the browser or system' : snapshot.micLabel ? snapshot.micLabel : 'Connected'}</dd>
        </div>
        <div>
          <dt>Input level</dt>
          <dd>{capturing ? level : '—'}</dd>
        </div>
        <div>
          <dt>Saved to this device</dt>
          <dd>{snapshot.savedChunks > 0 ? formatSavedAgo(summary.savedAgoMs) : snapshot.phase === 'idle' ? '—' : 'Waiting for the first chunk'}</dd>
        </div>
        <div>
          <dt>Screen</dt>
          <dd>{WAKE_TEXT[wakeLock]}</dd>
        </div>
        <div>
          <dt>Free space</dt>
          <dd>{storage.freeBytes === null ? 'Unknown' : formatBytes(storage.freeBytes)}</dd>
        </div>
      </dl>

      {summary.issues.length > 0 && (
        <ul className="health-issues" role="alert">
          {summary.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
