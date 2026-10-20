import { useEffect, useState } from 'react';
import { Copy, Download, FileText, Link2, Pencil, Plus, Printer, RefreshCw, Share2, Sparkles, Trash2, X } from 'lucide-react';
import { backend } from '../../app/backend';
import { localStore } from '../../app/localStore';
import { notesToMarkdown, notesToPlainText } from '../../domain/exporters';
import { STAGE_LABEL } from '../../domain/status';
import type { ActionItem, Chapter, NoteItem, Notes, Recording } from '../../domain/types';
import { copyText, saveText } from '../../lib/download';
import { safeFileName } from '../../lib/format';
import { newId } from '../../lib/id';
import { downloadNotesAsWord, printNotesAsPdf } from '../../services/notesExport';
import { useAuthStore } from '../../state/authStore';
import { toast } from '../../state/toastStore';
import { ConfirmDialog } from './Modal';
import { TimeChip } from './TimeChip';
import { Banner, Button, EmptyState } from './primitives';

interface Draft {
  summary: string;
  keyTakeaways: NoteItem[];
  decisions: NoteItem[];
  chapters: Chapter[];
}

function toDraft(notes: Notes): Draft {
  return {
    summary: notes.summary,
    keyTakeaways: notes.keyTakeaways.map((i) => ({ ...i })),
    decisions: notes.decisions.map((i) => ({ ...i })),
    chapters: notes.chapters.map((c) => ({ ...c, points: c.points.map((p) => ({ ...p })) })),
  };
}

function cleanItems(items: NoteItem[]): NoteItem[] {
  return items.map((i) => ({ ...i, text: i.text.trim() })).filter((i) => i.text !== '');
}

