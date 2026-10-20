import type { ActionItem, Chapter, Moment, MomentKind, NoteItem, NoteTopic, Notes, Recording } from './types';

/**
 * Normalizers for data that may have been written by an older version of the app (or by a
 * cloud row). Everything stored locally or fetched is passed through these so the rest of
 * the UI can rely on the current shapes.
 */

const MOMENT_KINDS: MomentKind[] = ['key', 'action', 'question', 'note'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Accepts legacy strings or `{ text, atMs }` objects. */
export function coerceNoteItems(value: unknown): NoteItem[] {
  if (!Array.isArray(value)) return [];
  const items: NoteItem[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim()) items.push({ text: entry, atMs: null });
    } else if (isRecord(entry) && typeof entry.text === 'string' && entry.text.trim()) {
      items.push({ text: entry.text, atMs: finiteMs(entry.atMs) });
    }
  }
  return items;
}

export function coerceChapters(value: unknown): Chapter[] {
  if (!Array.isArray(value)) return [];
  const chapters: Chapter[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.title !== 'string') continue;
    chapters.push({
      title: entry.title,
      startMs: finiteMs(entry.startMs),
      endMs: finiteMs(entry.endMs),
      points: coerceNoteItems(entry.points),
    });
  }
  return chapters;
}

function coerceTopics(value: unknown): NoteTopic[] {
  if (!Array.isArray(value)) return [];
  const topics: NoteTopic[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.title !== 'string') continue;
    const points = Array.isArray(entry.points) ? entry.points.filter((p): p is string => typeof p === 'string') : [];
    topics.push({ title: entry.title, points });
  }
  return topics;
}

export function coerceNotes(raw: unknown): Notes | undefined {
  if (!isRecord(raw) || typeof raw.recordingId !== 'string') return undefined;
  return {
    recordingId: raw.recordingId,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    keyTakeaways: coerceNoteItems(raw.keyTakeaways),
    decisions: coerceNoteItems(raw.decisions),
    chapters: coerceChapters(raw.chapters),
    topics: coerceTopics(raw.topics),
    provider: typeof raw.provider === 'string' ? raw.provider : 'unknown',
    model: typeof raw.model === 'string' ? raw.model : 'unknown',
    userEdited: raw.userEdited === true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export function coerceMoments(value: unknown): Moment[] {
  if (!Array.isArray(value)) return [];
  const moments: Moment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const atMs = finiteMs(entry.atMs);
    if (atMs === null || typeof entry.id !== 'string') continue;
    const kind = MOMENT_KINDS.includes(entry.kind as MomentKind) ? (entry.kind as MomentKind) : 'note';
    moments.push({ id: entry.id, atMs, kind, text: typeof entry.text === 'string' ? entry.text.slice(0, 280) : '' });
  }
  return moments.sort((a, b) => a.atMs - b.atMs);
}

export function coerceActionItem(raw: ActionItem): ActionItem {
  return { ...raw, atMs: finiteMs((raw as { atMs?: unknown }).atMs) };
}

/** Fills in fields added after a recording was stored. */
export function withRecordingDefaults(raw: Recording): Recording {
  const partial = raw as Partial<Recording> & Recording;
  return {
    ...raw,
    interruptionAcknowledged: partial.interruptionAcknowledged === true,
    pinned: partial.pinned === true,
    collection: typeof partial.collection === 'string' && partial.collection.trim() ? partial.collection : null,
    moments: coerceMoments(partial.moments),
  };
}
