import { describe, expect, it } from 'vitest';
import { buildExtractiveNotes, cleanSegments, splitSentences } from './extractiveNotes';
import type { TranscriptSegment } from './types';

const options = { summaryLength: 'standard' as const, extractActionItems: true, extractDecisions: true };

function seg(startMs: number, text: string, endMs = startMs + 4000): TranscriptSegment {
  return { startMs, endMs, text };
}

describe('splitSentences', () => {
  it('splits on sentence ends and keeps the time of the segment each sentence starts in', () => {
    const sentences = splitSentences({
      text: '',
      segments: [seg(0, 'Welcome everyone. Today we look at the budget'), seg(5000, 'and the hiring plan. Any questions?')],
    });
    expect(sentences.map((s) => s.text)).toEqual([
      'Welcome everyone.',
      'Today we look at the budget and the hiring plan.',
      'Any questions?',
    ]);
    expect(sentences.map((s) => s.atMs)).toEqual([0, 0, 5000]);
  });

  it('works without timestamps and gives unknown times', () => {
    const sentences = splitSentences({ text: 'One thing. Another thing!', segments: [] });
    expect(sentences).toHaveLength(2);
    expect(sentences.every((s) => s.atMs === null)).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(splitSentences({ text: '   ', segments: [] })).toEqual([]);
  });
});

describe('buildExtractiveNotes', () => {
  const segments = [
    seg(0, 'Okay let us start with the launch date for the new mobile app.'),
    seg(6000, 'We decided to launch the mobile app on the first of June.'),
    seg(12000, 'The mobile app budget is fifty thousand dollars for the launch.'),
    seg(18000, 'Sam will send the launch checklist to the whole team by Friday.'),
    seg(24000, 'The weather has been quite nice this week.'),
    seg(30000, 'We need to book the venue for the launch party.'),
  ];
  const transcript = { text: segments.map((s) => s.text).join(' '), segments };

  it('only ever uses sentences that are in the transcript, each with its real time', () => {
    const { notes } = buildExtractiveNotes(transcript, options, 36_000);
    const sentenceSet = new Map(splitSentences(transcript).map((s) => [s.text, s.atMs]));
    for (const item of [...notes.keyTakeaways, ...notes.decisions]) {
      expect(sentenceSet.has(item.text)).toBe(true);
      expect(item.atMs).toBe(sentenceSet.get(item.text));
    }
    for (const sentence of notes.summary.split(/(?<=\.)\s+/)) {
      expect(sentenceSet.has(sentence)).toBe(true);
    }
    expect(notes.provider).toBe('on-device');
  });

  it('finds decisions and action items by phrase, with their times', () => {
    const { notes, actionItems } = buildExtractiveNotes(transcript, options, 36_000);
    expect(notes.decisions.map((d) => d.text)).toEqual(['We decided to launch the mobile app on the first of June.']);
    expect(actionItems.map((a) => a.text)).toEqual([
      'Sam will send the launch checklist to the whole team by Friday.',
      'We need to book the venue for the launch party.',
    ]);
    expect(actionItems.map((a) => a.atMs)).toEqual([18000, 30000]);
    expect(actionItems.every((a) => a.done === false)).toBe(true);
  });

  it('respects the extraction toggles', () => {
    const { notes, actionItems } = buildExtractiveNotes(
      transcript,
      { summaryLength: 'brief', extractActionItems: false, extractDecisions: false },
      36_000,
    );
    expect(notes.decisions).toEqual([]);
    expect(actionItems).toEqual([]);
  });

  it('summarises a very short note as itself and invents nothing', () => {
    const { notes, actionItems } = buildExtractiveNotes(
      { text: 'Hello testing one two three.', segments: [seg(0, 'Hello testing one two three.')] },
      options,
      6000,
    );
    expect(notes.summary).toBe('Hello testing one two three.');
    expect(notes.keyTakeaways).toEqual([]);
    expect(notes.decisions).toEqual([]);
    expect(actionItems).toEqual([]);
    expect(notes.chapters).toEqual([]);
  });

  it('handles an empty transcript', () => {
    const { notes } = buildExtractiveNotes({ text: '', segments: [] }, options, 0);
    expect(notes.summary).toBe('');
  });

  it('builds time-ordered chapters only for longer recordings', () => {
    const long: TranscriptSegment[] = [];
    const words = ['budget', 'hiring', 'roadmap', 'security', 'pricing', 'support'];
    for (let i = 0; i < 24; i += 1) {
      const topic = words[Math.floor(i / 4)]!;
      long.push(seg(i * 30_000, `We spent a while discussing the ${topic} ${topic} situation and the ${topic} numbers for this quarter.`));
    }
    const { notes } = buildExtractiveNotes({ text: long.map((s) => s.text).join(' '), segments: long }, options, 12 * 60_000);
    expect(notes.chapters.length).toBeGreaterThanOrEqual(2);
    const starts = notes.chapters.map((c) => c.startMs as number);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(notes.chapters[0]!.title.toLowerCase()).toContain('budget');
  });
});

describe('cleanSegments', () => {
  it('drops non-speech tags, empty text and runaway repeats', () => {
    const cleaned = cleanSegments([
      seg(0, ' [BLANK_AUDIO] '),
      seg(1000, '(music)'),
      seg(2000, '...'),
      seg(3000, 'Thank you for joining.'),
      seg(4000, 'Thank you for joining.'),
      seg(5000, 'Thank you for joining.'),
      seg(6000, 'Thank you for joining.'),
      seg(7000, 'Next topic.'),
    ]);
    expect(cleaned.map((s) => s.text)).toEqual(['Thank you for joining.', 'Thank you for joining.', 'Next topic.']);
  });
});