function ItemListEditor({
  label,
  items,
  onChange,
  addLabel,
}: {
  label: string;
  items: NoteItem[];
  onChange: (next: NoteItem[]) => void;
  addLabel: string;
}) {
  return (
    <div className="stack">
      <ul className="note-list">
        {items.map((item, index) => (
          <li key={index} className="note-item">
            <textarea
              className="textarea"
              rows={1}
              value={item.text}
              aria-label={`${label} ${index + 1}`}
              onChange={(e) => onChange(items.map((v, i) => (i === index ? { ...v, text: e.target.value } : v)))}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              icon={<X />}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <div>
        <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => onChange([...items, { text: '', atMs: null }])}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function EvidenceList({ items, onSeek }: { items: NoteItem[]; onSeek?: (ms: number) => void }) {
  return (
    <ul className="note-list">
      {items.map((item, index) => (
        <li key={index} className="note-item">
          <span className="bullet" aria-hidden />
          <span className="grow">{item.text}</span>
          <TimeChip atMs={item.atMs} onSeek={onSeek} label="Play source" />
        </li>
      ))}
    </ul>
  );
}

function ActionText({ value, onCommit }: { value: string; onCommit: (text: string) => void | Promise<void> }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="input task-text"
      style={{ border: 0, padding: '6px 4px', minHeight: 36, background: 'transparent' }}
      value={text}
      aria-label="Action item text"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) void onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

export function NotesPanel({
  recording,
  notes,
  items,
  loading,
  canProcess,
  processing,
  onProcess,
  onRegenerate,
  onChanged,
  onSeek,
  onShare,
}: {
  recording: Recording;
  notes: Notes | null;
  items: ActionItem[];
  loading: boolean;
  canProcess: boolean;
  processing: boolean;
  onProcess: () => void;
  onRegenerate: () => void;
  onChanged: () => Promise<void>;
  /** Play the original audio from this time (undefined when no audio is available). */
  onSeek?: (ms: number) => void;
  /** Open the share-link dialog (undefined when sharing is not possible). */
  onShare?: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  if (loading && !notes) return <p className="muted" role="status">Loading notes…</p>;

  if (!notes) {
    if (recording.status === 'failed') {
      return (
        <Banner
          tone="danger"
          title={`${recording.failedStage ? STAGE_LABEL[recording.failedStage] : 'Processing'} failed`}
          actions={
            <Button variant="primary" size="sm" icon={<RefreshCw />} onClick={onProcess} loading={processing} disabled={!canProcess}>
              Retry
            </Button>
          }
        >
          {recording.errorMessage ?? 'Something went wrong.'} Your original recording is untouched.
        </Banner>
      );
    }
    return (
      <EmptyState
        icon={<Sparkles />}
        title="No notes yet"
        action={
          canProcess ? (
            <Button variant="primary" onClick={onProcess} loading={processing} disabled={processing}>
              Transcribe &amp; summarize
            </Button>
          ) : undefined
        }
      >
        {canProcess
          ? 'NoteAI will transcribe the audio, then pull out a summary, key takeaways, decisions and action items.'
          : 'This browser can’t transcribe on the device. You can still play and download your recording.'}
      </EmptyState>
    );
  }

  const editing = draft !== null;

  const persistItems = async (next: ActionItem[]) => {
    const normalized = next.map((item, index) => ({ ...item, sortOrder: index }));
    await localStore.replaceActionItems(recording.id, normalized);
    await onChanged();
    if (backend && user && recording.inCloud) {
      await backend.replaceActionItems(user.id, recording.id, normalized).catch(() => {
        toast.error('Saved on this device, but syncing action items to the cloud failed.');
      });
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next: Notes = {
        ...notes,
        summary: draft.summary.trim(),
        keyTakeaways: cleanItems(draft.keyTakeaways),
        decisions: cleanItems(draft.decisions),
        chapters: draft.chapters
          .map((c) => ({ ...c, title: c.title.trim(), points: cleanItems(c.points) }))
          .filter((c) => c.title || c.points.length),
        userEdited: true,
        updatedAt: new Date().toISOString(),
      };
      await localStore.putNotes(next);
      if (backend && user && recording.inCloud) {
        await backend.saveNotes(next).catch(() => toast.error('Saved on this device, but syncing the edit to the cloud failed.'));
      }
      await onChanged();
      setDraft(null);
      toast.success('Notes saved.');
    } catch {
      toast.error('Could not save your edits.');
    } finally {
      setSaving(false);
    }
  };

  const markdown = () => notesToMarkdown(recording, notes, items);

  const copy = async () => {
    const ok = await copyText(markdown());
    if (ok) toast.success('Notes copied as Markdown.');
    else toast.error('Copy is not available here. Use Download instead.');
  };

  const sharePlain = async () => {
    const text = notesToPlainText(recording, notes, items);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: recording.title, text });
        return;
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
      }
    }
    const ok = await copyText(text);
    toast[ok ? 'success' : 'error'](ok ? 'Sharing isn’t supported here — notes copied instead.' : 'Sharing is not available in this browser.');
  };

  const updateItem = (id: string, patch: Partial<ActionItem>) => persistItems(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const hasChapters = notes.chapters.length > 0;

  return (
    <div className="stack" style={{ gap: 18 }}>
      {notes.provider === 'on-device' ? (
        <Banner tone="info">
          Built on this device from sentences in your transcript — an extract, not an AI-written summary{notes.userEdited ? ' · edited by you' : ''}.
          {onSeek ? ' Tap a time to hear the source.' : ''} Decisions and action items are found by phrase matching and only understand
          English, so check them against the transcript.
        </Banner>
      ) : (
        <Banner tone="info">
          AI-generated by {notes.provider} ({notes.model}){notes.userEdited ? ' · edited by you' : ''}.
          {onSeek ? ' Tap a time to hear the source.' : ''} Review before relying on it — summaries can miss or misstate details.
        </Banner>
      )}

      <div className="row-wrap">
        {editing ? (
          <>
            <Button variant="primary" size="sm" onClick={() => void saveDraft()} loading={saving}>
              Save changes
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" icon={<Pencil />} onClick={() => setDraft(toDraft(notes))}>
              Edit
            </Button>
            <Button variant="secondary" size="sm" icon={<Copy />} onClick={() => void copy()}>
              Copy
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download />}
              onClick={() => saveText(markdown(), `${safeFileName(recording.title)}-notes.md`, 'text/markdown')}
            >
              .md
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Printer />}
              onClick={() => {
                try {
                  printNotesAsPdf(recording, notes, items);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'Could not open the print dialog.');
                }
              }}
            >
              PDF
            </Button>
            <Button variant="secondary" size="sm" icon={<FileText />} onClick={() => downloadNotesAsWord(recording, notes, items)}>
              Word
            </Button>
            <Button variant="secondary" size="sm" icon={<Share2 />} onClick={() => void sharePlain()}>
              Send text
            </Button>
            {onShare && (
              <Button variant="secondary" size="sm" icon={<Link2 />} onClick={onShare}>
                Share link
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw />}
              loading={processing}
              disabled={!canProcess}
              onClick={() => (notes.userEdited ? setConfirmRegenerate(true) : onRegenerate())}
            >
              Regenerate
            </Button>
          </>
        )}
      </div>

      <section className="card stack" aria-labelledby="notes-summary">
        <h2 id="notes-summary" className="h3">Summary</h2>
        {editing ? (
          <textarea
            className="textarea"
            rows={6}
            value={draft.summary}
            aria-label="Summary"
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
          />
        ) : (
          <p className="prose" style={{ whiteSpace: 'pre-line' }}>{notes.summary || <span className="muted">No summary.</span>}</p>
        )}
      </section>

      <section className="card stack" aria-labelledby="notes-takeaways">
        <h2 id="notes-takeaways" className="h3">Key takeaways</h2>
        {editing ? (
          <ItemListEditor label="Takeaway" items={draft.keyTakeaways} addLabel="Add takeaway" onChange={(keyTakeaways) => setDraft({ ...draft, keyTakeaways })} />
        ) : notes.keyTakeaways.length ? (
          <EvidenceList items={notes.keyTakeaways} onSeek={onSeek} />
        ) : (
          <p className="muted">None identified.</p>
        )}
      </section>

      <section className="card stack" aria-labelledby="notes-decisions">
        <h2 id="notes-decisions" className="h3">Decisions</h2>
        {editing ? (
          <ItemListEditor label="Decision" items={draft.decisions} addLabel="Add decision" onChange={(decisions) => setDraft({ ...draft, decisions })} />
        ) : notes.decisions.length ? (
          <EvidenceList items={notes.decisions} onSeek={onSeek} />
        ) : (
          <p className="muted">No decisions were identified.</p>
        )}
      </section>

      <section className="card stack" aria-labelledby="notes-actions">
        <h2 id="notes-actions" className="h3">Action items</h2>
        {items.length === 0 && <p className="muted">No action items were identified.</p>}
        <div className="stack" style={{ gap: 8 }}>
          {items.map((item) => (
            <div key={item.id} className={`task${item.done ? ' task--done' : ''}`}>
              <input
                type="checkbox"
                checked={item.done}
                aria-label={`Mark “${item.text}” as ${item.done ? 'not done' : 'done'}`}
                onChange={(e) => void updateItem(item.id, { done: e.target.checked })}
              />
              <div className="grow">
                <ActionText
                  value={item.text}
                  onCommit={(text) =>
                    text.trim() === '' ? persistItems(items.filter((i) => i.id !== item.id)) : updateItem(item.id, { text: text.trim() })
                  }
                />
                {(item.assignee || item.dueDate) && (
                  <div className="tiny muted" style={{ paddingLeft: 4 }}>
                    {item.assignee ? `Owner: ${item.assignee}` : ''}
                    {item.assignee && item.dueDate ? ' · ' : ''}
                    {item.dueDate ? `Due: ${item.dueDate}` : ''}
                  </div>
                )}
              </div>
              <TimeChip atMs={item.atMs} onSeek={onSeek} label="Play source" />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Trash2 />}
                aria-label={`Delete action item “${item.text}”`}
                onClick={() => void persistItems(items.filter((i) => i.id !== item.id))}
              />
            </div>
          ))}
        </div>
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus />}
            onClick={() =>
              void persistItems([
                ...items,
                { id: newId(), recordingId: recording.id, text: 'New action item', assignee: null, dueDate: null, done: false, sortOrder: items.length, atMs: null },
              ])
            }
          >
            Add action item
          </Button>
        </div>
      </section>

      <section className="card stack" aria-labelledby="notes-chapters">
        <h2 id="notes-chapters" className="h3">{hasChapters || editing ? 'Chapters' : 'Topics'}</h2>
        {editing ? (
          <div className="stack" style={{ gap: 14 }}>
            {draft.chapters.map((chapter, index) => (
              <div key={index} className="card card--soft stack" style={{ gap: 8 }}>
                <div className="row">
                  <input
                    className="input"
                    value={chapter.title}
                    aria-label={`Chapter ${index + 1} heading`}
                    onChange={(e) =>
                      setDraft({ ...draft, chapters: draft.chapters.map((c, i) => (i === index ? { ...c, title: e.target.value } : c)) })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Trash2 />}
                    aria-label={`Remove chapter ${index + 1}`}
                    onClick={() => setDraft({ ...draft, chapters: draft.chapters.filter((_, i) => i !== index) })}
                  />
                </div>
                <ItemListEditor
                  label={`Chapter ${index + 1} point`}
                  items={chapter.points}
                  addLabel="Add point"
                  onChange={(points) =>
                    setDraft({ ...draft, chapters: draft.chapters.map((c, i) => (i === index ? { ...c, points } : c)) })
                  }
                />
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus />}
                onClick={() =>
                  setDraft({ ...draft, chapters: [...draft.chapters, { title: 'New chapter', startMs: null, endMs: null, points: [] }] })
                }
              >
                Add chapter
              </Button>
            </div>
          </div>
        ) : hasChapters ? (
          <ol className="chapter-list">
            {notes.chapters.map((chapter, index) => (
              <li key={index} className="chapter">
                <div className="chapter-head">
                  <span className="chapter-index" aria-hidden>{index + 1}</span>
                  <h3 className="h3 grow">{chapter.title}</h3>
                  <TimeChip atMs={chapter.startMs} onSeek={onSeek} label="Play chapter" />
                </div>
                {chapter.points.length > 0 && <EvidenceList items={chapter.points} onSeek={onSeek} />}
              </li>
            ))}
          </ol>
        ) : notes.topics.length ? (
          <div className="stack" style={{ gap: 16 }}>
            {notes.topics.map((topic, index) => (
              <div key={index}>
                <h3 className="h3" style={{ marginBottom: 6 }}>{topic.title}</h3>
                <ul className="note-list">
                  {topic.points.map((point, i) => (
                    <li key={i} className="note-item">
                      <span className="bullet" aria-hidden />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No chapters were identified.</p>
        )}
      </section>

      {confirmRegenerate && (
        <ConfirmDialog
          title="Regenerate notes?"
          confirmLabel="Regenerate"
          destructive
          message="This replaces your edits to the summary, takeaways, decisions, chapters and action items with freshly generated notes. The transcript and audio are not changed."
          onCancel={() => setConfirmRegenerate(false)}
          onConfirm={() => {
            setConfirmRegenerate(false);
            onRegenerate();
          }}
        />
      )}
    </div>
  );
}
