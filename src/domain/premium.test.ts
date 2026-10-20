import { describe, expect, it } from 'vitest';
import { makeActionItem, makeNotes, makeRecording } from '../test/factories';
import { attentionItems } from './attention';
import { LOW_SPACE_BYTES, SAVE_LAG_WARN_MS, describeInputLevel, formatSavedAgo, summarizeCaptureHealth, type HealthInput } from './captureHealth';
import { notesToHtmlDocument, notesToMarkdown, escapeHtml } from './exporters';
import { DEFAULT_LIBRARY_QUERY, NO_COLLECTION, collectionsOf, normalizeCollectionName, queryLibrary } from './library';
import { coerceChapters, coerceMoments, coerceNoteItems, coerceNotes, withRecordingDefaults } from './migrate';
import { describeMoment, sortMoments } from './moments';
import type { Recording } from './types';

const base: HealthInput = {
  phase: 'recording',
  now: 100_000,
  lastSavedAt: 99_500,
  micMuted: false,
  persistenceWarning: null,
  wakeLock: 'active',
  freeBytes: 2 * 1024 ** 3,
};

describe('capture health', () => {
  it('is only "good" when capturing and recent audio is confirmed saved', () => {
    expect(summarizeCaptureHealth(base)).toMatchObject({ tone: 'good', label: 'All good', issues: [], savedAgoMs: 500 });
  });

  it('reports not capturing for interrupted / failed sessions regardless of other signals', () => {
    expect(summarizeCaptureHealth({ ...base, phase: 'interrupted' })).toMatchObject({ tone: 'bad', label: 'Not capturing' });
    expect(summarizeCaptureHealth({ ...base, phase: 'error' })).toMatchObject({ tone: 'bad', label: 'Not capturing' });
  });

  it('treats idle/paused as informational, not as healthy recording', () => {
    expect(summarizeCaptureHealth({ ...base, phase: 'idle' }).tone).toBe('idle');
    expect(summarizeCaptureHealth({ ...base, phase: 'paused' })).toMatchObject({ tone: 'idle', label: 'Paused' });
  });

  it('flags a muted microphone and failing storage as bad', () => {
    expect(summarizeCaptureHealth({ ...base, micMuted: true })).toMatchObject({ tone: 'bad', label: 'Needs attention' });
    const noStorage = summarizeCaptureHealth({ ...base, persistenceWarning: 'full' });
    expect(noStorage.tone).toBe('bad');
    expect(noStorage.issues.join(' ')).toMatch(/not being saved/);
  });

  it('warns about save lag, low space and a screen that may sleep', () => {
    expect(summarizeCaptureHealth({ ...base, lastSavedAt: base.now - SAVE_LAG_WARN_MS - 1 }).issues[0]).toMatch(/behind/);
    expect(summarizeCaptureHealth({ ...base, freeBytes: LOW_SPACE_BYTES - 1 }).issues[0]).toMatch(/storage/i);
    expect(summarizeCaptureHealth({ ...base, wakeLock: 'inactive' })).toMatchObject({ tone: 'warn', label: 'Check' });
    // unsupported / off are not problems by themselves
    expect(summarizeCaptureHealth({ ...base, wakeLock: 'unsupported' }).tone).toBe('good');
    expect(summarizeCaptureHealth({ ...base, wakeLock: 'off' }).tone).toBe('good');
  });

  it('formats time since the last save and the input level', () => {
    expect(formatSavedAgo(null)).toMatch(/first chunk/);
    expect(formatSavedAgo(800)).toBe('0.8 s ago');
    expect(formatSavedAgo(12_400)).toBe('12 s ago');
    expect(formatSavedAgo(150_000)).toBe('3 min ago');
    expect(['Silent', 'Low', 'Good', 'Loud']).toEqual([0, 0.2, 0.5, 0.95].map(describeInputLevel));
  });
});

