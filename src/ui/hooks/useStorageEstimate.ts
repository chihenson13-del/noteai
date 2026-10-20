import { useEffect, useState } from 'react';

export interface StorageEstimateState {
  usageBytes: number | null;
  quotaBytes: number | null;
  /** quota - usage; null when the browser cannot estimate. */
  freeBytes: number | null;
}

/** Browser storage estimate, refreshed periodically while the component is mounted. */
export function useStorageEstimate(refreshMs = 15_000): StorageEstimateState {
  const [state, setState] = useState<StorageEstimateState>({ usageBytes: null, quotaBytes: null, freeBytes: null });

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (cancelled || !estimate) return;
        const usage = estimate.usage ?? null;
        const quota = estimate.quota ?? null;
        setState({ usageBytes: usage, quotaBytes: quota, freeBytes: usage !== null && quota !== null ? Math.max(0, quota - usage) : null });
      } catch {
        /* estimate unavailable */
      }
    };
    void read();
    const timer = setInterval(() => void read(), refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshMs]);

  return state;
}
