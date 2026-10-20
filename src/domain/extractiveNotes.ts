import type { ActionItem, Chapter, NoteItem, Notes, SummaryLength, TranscriptSegment } from './types';

/**
 * Notes built on the device, without any AI model.
 *
 * Everything here is *selected from* the transcript, never written: sentences are ranked by how
 * many of the recording's frequent words they contain, and decisions / action items are found by
 * simple phrase patterns. Because nothing is generated, nothing can be invented, and every item
 * carries the time it was said. The trade-off is that it is an extract, not a rewritten summary,
 * and the phrase patterns only understand English.
 */

export const ON_DEVICE_NOTES_PROVIDER = 'on-device';
export const ON_DEVICE_NOTES_MODEL = 'extractive';

export interface NotesOptions {
  summaryLength: SummaryLength;
  extractActionItems: boolean;
  extractDecisions: boolean;
}

export interface TranscriptLike {
  text: string;
  segments: TranscriptSegment[];
}

export interface Sentence {
  text: string;
  /** Start of the segment this sentence begins in, or null without timestamps. */
  atMs: number | null;
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then than that this these those is are was were be been being am do does did done have has had having ' +
      'of to in on at by for with about as into from over under again further once here there when where why how all any both ' +
      'each few more most other some such no nor not only own same so too very can will just should could would may might must ' +
      'what which who whom whose it its i me my we our you your he him his she her they them their us ' +
      'yeah okay ok well like um uh er mm hmm right know think really kind sort actually basically got get going gonna wanna ' +
      'also yes yep one two thing things lot much many still even back maybe now then than'
  ).split(' '),
);

const SUMMARY_SENTENCES: Record<SummaryLength, number> = { brief: 2, standard: 4, detailed: 7 };
const TAKEAWAY_COUNT: Record<SummaryLength, number> = { brief: 3, standard: 5, detailed: 8 };

