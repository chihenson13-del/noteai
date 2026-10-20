import { describe, expect, it } from 'vitest';
import { MIME_CANDIDATES, baseMimeType, extensionForMime, minutesWithinLimit, pickRecorderMimeType } from './audioMime';
import { notesToMarkdown, notesToPlainText, transcriptToExportText } from './exporters';
import { queryLibrary, DEFAULT_LIBRARY_QUERY } from './library';
import {
  INITIAL_RECORDER_STATE,
  elapsedMs,
  isSessionLive,
  isStalled,
  recorderReducer,
  type RecorderEvent,
  type RecorderMachineState,
} from './recordingMachine';
import { parseSettings, titleSchema } from './schemas';
import { nextStage, statusLabel, isProcessing } from './status';
import { countMatches, highlightParts, matchingSegmentIndexes, paragraphsFromText, transcriptToPlainText } from './transcript';
import { makeRecording as rec } from '../test/factories';
import { DEFAULT_SETTINGS, type ActionItem, type Notes } from './types';

function reduce(events: RecorderEvent[], from: RecorderMachineState = INITIAL_RECORDER_STATE): RecorderMachineState {
  return events.reduce(recorderReducer, from);
}

const start: RecorderEvent[] = [
  { type: 'START_REQUESTED', sessionId: 's1', title: 'Standup', now: 0 },
  { type: 'STARTED', now: 1000 },
];

describe('recorder state machine', () => {
  it('only shows "recording" after an explicit STARTED event', () => {
    const requesting = reduce(start.slice(0, 1));
    expect(requesting.phase).toBe('requesting');
    expect(isSessionLive(requesting)).toBe(true);
    expect(reduce(start).phase).toBe('recording');
  });

  it('does not count paused time', () => {
    const state = reduce([...start, { type: 'PAUSE', now: 6000 }, { type: 'RESUME', now: 20000 }]);
    expect(state.phase).toBe('recording');
    expect(elapsedMs(state, 23000)).toBe(5000 + 3000);
  });

  it('flips to interrupted when capture stops and does not count that time', () => {
    const state = reduce([
      ...start,
      { type: 'INTERRUPTED', reason: 'track_muted', message: 'muted', now: 11000 },
    ]);
    expect(state.phase).toBe('interrupted');
    expect(state.interruptions).toHaveLength(1);
    expect(elapsedMs(state, 60000)).toBe(10000);
  });

  it('recovers from an interruption and keeps the history', () => {
    const state = reduce([
      ...start,
      { type: 'INTERRUPTED', reason: 'stalled', message: 'stalled', now: 5000 },
      { type: 'RECOVERED', now: 9000 },
    ]);
    expect(state.phase).toBe('recording');
    expect(state.interruption).toBeNull();
    expect(state.interruptions).toHaveLength(1);
    expect(elapsedMs(state, 10000)).toBe(4000 + 1000);
  });

  it('ignores impossible transitions', () => {
    expect(reduce([{ type: 'PAUSE', now: 1 }]).phase).toBe('idle');
    expect(reduce([...start, { type: 'RESUME', now: 5 }]).phase).toBe('recording');
    expect(reduce([...start, { type: 'RECOVERED', now: 5 }]).phase).toBe('recording');
    expect(reduce([{ type: 'STOPPED' }]).phase).toBe('idle');
    // a paused session cannot be "interrupted": nothing is capturing
    const paused = reduce([...start, { type: 'PAUSE', now: 2000 }, { type: 'INTERRUPTED', reason: 'stalled', message: '', now: 3000 }]);
    expect(paused.phase).toBe('paused');
  });

  it('stop settles time and returns to idle', () => {
    const stopping = reduce([...start, { type: 'STOP_REQUESTED', now: 4000 }]);
    expect(stopping.phase).toBe('stopping');
    expect(stopping.accumulatedMs).toBe(3000);
    expect(reduce([{ type: 'STOPPED' }], stopping).phase).toBe('idle');
  });

  it('a fatal failure ends the session as an error and stops the clock', () => {
    const state = reduce([...start, { type: 'FAILED', error: { code: 'mic_ended', message: 'gone' }, now: 8000 }]);
    expect(state.phase).toBe('error');
    expect(state.error?.code).toBe('mic_ended');
    expect(elapsedMs(state, 99000)).toBe(7000);
    expect(isSessionLive(state)).toBe(false);
  });

  it('start failure goes to error and can be retried', () => {
    const failed = reduce([
      { type: 'START_REQUESTED', sessionId: 'a', title: 't', now: 0 },
      { type: 'START_FAILED', error: { code: 'MIC_DENIED', message: 'blocked' } },
    ]);
    expect(failed.phase).toBe('error');
    expect(reduce([{ type: 'START_REQUESTED', sessionId: 'b', title: 't', now: 5 }], failed).phase).toBe('requesting');
  });

  it('detects stalled capture only while recording', () => {
    const recording = reduce([...start, { type: 'CHUNK', now: 2000 }]);
    expect(isStalled(recording, 5000, 4000)).toBe(false);
    expect(isStalled(recording, 6500, 4000)).toBe(true);
    const paused = reduce([{ type: 'PAUSE', now: 3000 }], recording);
    expect(isStalled(paused, 60000, 4000)).toBe(false);
  });

  it('tracks tab visibility only for live sessions', () => {
    expect(reduce([{ type: 'VISIBILITY', hidden: true, now: 1 }]).hiddenSince).toBeNull();
    const hidden = reduce([...start, { type: 'VISIBILITY', hidden: true, now: 3000 }]);
    expect(hidden.hiddenSince).toBe(3000);
    expect(reduce([{ type: 'VISIBILITY', hidden: false, now: 4000 }], hidden).hiddenSince).toBeNull();
  });
});

