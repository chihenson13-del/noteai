import { useEffect, useState } from 'react';
import { elapsedMs, type RecorderMachineState } from '../../domain/recordingMachine';

/** Re-renders ~4×/s while capture is active so the timer ticks; paused/idle timers are static. */
export function useElapsed(state: RecorderMachineState): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = state.activeSince !== null;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  return elapsedMs(state, ticking ? Math.max(now, state.activeSince ?? 0) : now);
}
