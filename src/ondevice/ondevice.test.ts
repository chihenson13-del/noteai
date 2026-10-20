import { describe, expect, it } from 'vitest';
import { peakAmplitude, planWindows, rmsAmplitude } from './audio';
import { friendlyEngineError } from './transcriber';

const RATE = 16_000;

describe('audio windows', () => {
  it('returns one window for short audio', () => {
    const samples = new Float32Array(RATE * 6).fill(0.1);
    expect(planWindows(samples, 30 * RATE, 5 * RATE)).toEqual([{ start: 0, end: samples.length }]);
  });

  it('covers every sample exactly once, in order, with no window longer than the limit', () => {
    const samples = new Float32Array(RATE * 95);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 50) * 0.3;
    const windows = planWindows(samples, 30 * RATE, 5 * RATE);
    expect(windows[0]!.start).toBe(0);
    expect(windows.at(-1)!.end).toBe(samples.length);
    for (let i = 0; i < windows.length; i += 1) {
      expect(windows[i]!.end - windows[i]!.start).toBeLessThanOrEqual(30 * RATE);
      expect(windows[i]!.end).toBeGreaterThan(windows[i]!.start);
      if (i > 0) expect(windows[i]!.start).toBe(windows[i - 1]!.end);
    }
  });

  it('cuts at the quietest moment near the end of a window instead of mid-word', () => {
    const samples = new Float32Array(RATE * 40).fill(0.3);
    // A 100 ms pause at 28.0 s, inside the last 5 s of the first window.
    samples.fill(0, 28 * RATE, 28 * RATE + RATE / 10);
    const [first] = planWindows(samples, 30 * RATE, 5 * RATE);
    expect(first!.end).toBeGreaterThanOrEqual(28 * RATE);
    expect(first!.end).toBeLessThanOrEqual(28 * RATE + RATE / 10);
  });

  it('measures peak and rms', () => {
    const samples = Float32Array.from([0, 0.5, -0.8, 0.1]);
    expect(peakAmplitude(samples)).toBeCloseTo(0.8);
    expect(rmsAmplitude(new Float32Array(100))).toBe(0);
    expect(rmsAmplitude(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5);
  });
});

describe('engine errors', () => {
  it('explains memory and download failures in plain language', () => {
    expect(friendlyEngineError('std::bad_alloc')).toMatch(/ran out of memory/i);
    expect(friendlyEngineError('Failed to fetch')).toMatch(/could not be loaded/i);
    expect(friendlyEngineError('boom')).toBe('Transcription failed: boom');
  });
});
