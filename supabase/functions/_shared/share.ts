import { MAX_CHAPTERS, MAX_CHAPTER_POINTS, MAX_ITEM_CHARS, MAX_LIST_ITEMS, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS } from './limits.ts';

/**
 * Read-only share links.
 *
 * A link exposes a SNAPSHOT of the notes (summary, takeaways, decisions, chapters, tasks).
 * It never contains the audio, the transcript, storage paths or user identifiers. Only a hash
 * of the token is stored, so a database leak does not leak working links.
 */

export interface ShareSnapshot {
  version: 1;
  title: string;
  recordedAt: string;
  durationMs: number;
  summary: string;
  keyTakeaways: Array<{ text: string }>;
  decisions: Array<{ text: string }>;
  chapters: Array<{ title: string; startMs: number | null; points: Array<{ text: string }> }>;
  actionItems: Array<{ text: string; assignee: string | null; dueDate: string | null; done: boolean }>;
  /** Shown on the public page so readers know what they are looking at. */
  generatedBy: { provider: string; model: string; userEdited: boolean };
}

interface RecordingInput {
  title: string;
  recordedAt: string;
  durationMs: number;
}

interface NotesInput {
  summary: string;
  keyTakeaways: unknown;
  decisions: unknown;
  chapters: unknown;
  provider: string;
  model: string;
  userEdited: boolean;
}

interface ActionInput {
  text: string;
  assignee: string | null;
  dueDate: string | null;
  done: boolean;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function items(value: unknown): Array<{ text: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ text: string }> = [];
  for (const entry of value) {
    const t = typeof entry === 'string' ? text(entry, MAX_ITEM_CHARS) : text((entry as { text?: unknown } | null)?.text, MAX_ITEM_CHARS);
    if (t) out.push({ text: t });
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

export function buildShareSnapshot(recording: RecordingInput, notes: NotesInput, actions: ActionInput[]): ShareSnapshot {
  const chapters: ShareSnapshot['chapters'] = [];
  if (Array.isArray(notes.chapters)) {
    for (const entry of notes.chapters) {
      if (typeof entry !== 'object' || entry === null) continue;
      const chapter = entry as { title?: unknown; startMs?: unknown; points?: unknown };
      const title = text(chapter.title, 160);
      const points = items(chapter.points).slice(0, MAX_CHAPTER_POINTS);
      if (!title && points.length === 0) continue;
      chapters.push({
        title: title || 'Chapter',
        startMs: typeof chapter.startMs === 'number' && Number.isFinite(chapter.startMs) ? Math.max(0, Math.round(chapter.startMs)) : null,
        points,
      });
      if (chapters.length >= MAX_CHAPTERS) break;
    }
  }
  return {
    version: 1,
    title: text(recording.title, MAX_TITLE_CHARS) || 'Untitled recording',
    recordedAt: recording.recordedAt,
    durationMs: Math.max(0, Math.round(recording.durationMs)),
    summary: typeof notes.summary === 'string' ? notes.summary.slice(0, MAX_SUMMARY_CHARS) : '',
    keyTakeaways: items(notes.keyTakeaways),
    decisions: items(notes.decisions),
    chapters,
    actionItems: actions.slice(0, MAX_LIST_ITEMS).map((a) => ({
      text: text(a.text, MAX_ITEM_CHARS),
      assignee: a.assignee ? text(a.assignee, 80) || null : null,
      dueDate: typeof a.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate) ? a.dueDate : null,
      done: a.done === true,
    })),
    generatedBy: { provider: text(notes.provider, 40), model: text(notes.model, 80), userEdited: notes.userEdited === true },
  };
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** 32 random bytes, base64url (43 chars, 256 bits of entropy). */
export function generateShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
