/**
 * Web Locks based "this session is alive" marker.
 *
 * The recording tab holds a lock for its session for as long as it records. When the tab is
 * reloaded, crashed or closed the browser releases the lock immediately, so on the next page
 * load an unfinished session whose lock is free can be recovered right away instead of
 * waiting for a heartbeat to go stale. Browsers without Web Locks fall back to heartbeats.
 */

type LockManagerLike = Pick<LockManager, 'request'>;

const lockName = (sessionId: string) => `noteai-recording-${sessionId}`;

function defaultLocks(): LockManagerLike | null {
  return typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;
}

/** Acquires the session lock in the background. Returns a function that releases it. */
export function holdSessionLock(sessionId: string, locks: LockManagerLike | null = defaultLocks()): () => void {
  if (!locks) return () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void locks.request(lockName(sessionId), () => held).catch(() => undefined);
  return release;
}

/**
 * true  = some tab (possibly this one) is actively recording this session
 * false = nobody holds it: the session was abandoned
 * null  = Web Locks unavailable, caller must fall back to heartbeats
 */
export async function isSessionLockHeld(sessionId: string, locks: LockManagerLike | null = defaultLocks()): Promise<boolean | null> {
  if (!locks) return null;
  try {
    return await locks.request(lockName(sessionId), { ifAvailable: true }, (lock) => lock === null);
  } catch {
    return null;
  }
}
