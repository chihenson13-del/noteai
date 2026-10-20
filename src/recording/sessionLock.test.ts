import { describe, expect, it } from 'vitest';
import { holdSessionLock, isSessionLockHeld } from './sessionLock';

/** Minimal in-memory LockManager: exclusive locks, ifAvailable support. */
function fakeLocks() {
  const held = new Set<string>();
  return {
    held,
    async request(name: string, a: unknown, b?: unknown) {
      const options = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
      const callback = (typeof a === 'function' ? a : b) as (lock: unknown) => unknown;
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        throw new Error('would block');
      }
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  } as never as Pick<LockManager, 'request'> & { held: Set<string> };
}

describe('session lock', () => {
  it('reports a held session as alive and a released one as abandoned', async () => {
    const locks = fakeLocks();
    expect(await isSessionLockHeld('s1', locks)).toBe(false);

    const release = holdSessionLock('s1', locks);
    await Promise.resolve();
    await Promise.resolve();
    expect(await isSessionLockHeld('s1', locks)).toBe(true);
    expect(await isSessionLockHeld('other', locks)).toBe(false);

    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await isSessionLockHeld('s1', locks)).toBe(false);
  });

  it('degrades to "unknown" when Web Locks are unavailable', async () => {
    expect(await isSessionLockHeld('s1', null)).toBeNull();
    expect(() => holdSessionLock('s1', null)()).not.toThrow();
  });
});
