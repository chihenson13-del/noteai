import type { Transcript, TranscriptSegment } from './types';
import { formatTimestamp } from '../lib/format';

export interface TextPart {
  text: string;
  match: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split `text` into parts so the UI can highlight case-insensitive matches of `query`. */
export function highlightParts(text: string, query: string): TextPart[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const regex = new RegExp(`(${escapeRegExp(q)})`, 'gi');
  const parts: TextPart[] = [];
  for (const piece of text.split(regex)) {
    if (piece === '') continue;
    parts.push({ text: piece, match: piece.toLowerCase() === q.toLowerCase() });
  }
  return parts.length ? parts : [{ text, match: false }];
}

export function countMatches(text: string, query: string): number {
  const q = query.trim();
  if (!q) return 0;
  const regex = new RegExp(escapeRegExp(q), 'gi');
  return (text.match(regex) ?? []).length;
}

/** Indices of the segments that contain `query`. */
export function matchingSegmentIndexes(segments: TranscriptSegment[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const result: number[] = [];
  segments.forEach((segment, index) => {
    if (segment.text.toLowerCase().includes(q)) result.push(index);
  });
  return result;
}

/**
 * Providers that do not return timestamps give a single text blob. Turn it into readable
 * paragraphs (without inventing timestamps) so the screen is not a wall of text.
 */
export function paragraphsFromText(text: string, maxChars = 420): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const paragraphs: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (current && (current + ' ' + sentence).length > maxChars) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export function transcriptToPlainText(transcript: Pick<Transcript, 'text' | 'segments'>, withTimestamps = true): string {
  if (transcript.segments.length === 0) return transcript.text.trim();
  return transcript.segments
    .map((segment) => (withTimestamps ? `[${formatTimestamp(segment.startMs)}] ${segment.text.trim()}` : segment.text.trim()))
    .join('\n');
}

/** Fuzzy "does this transcript contain the query" used by library search. */
export function transcriptContains(transcriptText: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || !transcriptText) return false;
  return transcriptText.toLowerCase().includes(q);
}
