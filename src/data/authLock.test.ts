import { afterEach, describe, expect, it, vi } from 'vitest';
import { authLock, describeAuthFailure } from './supabaseBackend';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authLock', () => {
  it('runs the function directly when the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    await expect(authLock('k', 5000, async () => 42)).resolves.toBe(42);
  });

  it('takes the lock when it is free and returns the result', async () => {
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => callback({ name: 'k' }));
    vi.stubGlobal('navigator', { locks: { request } });
    await expect(authLock('k', 5000, async () => 'ok')).resolves.toBe('ok');
    expect(request).toHaveBeenCalledWith('k', { mode: 'exclusive', ifAvailable: true }, expect.any(Function));
  });

  it('does not wait behind another tab that holds the lock: it just runs', async () => {
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => callback(null));
    vi.stubGlobal('navigator', { locks: { request } });
    const fn = vi.fn(async () => 'ran anyway');
    await expect(authLock('k', 5000, fn)).resolves.toBe('ran anyway');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('describeAuthFailure', () => {
  it('gives a short readable reason', () => {
    expect(describeAuthFailure({ name: 'AuthApiError', status: 403, message: 'Email link is invalid  or has expired' })).toBe(
      'AuthApiError 403: Email link is invalid or has expired',
    );
    expect(describeAuthFailure({})).toBe('Error:');
    expect(describeAuthFailure({ name: 'X', message: 'y'.repeat(500) }).length).toBeLessThanOrEqual(140);
  });
});
