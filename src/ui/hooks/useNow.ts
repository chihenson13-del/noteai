import { useEffect, useState } from 'react';

/** `Date.now()` refreshed every `intervalMs` while `active` (and once on mount). */
export function useNow(intervalMs = 500, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
