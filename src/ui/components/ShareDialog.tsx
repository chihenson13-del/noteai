import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { backend } from '../../app/backend';
import { localStore } from '../../app/localStore';
import type { DeviceShareInput } from '../../data/backend';
import { shareUrlFor } from '../../data/sharedNotes';
import type { Recording, ShareLink } from '../../domain/types';
import { copyText } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { toast } from '../../state/toastStore';
import { Modal } from './Modal';
import { Banner, Button } from './primitives';

const EXPIRY_OPTIONS: Array<{ days: 1 | 7 | 30; label: string }> = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
];

function linkStatus(link: ShareLink, now = Date.now()): 'active' | 'expired' | 'revoked' {
  if (link.revokedAt) return 'revoked';
  return Date.parse(link.expiresAt) <= now ? 'expired' : 'active';
}

/**
 * Creates and revokes read-only share links. A link shows a snapshot of the notes only;
 * it never includes the audio or the transcript. The link itself is shown once, at creation.
 */
export function ShareDialog({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!backend) return;
    try {
      setLinks(await backend.listShareLinks(recording.id));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, 'Could not load existing links.'));
    }
  }, [recording.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    if (!backend) return;
    setBusy(true);
    try {
      // Notes made on this device have no cloud copy: send what is stored here (the server re-checks and trims it).
      let device: DeviceShareInput | undefined;
      if (!recording.inCloud) {
        const [notes, items] = await Promise.all([localStore.getNotes(recording.id), localStore.listActionItems(recording.id)]);
        if (!notes) throw new Error('There are no notes to share yet. Transcribe the recording first.');
        device = {
          title: recording.title,
          recordedAt: recording.createdAt,
          durationMs: recording.durationMs,
          notes: {
            summary: notes.summary,
            keyTakeaways: notes.keyTakeaways.map((i) => ({ text: i.text })),
            decisions: notes.decisions.map((i) => ({ text: i.text })),
            chapters: notes.chapters.map((c) => ({
              title: c.title,
              startMs: c.startMs,
              points: c.points.map((p) => ({ text: p.text })),
            })),
            provider: notes.provider,
            model: notes.model,
            userEdited: notes.userEdited,
          },
          actionItems: items.map((i) => ({ text: i.text, assignee: i.assignee, dueDate: i.dueDate, done: i.done })),
        };
      }
      const result = await backend.createShareLink(recording.id, days, device);
      setCreated({ url: shareUrlFor(result.token), expiresAt: result.expiresAt });
      await reload();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not create the link.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: ShareLink) => {
    if (!backend) return;
    try {
      await backend.revokeShareLink(link.id);
      toast.success('Link revoked.');
      await reload();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not revoke the link.'));
    }
  };

  const copy = async (url: string) => {
    const ok = await copyText(url);
    toast[ok ? 'success' : 'error'](ok ? 'Link copied.' : 'Copy is not available here. Select the link and copy it manually.');
  };

  return (
    <Modal
      title="Share notes"
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Banner tone="info">
        Anyone with the link can read a snapshot of these notes until it expires or you revoke it. The audio and transcript are never
        included, and later edits are not shown.
      </Banner>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Link expires after</legend>
        <div className="seg" role="radiogroup" aria-label="Link expiry">
          {EXPIRY_OPTIONS.map((option) => (
            <button
              key={option.days}
              type="button"
              role="radio"
              aria-checked={days === option.days}
              aria-selected={days === option.days}
              onClick={() => setDays(option.days)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <Button variant="primary" onClick={() => void create()} loading={busy}>
          Create link
        </Button>
      </div>

      {created && (
        <div className="card card--soft stack" role="status">
          <div className="label">New link (shown only now)</div>
          <input className="input mono" readOnly value={created.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
          <div className="spread">
            <span className="tiny muted">Expires {formatDateTime(created.expiresAt)}</span>
            <Button variant="secondary" size="sm" icon={<Copy />} onClick={() => void copy(created.url)}>
              Copy link
            </Button>
          </div>
        </div>
      )}

      {loadError && <p className="small" style={{ color: 'var(--danger)' }}>{loadError}</p>}

      {links.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="label">Links for this recording</div>
          {links.map((link) => {
            const status = linkStatus(link);
            return (
              <div key={link.id} className="spread card card--tight">
                <div>
                  <div className="small">Created {formatDateTime(link.createdAt)}</div>
                  <div className="tiny muted">
                    {status === 'active' ? `Expires ${formatDateTime(link.expiresAt)}` : status === 'expired' ? 'Expired' : 'Revoked'}
                  </div>
                </div>
                {status === 'active' ? (
                  <Button variant="danger-soft" size="sm" onClick={() => void revoke(link)}>
                    Revoke
                  </Button>
                ) : (
                  <span className="badge">{status === 'expired' ? 'Expired' : 'Revoked'}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
