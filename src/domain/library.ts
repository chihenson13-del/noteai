import type { Recording, RecordingStatus } from './types';
import { transcriptContains } from './transcript';

export type SortKey = 'date' | 'duration' | 'title';
export type SortDirection = 'asc' | 'desc';

/** `collection` value that matches recordings without a collection. */
export const NO_COLLECTION = '__none__';

export interface LibraryQuery {
  query: string;
  status: RecordingStatus | 'all';
  sort: SortKey;
  direction: SortDirection;
  /** 'all', NO_COLLECTION, or an exact collection name. */
  collection: string;
  /** Pinned recordings are listed first (within the chosen sort). */
  pinnedFirst: boolean;
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  query: '',
  status: 'all',
  sort: 'date',
  direction: 'desc',
  collection: 'all',
  pinnedFirst: true,
};

export interface LibraryHit {
  recording: Recording;
  matchedIn: Array<'title' | 'transcript'>;
}

function compare(a: Recording, b: Recording, sort: SortKey): number {
  switch (sort) {
    case 'duration':
      return a.durationMs - b.durationMs;
    case 'title':
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
    case 'date':
    default:
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  }
}

/**
 * Filters by processing status and collection, matches the search text against titles and
 * transcripts, then sorts. Pure and deterministic (ties fall back to creation time, then id).
 */
export function queryLibrary(
  recordings: Recording[],
  transcriptTextById: ReadonlyMap<string, string>,
  query: LibraryQuery,
): LibraryHit[] {
  const text = query.query.trim().toLowerCase();
  const hits: LibraryHit[] = [];
  for (const recording of recordings) {
    if (query.status !== 'all' && recording.status !== query.status) continue;
    if (query.collection === NO_COLLECTION && recording.collection !== null) continue;
    if (query.collection !== 'all' && query.collection !== NO_COLLECTION && recording.collection !== query.collection) continue;
    const matchedIn: LibraryHit['matchedIn'] = [];
    if (text) {
      if (recording.title.toLowerCase().includes(text)) matchedIn.push('title');
      if (transcriptContains(transcriptTextById.get(recording.id), text)) matchedIn.push('transcript');
      if (matchedIn.length === 0) continue;
    }
    hits.push({ recording, matchedIn });
  }
  const direction = query.direction === 'asc' ? 1 : -1;
  hits.sort((a, b) => {
    if (query.pinnedFirst && a.recording.pinned !== b.recording.pinned) return a.recording.pinned ? -1 : 1;
    const primary = compare(a.recording, b.recording, query.sort) * direction;
    if (primary !== 0) return primary;
    const byDate = Date.parse(b.recording.createdAt) - Date.parse(a.recording.createdAt);
    if (byDate !== 0) return byDate;
    return a.recording.id.localeCompare(b.recording.id);
  });
  return hits;
}

export interface CollectionSummary {
  name: string;
  count: number;
}

/** Collections in use, most populated first (then alphabetical). */
export function collectionsOf(recordings: Recording[]): CollectionSummary[] {
  const counts = new Map<string, number>();
  for (const recording of recordings) {
    if (recording.collection) counts.set(recording.collection, (counts.get(recording.collection) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function normalizeCollectionName(input: string): string | null {
  const name = input.replace(/\s+/g, ' ').trim().slice(0, 40);
  return name === '' ? null : name;
}