const DECISION_CUES =
  /\b(we (have |had )?decided|i (have |had )?decided|decided (to|on|that)|the decision (is|was)|we agreed|agreed (to|on|that)|we('| wi)ll go with|let'?s go with|we('| a)re going (to|with)|settled on|it'?s (been )?(approved|settled|confirmed)|the plan is|final decision)\b/i;

const ACTION_VERBS =
  'send|email|e-mail|share|schedule|book|review|check|follow|update|prepare|finish|complete|create|write|call|contact|set|arrange|' +
  'organi[sz]e|submit|draft|fix|test|publish|deliver|handle|look|get|reach|talk|ping|notify|remind|confirm|add|remove|make|do|build|' +
  'ship|plan|research|investigate|collect|gather|order|buy|pay|sign|upload|post|print|design|implement|deploy|document|clean|move|' +
  'ask|tell|let|bring|take|put|find|figure|sort|discuss|meet|sync|file|cancel|renew|reply|respond|approve|assign|prioriti[sz]e';

const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next week|next month|eod|eow';

const ACTION_CUES = new RegExp(
  [
    '\\b(action items?|to-?do|follow[- ]?up)\\b',
    `\\b(will|'ll|shall) (also |then |still |definitely )?(need to |have to )?(${ACTION_VERBS})\\b`,
    `\\b(need|needs|has|have|got|ought) to (${ACTION_VERBS})\\b`,
    `\\b(should|must) (${ACTION_VERBS})\\b`,
    `\\blet'?s (make sure|${ACTION_VERBS})\\b`,
    "\\b(make sure|don'?t forget|remember to|remind (me|us|you))\\b",
    `\\bplease (${ACTION_VERBS})\\b`,
    `\\b(by|before) (${WEEKDAYS}|end of (the )?(day|week|month|year))\\b`,
  ].join('|'),
  'i',
);

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function contentWords(text: string): string[] {
  return wordsOf(text).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/** Splits a transcript into sentences, each tagged with the time of the segment it starts in. */
export function splitSentences(transcript: TranscriptLike): Sentence[] {
  const segments = transcript.segments.filter((s) => s.text.trim() !== '');
  let joined = '';
  const starts: Array<{ offset: number; atMs: number }> = [];

  if (segments.length > 0) {
    for (const segment of segments) {
      const text = segment.text.replace(/\s+/g, ' ').trim();
      if (joined) joined += ' ';
      starts.push({ offset: joined.length, atMs: segment.startMs });
      joined += text;
    }
  } else {
    joined = transcript.text.replace(/\s+/g, ' ').trim();
  }
  if (!joined) return [];

  const sentences: Sentence[] = [];
  const pattern = /[^.!?…]+(?:[.!?…]+["')\]]*|$)/g;
  for (const match of joined.matchAll(pattern)) {
    const text = match[0].trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    let atMs: number | null = null;
    if (starts.length > 0) {
      // The match starts at the space after the previous sentence; the sentence itself starts after it.
      const index = (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (starts[mid]!.offset <= index) lo = mid;
        else hi = mid - 1;
      }
      atMs = starts[lo]!.atMs;
    }
    sentences.push({ text, atMs });
  }
  return sentences;
}

interface Ranked extends Sentence {
  index: number;
  score: number;
}

function rank(sentences: Sentence[]): Ranked[] {
  const termFrequency = new Map<string, number>();
  const docFrequency = new Map<string, number>();
  const perSentence = sentences.map((s) => contentWords(s.text));
  for (const words of perSentence) {
    for (const word of words) termFrequency.set(word, (termFrequency.get(word) ?? 0) + 1);
    for (const word of new Set(words)) docFrequency.set(word, (docFrequency.get(word) ?? 0) + 1);
  }
  const n = sentences.length;
  return sentences.map((sentence, index) => {
    const unique = [...new Set(perSentence[index]!)];
    let total = 0;
    for (const word of unique) {
      // In long recordings a word that is in over half of the sentences carries no information.
      if (n >= 8 && (docFrequency.get(word) ?? 0) / n > 0.5) continue;
      total += termFrequency.get(word) ?? 0;
    }
    const length = wordsOf(sentence.text).length;
    let score = unique.length === 0 ? 0 : total / Math.sqrt(unique.length);
    if (length < 4) score *= 0.4;
    if (length > 45) score *= 0.6;
    if (index === 0) score *= 1.15;
    return { ...sentence, index, score };
  });
}

function toItem(sentence: Sentence): NoteItem {
  return { text: sentence.text, atMs: sentence.atMs };
}

function topKeywords(windowText: string, otherText: string, count: number): string[] {
  const inside = new Map<string, number>();
  for (const word of contentWords(windowText)) inside.set(word, (inside.get(word) ?? 0) + 1);
  const outside = new Map<string, number>();
  for (const word of contentWords(otherText)) outside.set(word, (outside.get(word) ?? 0) + 1);
  return [...inside.entries()]
    .filter(([word]) => word.length > 3)
    .map(([word, c]) => ({ word, score: c / (1 + (outside.get(word) ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
    .slice(0, count)
    .map((entry) => entry.word);
}

const MINUTE = 60_000;

function buildChapters(ranked: Ranked[], durationMs: number): Chapter[] {
  const timed = ranked.filter((s) => s.atMs !== null);
  if (durationMs < 4 * MINUTE || timed.length < 9) return [];
  const count = Math.max(2, Math.min(8, Math.round(durationMs / (4 * MINUTE)), Math.floor(timed.length / 3)));
  const windowMs = durationMs / count;
  const chapters: Chapter[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = i * windowMs;
    const to = i === count - 1 ? Infinity : (i + 1) * windowMs;
    const inside = timed.filter((s) => (s.atMs as number) >= from && (s.atMs as number) < to);
    if (inside.length === 0) continue;
    const insideText = inside.map((s) => s.text).join(' ');
    const outsideText = timed.filter((s) => !inside.includes(s)).map((s) => s.text).join(' ');
    const keywords = topKeywords(insideText, outsideText, 3);
    const points = [...inside]
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 2)
      .sort((a, b) => a.index - b.index)
      .map(toItem);
    chapters.push({
      title: keywords.length ? keywords.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(', ') : `Part ${chapters.length + 1}`,
      startMs: inside[0]!.atMs,
      endMs: Math.min(durationMs, Math.round(i === count - 1 ? durationMs : (i + 1) * windowMs)),
      points,
    });
  }
  return chapters;
}

export interface ExtractiveResult {
  notes: Omit<Notes, 'recordingId' | 'createdAt' | 'updatedAt'>;
  actionItems: Array<Omit<ActionItem, 'id' | 'recordingId'>>;
}

export function buildExtractiveNotes(transcript: TranscriptLike, options: NotesOptions, durationMs: number): ExtractiveResult {
  const sentences = splitSentences(transcript);
  const ranked = rank(sentences);

  const summaryCount = Math.min(SUMMARY_SENTENCES[options.summaryLength], ranked.length);
  const byScore = [...ranked].sort((a, b) => b.score - a.score || a.index - b.index);
  const summarySentences = byScore.slice(0, summaryCount).sort((a, b) => a.index - b.index);
  const summaryIndexes = new Set(summarySentences.map((s) => s.index));

  const takeawayPool = byScore.filter((s) => !summaryIndexes.has(s.index) && s.score > 0);
  const takeaways = takeawayPool
    .slice(0, TAKEAWAY_COUNT[options.summaryLength])
    .sort((a, b) => a.index - b.index)
    .map(toItem);

  const decisions: NoteItem[] = options.extractDecisions
    ? ranked.filter((s) => DECISION_CUES.test(s.text)).slice(0, 6).map(toItem)
    : [];

  const actionItems = options.extractActionItems
    ? ranked
        .filter((s) => ACTION_CUES.test(s.text) && wordsOf(s.text).length >= 3 && wordsOf(s.text).length <= 40)
        .slice(0, 8)
        .map((s, order) => ({
          text: s.text,
          assignee: null,
          dueDate: null,
          done: false,
          sortOrder: order,
          atMs: s.atMs,
        }))
    : [];

  const lastEnd = transcript.segments.reduce((max, s) => Math.max(max, s.endMs), 0);
  const effectiveDuration = Math.max(durationMs, lastEnd);

  return {
    notes: {
      summary: summarySentences.map((s) => s.text).join(' '),
      keyTakeaways: takeaways,
      decisions,
      chapters: buildChapters(ranked, effectiveDuration),
      topics: [],
      provider: ON_DEVICE_NOTES_PROVIDER,
      model: ON_DEVICE_NOTES_MODEL,
      userEdited: false,
    },
    actionItems,
  };
}

/** Drops text that Whisper emits for non-speech, and runaway repeats that it produces on noise. */
export function cleanSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const NON_SPEECH = /^[\s[(*♪♫-]*(blank[_ ]audio|music|applause|laughter|silence|noise|inaudible|no speech)[\s\])*♪♫.-]*$/i;
  const cleaned: TranscriptSegment[] = [];
  let repeats = 0;
  let previous = '';
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text) || NON_SPEECH.test(text)) continue;
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (key === previous) {
      repeats += 1;
      if (repeats >= 2) continue; // the 3rd and later copies of the same line are a decoding loop
    } else {
      previous = key;
      repeats = 0;
    }
    cleaned.push({ ...segment, text });
  }
  return cleaned;
}
