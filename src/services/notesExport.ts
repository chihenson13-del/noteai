import { notesToHtmlDocument } from '../domain/exporters';
import type { ActionItem, Notes, Recording } from '../domain/types';
import { saveBlob } from '../lib/download';
import { safeFileName } from '../lib/format';

/**
 * Opens the browser's print dialog for the notes (choose "Save as PDF" as the destination).
 * Uses a hidden iframe so it is not blocked as a pop-up and leaves the app page untouched.
 */
export function printNotesAsPdf(recording: Pick<Recording, 'title' | 'createdAt' | 'durationMs'>, notes: Notes | null, items: ActionItem[]): void {
  const html = notesToHtmlDocument(recording, notes, items);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error('Printing is not available in this browser.');
  }
  doc.open();
  doc.write(html);
  doc.close();
  win.addEventListener('afterprint', cleanup, { once: true });
  // Give the document a tick to lay out before opening the dialog.
  setTimeout(() => {
    win.focus();
    win.print();
  }, 150);
}

/**
 * Word document. This is HTML with a Word MIME type, which Word, LibreOffice and Google Docs
 * open as a formatted document. It is a .doc, not a native .docx.
 */
export function downloadNotesAsWord(recording: Pick<Recording, 'title' | 'createdAt' | 'durationMs'>, notes: Notes | null, items: ActionItem[]): void {
  const html = notesToHtmlDocument(recording, notes, items);
  saveBlob(new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' }), `${safeFileName(recording.title)}-notes.doc`);
}
