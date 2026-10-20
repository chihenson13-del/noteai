import { describe, expect, it, vi } from 'vitest';
import { AppError, micErrorFrom } from './errors';
import { formatBytes, formatDuration, formatDurationWords, safeFileName } from './format';
import { isUuid, newId } from './id';
import { withRetry } from './retry';

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDurationWords(45_000)).toBe('45 sec');
    expect(formatDurationWords(12 * 60_000)).toBe('12 min');
    expect(formatDurationWords(3_720_000)).toBe('1h 02m');
  });

  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25.0 MB');
  });

  it('builds safe file names', () => {
    expect(safeFileName('Q3 review: "Budget" / plan?')).toBe('Q3-review-Budget-plan');
    expect(safeFileName('Café ünïcode')).toBe('Cafe-unicode');
    expect(safeFileName('///')).toBe('recording');
    expect(safeFileName('Recording \u00b7 Oct 13, 3:43 PM')).toBe('Recording-Oct-13-3-43-PM');
  });
});

describe('ids', () => {
  it('generates valid unique uuids', () => {
    const a = newId();
    const b = newId();
    expect(isUuid(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

describe('retry', () => {
  it('retries with backoff and returns the first success', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { attempts: 4, baseDelayMs: 100, sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('stops immediately when the error is not retryable and rethrows it', async () => {
    const boom = new AppError('AUTH_REQUIRED', 'no');
    const op = vi.fn(async () => {
      throw boom;
    });
    await expect(withRetry(op, { attempts: 5, shouldRetry: () => false, sleep: async () => undefined })).rejects.toBe(boom);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts', async () => {
    const op = vi.fn(async () => {
      throw new Error('always');
    });
    await expect(withRetry(op, { attempts: 3, sleep: async () => undefined })).rejects.toThrow('always');
    expect(op).toHaveBeenCalledTimes(3);
  });
});

describe('microphone errors', () => {
  it('maps DOMException names to actionable errors', () => {
    expect(micErrorFrom({ name: 'NotAllowedError' }).code).toBe('MIC_DENIED');
    expect(micErrorFrom({ name: 'NotFoundError' }).code).toBe('MIC_NOT_FOUND');
    expect(micErrorFrom({ name: 'NotReadableError' }).code).toBe('MIC_BUSY');
    expect(micErrorFrom({ name: 'NotReadableError' }).retryable).toBe(true);
    expect(micErrorFrom(new Error('weird')).code).toBe('UNKNOWN');
  });
});
