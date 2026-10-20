// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildShareSnapshot } from './share.ts';
import { parseShareRequest } from './validation.ts';

const ID = '3f2b8c1e-9a4d-4e6b-8a1f-0c2d4e6f8a1b';

const device = {
  title: 'Weekly planning',
  recordedAt: '2026-10-16T07:12:00.000Z',
  durationMs: 18_000,
  notes: {
    summary: 'We decided to launch on the first of June.',
    keyTakeaways: [{ text: 'Budget is $50,000.' }],
    decisions: [{ text: 'Launch on the first of June.' }],
    chapters: [],
    provider: 'on-device',
    model: 'extractive',
    userEdited: false,
  },
  actionItems: [{ text: 'Send the checklist', assignee: null, dueDate: null, done: false }],
};

describe('sharing notes made on the device', () => {
  it('accepts a device payload and normalises the date', () => {
    const result = parseShareRequest({ action: 'create', recordingId: ID, expiresInDays: 7, device });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'create') {
      expect(result.value.device?.title).toBe('Weekly planning');
      expect(result.value.device?.recordedAt).toBe('2026-10-16T07:12:00.000Z');
    }
  });

  it('still accepts a plain cloud request without a device payload', () => {
    expect(parseShareRequest({ action: 'create', recordingId: ID, expiresInDays: 1 })).toEqual({
      ok: true,
      value: { action: 'create', recordingId: ID, expiresInDays: 1 },
    });
  });

  it('rejects malformed device payloads', () => {
    const bad = [
      { ...device, title: 5 },
      { ...device, recordedAt: 'not a date' },
      { ...device, durationMs: -1 },
      { ...device, notes: null },
      { ...device, notes: { ...device.notes, summary: 1 } },
      { ...device, actionItems: 'nope' },
      { ...device, actionItems: [null] },
    ];
    for (const entry of bad) {
      expect(parseShareRequest({ action: 'create', recordingId: ID, expiresInDays: 7, device: entry }).ok).toBe(false);
    }
  });

  it('never lets a hostile payload through the snapshot: text is trimmed and bad dates are dropped', () => {
    const snapshot = buildShareSnapshot(
      { title: ` ${'x'.repeat(500)} `, recordedAt: device.recordedAt, durationMs: 1000 },
      { ...device.notes, summary: 'y'.repeat(20_000) },
      [{ text: 'z'.repeat(5000), assignee: 'A'.repeat(500), dueDate: '<script>alert(1)</script>', done: true }],
    );
    expect(snapshot.title.length).toBeLessThanOrEqual(200);
    expect(snapshot.summary.length).toBeLessThanOrEqual(6000);
    expect(snapshot.actionItems[0]!.text.length).toBeLessThanOrEqual(600);
    expect(snapshot.actionItems[0]!.assignee!.length).toBeLessThanOrEqual(80);
    expect(snapshot.actionItems[0]!.dueDate).toBeNull();
  });

  it('keeps a valid due date', () => {
    const snapshot = buildShareSnapshot(
      { title: 't', recordedAt: device.recordedAt, durationMs: 1 },
      device.notes,
      [{ text: 'a', assignee: null, dueDate: '2026-11-02', done: false }],
    );
    expect(snapshot.actionItems[0]!.dueDate).toBe('2026-11-02');
  });
});