describe('audio mime helpers', () => {
  it('picks the first supported candidate', () => {
    expect(pickRecorderMimeType((m) => m === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecorderMimeType(() => true)).toBe(MIME_CANDIDATES[0]);
    expect(pickRecorderMimeType(() => false)).toBeNull();
    expect(
      pickRecorderMimeType(() => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });

  it('maps mime types to extensions', () => {
    expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMime('audio/mp4')).toBe('m4a');
    expect(extensionForMime('audio/ogg;codecs=opus')).toBe('ogg');
    expect(baseMimeType('Audio/WebM; codecs=opus')).toBe('audio/webm');
  });

  it('estimates how many minutes fit the provider limit', () => {
    expect(minutesWithinLimit('standard', 25 * 1024 * 1024)).toBeGreaterThan(100);
    expect(minutesWithinLimit('high', 25 * 1024 * 1024)).toBeLessThan(minutesWithinLimit('economy', 25 * 1024 * 1024));
  });
});

describe('library query', () => {
  const list = [
    rec({ id: 'a', title: 'Budget review', createdAt: '2026-01-01T09:00:00Z', durationMs: 300_000, status: 'completed' }),
    rec({ id: 'b', title: 'alpha planning', createdAt: '2026-01-03T09:00:00Z', durationMs: 60_000, status: 'local' }),
    rec({ id: 'c', title: 'Zebra interview', createdAt: '2026-01-02T09:00:00Z', durationMs: 900_000, status: 'failed' }),
  ];
  const transcripts = new Map([['a', 'we discussed the quarterly roadmap and hiring']]);

  it('sorts by date descending by default', () => {
    expect(queryLibrary(list, transcripts, DEFAULT_LIBRARY_QUERY).map((h) => h.recording.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by title and duration, both directions', () => {
    const ids = (sort: 'title' | 'duration', direction: 'asc' | 'desc') =>
      queryLibrary(list, transcripts, { ...DEFAULT_LIBRARY_QUERY, sort, direction }).map((h) => h.recording.id);
    expect(ids('title', 'asc')).toEqual(['b', 'a', 'c']);
    expect(ids('duration', 'desc')).toEqual(['c', 'a', 'b']);
    expect(ids('duration', 'asc')).toEqual(['b', 'a', 'c']);
  });

  it('filters by status', () => {
    const hits = queryLibrary(list, transcripts, { ...DEFAULT_LIBRARY_QUERY, status: 'failed' });
    expect(hits.map((h) => h.recording.id)).toEqual(['c']);
  });

  it('searches titles and transcripts and reports where it matched', () => {
    const byTitle = queryLibrary(list, transcripts, { ...DEFAULT_LIBRARY_QUERY, query: 'ALPHA' });
    expect(byTitle.map((h) => [h.recording.id, h.matchedIn])).toEqual([['b', ['title']]]);
    const byTranscript = queryLibrary(list, transcripts, { ...DEFAULT_LIBRARY_QUERY, query: 'roadmap' });
    expect(byTranscript.map((h) => [h.recording.id, h.matchedIn])).toEqual([['a', ['transcript']]]);
    expect(queryLibrary(list, transcripts, { ...DEFAULT_LIBRARY_QUERY, query: 'nothing-like-this' })).toEqual([]);
  });
});

describe('transcript helpers', () => {
  const segments = [
    { startMs: 0, endMs: 4000, text: 'Welcome everyone to the meeting.' },
    { startMs: 4000, endMs: 9000, text: 'First topic is the budget.' },
    { startMs: 3_725_000, endMs: 3_730_000, text: 'Budget approved.' },
  ];

  it('finds matching segments case-insensitively', () => {
    expect(matchingSegmentIndexes(segments, 'BUDGET')).toEqual([1, 2]);
    expect(matchingSegmentIndexes(segments, '  ')).toEqual([]);
  });

  it('highlights matches without breaking on regex characters', () => {
    expect(highlightParts('Cost is $5 (approx).', '$5 (')).toEqual([
      { text: 'Cost is ', match: false },
      { text: '$5 (', match: true },
      { text: 'approx).', match: false },
    ]);
    expect(highlightParts('nothing', '')).toEqual([{ text: 'nothing', match: false }]);
    expect(countMatches('a b A b a', 'a')).toBe(3);
  });

  it('formats a plain-text transcript with hour-aware timestamps', () => {
    const text = transcriptToPlainText({ text: '', segments }, true);
    expect(text.split('\n')).toEqual([
      '[0:00] Welcome everyone to the meeting.',
      '[0:04] First topic is the budget.',
      '[1:02:05] Budget approved.',
    ]);
    expect(transcriptToPlainText({ text: 'raw text', segments: [] })).toBe('raw text');
  });

  it('splits timestamp-less transcripts into paragraphs without inventing timestamps', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const paragraphs = paragraphsFromText(long, 200);
    expect(paragraphs.length).toBeGreaterThan(2);
    expect(paragraphs.join(' ')).toBe(long);
  });
});

describe('exports', () => {
  const recording = { title: 'Weekly sync', createdAt: '2026-01-10T10:00:00.000Z', durationMs: 125_000 };
  const notes: Notes = {
    recordingId: 'r',
    summary: 'We aligned on the launch.',
    keyTakeaways: [
      { text: 'Launch moves to May', atMs: 72_000 },
      { text: ' ', atMs: null },
    ],
    decisions: [{ text: 'Hire a designer', atMs: null }],
    chapters: [{ title: 'Launch', startMs: 0, endMs: 60_000, points: [{ text: 'Date', atMs: 5000 }] }],
    topics: [],
    provider: 'anthropic',
    model: 'claude-test',
    userEdited: true,
    createdAt: '',
    updatedAt: '',
  };
  const items: ActionItem[] = [
    { id: '2', recordingId: 'r', text: 'Send plan', assignee: 'Sam', dueDate: '2026-02-01', done: true, sortOrder: 1, atMs: null },
    { id: '1', recordingId: 'r', text: 'Book room', assignee: null, dueDate: null, done: false, sortOrder: 0, atMs: null },
  ];

  it('renders markdown with sections, ordered tasks and an AI disclaimer', () => {
    const md = notesToMarkdown(recording, notes, items);
    expect(md).toContain('# Weekly sync');
    expect(md).toContain('## Summary');
    expect(md).toContain('- Launch moves to May');
    expect(md).not.toContain('- \n');
    expect(md.indexOf('Book room')).toBeLessThan(md.indexOf('Send plan'));
    expect(md).toContain('- [x] Send plan (@Sam, due 2026-02-01)');
    expect(md).toContain('### Launch');
    expect(md).toContain('AI-generated notes (anthropic, claude-test). Edited by you');
  });

  it('is explicit when there are no notes', () => {
    expect(notesToMarkdown(recording, null, [])).toContain('No notes have been generated');
  });

  it('plain text drops markdown markers', () => {
    const text = notesToPlainText(recording, notes, items);
    expect(text).not.toMatch(/^#/m);
    expect(text).toContain('Summary');
  });

  it('transcript export header names the provider', () => {
    const out = transcriptToExportText(
      recording,
      { recordingId: 'r', language: 'en', text: 'hi', segments: [{ startMs: 0, endMs: 1, text: 'hi' }], provider: 'openai', model: 'whisper-1', createdAt: '' },
      true,
    );
    expect(out).toContain('Transcribed by openai (whisper-1)');
    expect(out).toContain('[0:00] hi');
  });
});

describe('settings & titles', () => {
  it('falls back to defaults field by field', () => {
    const parsed = parseSettings({ quality: 'high', language: 5, summaryLength: 'huge', audioRetentionDays: 30, junk: true });
    expect(parsed.quality).toBe('high');
    expect(parsed.language).toBe(DEFAULT_SETTINGS.language);
    expect(parsed.summaryLength).toBe(DEFAULT_SETTINGS.summaryLength);
    expect(parsed.audioRetentionDays).toBe(30);
    expect('junk' in parsed).toBe(false);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('validates titles', () => {
    expect(titleSchema.safeParse('  Team   sync ').data).toBe('Team sync');
    expect(titleSchema.safeParse('   ').success).toBe(false);
    expect(titleSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });
});

describe('status helpers', () => {
  it('derives the next stage to run', () => {
    expect(nextStage({ status: 'local', failedStage: null, remotePath: null })).toBe('upload');
    expect(nextStage({ status: 'failed', failedStage: 'summarize', remotePath: 'p' })).toBe('summarize');
    expect(nextStage({ status: 'completed', failedStage: null, remotePath: 'p' })).toBeNull();
  });

  it('labels failures with their stage', () => {
    expect(statusLabel({ status: 'failed', failedStage: 'transcribe' })).toBe('Transcription failed');
    expect(statusLabel({ status: 'completed', failedStage: null })).toBe('Completed');
    expect(isProcessing('transcribing')).toBe(true);
    expect(isProcessing('failed')).toBe(false);
  });
});