describe('needs-attention queue', () => {
  it('lists failures first, then unacknowledged interruptions, newest first', () => {
    const items = attentionItems([
      makeRecording({ id: 'ok' }),
      makeRecording({ id: 'int-old', wasInterrupted: true, createdAt: '2026-01-01T00:00:00Z' }),
      makeRecording({ id: 'int-new', wasInterrupted: true, createdAt: '2026-01-05T00:00:00Z' }),
      makeRecording({ id: 'acked', wasInterrupted: true, interruptionAcknowledged: true }),
      makeRecording({ id: 'fail', status: 'failed', failedStage: 'upload', errorMessage: 'Network down' }),
    ]);
    expect(items.map((i) => i.recording.id)).toEqual(['fail', 'int-new', 'int-old']);
    expect(items[0]).toMatchObject({ kind: 'failed', message: 'Upload failed: Network down' });
  });

  it('does not double-list a failed, interrupted recording', () => {
    const items = attentionItems([makeRecording({ status: 'failed', failedStage: 'transcribe', wasInterrupted: true })]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('failed');
  });
});

describe('collections, pins and library queries', () => {
  const list: Recording[] = [
    makeRecording({ id: 'a', title: 'Alpha', collection: 'Meetings', createdAt: '2026-01-03T00:00:00Z' }),
    makeRecording({ id: 'b', title: 'Bravo', collection: 'Lectures', createdAt: '2026-01-04T00:00:00Z' }),
    makeRecording({ id: 'c', title: 'Charlie', collection: 'Meetings', createdAt: '2026-01-02T00:00:00Z', pinned: true }),
    makeRecording({ id: 'd', title: 'Delta', collection: null, createdAt: '2026-01-05T00:00:00Z' }),
  ];
  const none = new Map<string, string>();

  it('lists pinned recordings first, then sorts within each group', () => {
    expect(queryLibrary(list, none, DEFAULT_LIBRARY_QUERY).map((h) => h.recording.id)).toEqual(['c', 'd', 'b', 'a']);
    expect(queryLibrary(list, none, { ...DEFAULT_LIBRARY_QUERY, pinnedFirst: false }).map((h) => h.recording.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('filters by collection, including "unsorted"', () => {
    expect(queryLibrary(list, none, { ...DEFAULT_LIBRARY_QUERY, collection: 'Meetings' }).map((h) => h.recording.id)).toEqual(['c', 'a']);
    expect(queryLibrary(list, none, { ...DEFAULT_LIBRARY_QUERY, collection: NO_COLLECTION }).map((h) => h.recording.id)).toEqual(['d']);
  });

  it('summarises collections by size then name', () => {
    expect(collectionsOf(list)).toEqual([
      { name: 'Meetings', count: 2 },
      { name: 'Lectures', count: 1 },
    ]);
    expect(normalizeCollectionName('  Team   notes ')).toBe('Team notes');
    expect(normalizeCollectionName('   ')).toBeNull();
    expect(normalizeCollectionName('x'.repeat(60))).toHaveLength(40);
  });
});

describe('moments', () => {
  it('sorts chronologically and describes markers', () => {
    const moments = [
      { id: 'b', atMs: 5000, kind: 'action' as const, text: 'Sam owns pricing' },
      { id: 'a', atMs: 1000, kind: 'key' as const, text: '' },
    ];
    expect(sortMoments(moments).map((m) => m.id)).toEqual(['a', 'b']);
    expect(describeMoment(moments[1]!)).toBe('Key point');
    expect(describeMoment(moments[0]!)).toBe('Action: Sam owns pricing');
  });
});

describe('legacy data migration', () => {
  it('upgrades string note items and drops junk', () => {
    expect(coerceNoteItems(['One', '  ', { text: 'Two', atMs: 1500.4 }, { text: 'Three', atMs: -5 }, 7, null])).toEqual([
      { text: 'One', atMs: null },
      { text: 'Two', atMs: 1500 },
      { text: 'Three', atMs: null },
    ]);
  });

  it('coerces notes written by the previous version', () => {
    const notes = coerceNotes({
      recordingId: 'r',
      summary: 'S',
      keyTakeaways: ['Old takeaway'],
      decisions: ['Old decision'],
      topics: [{ title: 'Topic', points: ['p'] }],
      provider: 'anthropic',
      model: 'm',
    });
    expect(notes).toMatchObject({
      keyTakeaways: [{ text: 'Old takeaway', atMs: null }],
      decisions: [{ text: 'Old decision', atMs: null }],
      chapters: [],
      topics: [{ title: 'Topic', points: ['p'] }],
    });
    expect(coerceNotes(null)).toBeUndefined();
  });

  it('keeps unknown chapter times as null', () => {
    expect(coerceChapters([{ title: 'A', startMs: 'x', points: ['p'] }, { nope: true }])).toEqual([
      { title: 'A', startMs: null, endMs: null, points: [{ text: 'p', atMs: null }] },
    ]);
  });

  it('sanitises moments and fills recording defaults', () => {
    expect(coerceMoments([{ id: 'x', atMs: 10, kind: 'weird', text: 5 }, { id: 'y' }, { id: 'z', atMs: 5, kind: 'key', text: 't' }])).toEqual([
      { id: 'z', atMs: 5, kind: 'key', text: 't' },
      { id: 'x', atMs: 10, kind: 'note', text: '' },
    ]);
    const old = { ...makeRecording('r') } as Partial<Recording>;
    delete old.pinned;
    delete old.collection;
    delete old.moments;
    delete old.interruptionAcknowledged;
    expect(withRecordingDefaults(old as Recording)).toMatchObject({ pinned: false, collection: null, moments: [], interruptionAcknowledged: false });
  });
});

describe('exports with chapters and evidence', () => {
  const recording = { title: 'Sync <b>1</b>', createdAt: '2026-01-10T10:00:00.000Z', durationMs: 125_000 };
  const notes = makeNotes({
    summary: 'Para one.\n\nPara <two>.',
    keyTakeaways: [{ text: 'Ship in May', atMs: 72_000 }],
    chapters: [{ title: 'Launch', startMs: 4000, endMs: 60_000, points: [{ text: 'Date moved', atMs: 5000 }] }],
  });
  const items = [makeActionItem({ text: 'Send recap', assignee: 'Sam', atMs: 61_000, done: true })];

  it('puts evidence times in markdown', () => {
    const md = notesToMarkdown(recording, notes, items);
    expect(md).toContain('- Ship in May [1:12]');
    expect(md).toContain('### Launch (0:04)');
    expect(md).toContain('- Date moved [0:05]');
    expect(md).toContain('- [x] Send recap (@Sam) [1:01]');
  });

  it('escapes everything in the print/Word document', () => {
    const html = notesToHtmlDocument(recording, notes, items);
    expect(html).toContain('Sync &lt;b&gt;1&lt;/b&gt;');
    expect(html).toContain('<p>Para &lt;two&gt;.</p>');
    expect(html).not.toContain('<b>1</b>');
    expect(html).toContain('<h3>Launch <span class="t">0:04</span></h3>');
    expect(html).toContain('AI-generated notes');
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });

  it('says plainly when there are no notes', () => {
    expect(notesToHtmlDocument(recording, null, [])).toContain('No notes have been generated');
  });
});
