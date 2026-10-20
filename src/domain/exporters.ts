import type { ActionItem, Notes, Recording, Transcript } from './types';
import { formatDateTime, formatDuration, formatTimestamp } from '../lib/format';
import { transcriptToPlainText } from './transcript';

type RecordingInfo = Pick<Recording, 'title' | 'createdAt' | 'durationMs'>;

function sortedItems(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder);
}

function timeSuffix(atMs: number | null): string {
  return atMs === null ? '' : ` [${formatTimestamp(atMs)}]`;
}

function bullets(items: Array<{ text: string; atMs: number | null }>): string {
  return items
    .filter((item) => item.text.trim())
    .map((item) => `- ${item.text.trim()}${timeSuffix(item.atMs)}`)
    .join('\n');
}

function taskMeta(item: ActionItem): string {
  return [item.assignee ? `@${item.assignee}` : '', item.dueDate ? `due ${item.dueDate}` : ''].filter(Boolean).join(', ');
}

/** Markdown export of the AI notes. Always states that the content is AI generated. */
export function notesToMarkdown(recording: RecordingInfo, notes: Notes | null, actionItems: ActionItem[]): string {
  const lines: string[] = [`# ${recording.title}`, '', `*${formatDateTime(recording.createdAt)} · ${formatDuration(recording.durationMs)}*`, ''];

  if (!notes && actionItems.length === 0) {
    lines.push('_No notes have been generated for this recording yet._');
    return lines.join('\n');
  }

  if (notes?.summary.trim()) lines.push('## Summary', '', notes.summary.trim(), '');
  if (notes && notes.keyTakeaways.length) lines.push('## Key takeaways', '', bullets(notes.keyTakeaways), '');
  if (notes && notes.decisions.length) lines.push('## Decisions', '', bullets(notes.decisions), '');
  if (actionItems.length) {
    lines.push('## Action items', '');
    for (const item of sortedItems(actionItems)) {
      const meta = taskMeta(item);
      lines.push(`- [${item.done ? 'x' : ' '}] ${item.text.trim()}${meta ? ` (${meta})` : ''}${timeSuffix(item.atMs)}`);
    }
    lines.push('');
  }
  if (notes && notes.chapters.length) {
    lines.push('## Chapters', '');
    for (const chapter of notes.chapters) {
      const when = chapter.startMs === null ? '' : ` (${formatTimestamp(chapter.startMs)})`;
      lines.push(`### ${chapter.title.trim()}${when}`, '');
      if (chapter.points.length) lines.push(bullets(chapter.points), '');
    }
  } else if (notes && notes.topics.length) {
    lines.push('## Topics', '');
    for (const topic of notes.topics) {
      lines.push(`### ${topic.title.trim()}`, '');
      if (topic.points.length) lines.push(topic.points.map((p) => `- ${p.trim()}`).join('\n'), '');
    }
  }
  if (notes) {
    const edited = notes.userEdited ? ' Edited by you after generation.' : '';
    lines.push('---', `_AI-generated notes (${notes.provider}, ${notes.model}).${edited} Times in brackets point to the audio. Review for accuracy before relying on them._`);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function notesToPlainText(recording: RecordingInfo, notes: Notes | null, actionItems: ActionItem[]): string {
  return notesToMarkdown(recording, notes, actionItems)
    .replace(/^#{1,3} /gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\*(.*)\*$/gm, '$1')
    .replace(/^_(.*)_$/gm, '$1');
}

export function transcriptToExportText(recording: RecordingInfo, transcript: Transcript, withTimestamps: boolean): string {
  const header = `${recording.title}\n${formatDateTime(recording.createdAt)} · ${formatDuration(recording.durationMs)}\nTranscribed by ${transcript.provider} (${transcript.model})\n\n`;
  return header + transcriptToPlainText(transcript, withTimestamps) + '\n';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function list(items: Array<{ text: string; atMs: number | null }>): string {
  if (items.length === 0) return '';
  const rows = items
    .filter((i) => i.text.trim())
    .map((i) => `<li>${escapeHtml(i.text.trim())}${i.atMs === null ? '' : ` <span class="t">${formatTimestamp(i.atMs)}</span>`}</li>`);
  return `<ul>${rows.join('')}</ul>`;
}

const DOCUMENT_CSS = `
  body { font-family: Georgia, 'Times New Roman', serif; color: #1f1d2b; margin: 40px auto; max-width: 720px; line-height: 1.55; padding: 0 24px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; font-family: Arial, sans-serif; color: #4f38b5; text-transform: uppercase; letter-spacing: .06em; }
  h3 { font-size: 16px; margin: 18px 0 6px; font-family: Arial, sans-serif; }
  .meta { color: #5e5a6b; font-family: Arial, sans-serif; font-size: 13px; }
  ul { padding-left: 20px; margin: 6px 0; }
  li { margin: 4px 0; }
  .t { font-family: Arial, sans-serif; font-size: 12px; color: #4f38b5; }
  .task { margin: 4px 0; }
  .note { margin-top: 36px; padding-top: 12px; border-top: 1px solid #ddd; color: #5e5a6b; font-family: Arial, sans-serif; font-size: 12px; }
`;

/**
 * A self-contained, print-ready HTML document of the notes. Used for "Save as PDF" (browser
 * print dialog) and, with a Word MIME type, as a .doc file. Every value is HTML-escaped.
 */
export function notesToHtmlDocument(recording: RecordingInfo, notes: Notes | null, actionItems: ActionItem[]): string {
  const parts: string[] = [
    `<h1>${escapeHtml(recording.title)}</h1>`,
    `<div class="meta">${escapeHtml(formatDateTime(recording.createdAt))} · ${escapeHtml(formatDuration(recording.durationMs))}</div>`,
  ];
  if (notes?.summary.trim()) parts.push('<h2>Summary</h2>', ...notes.summary.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`));
  if (notes && notes.keyTakeaways.length) parts.push('<h2>Key takeaways</h2>', list(notes.keyTakeaways));
  if (notes && notes.decisions.length) parts.push('<h2>Decisions</h2>', list(notes.decisions));
  if (actionItems.length) {
    parts.push('<h2>Action items</h2>');
    for (const item of sortedItems(actionItems)) {
      const meta = taskMeta(item);
      parts.push(
        `<div class="task">${item.done ? '&#9745;' : '&#9744;'} ${escapeHtml(item.text.trim())}${meta ? ` <span class="meta">(${escapeHtml(meta)})</span>` : ''}${
          item.atMs === null ? '' : ` <span class="t">${formatTimestamp(item.atMs)}</span>`
        }</div>`,
      );
    }
  }
  if (notes && notes.chapters.length) {
    parts.push('<h2>Chapters</h2>');
    for (const chapter of notes.chapters) {
      const when = chapter.startMs === null ? '' : ` <span class="t">${formatTimestamp(chapter.startMs)}</span>`;
      parts.push(`<h3>${escapeHtml(chapter.title.trim())}${when}</h3>`, list(chapter.points));
    }
  } else if (notes && notes.topics.length) {
    parts.push('<h2>Topics</h2>');
    for (const topic of notes.topics) {
      parts.push(`<h3>${escapeHtml(topic.title.trim())}</h3>`, list(topic.points.map((text) => ({ text, atMs: null }))));
    }
  }
  if (notes) {
    parts.push(
      `<div class="note">AI-generated notes (${escapeHtml(notes.provider)}, ${escapeHtml(notes.model)}).${notes.userEdited ? ' Edited by the author.' : ''} Times point to the audio recording. Review for accuracy before relying on them.</div>`,
    );
  } else {
    parts.push('<p><em>No notes have been generated for this recording yet.</em></p>');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(recording.title)}</title><style>${DOCUMENT_CSS}</style></head><body>${parts.join('\n')}</body></html>`;
}
