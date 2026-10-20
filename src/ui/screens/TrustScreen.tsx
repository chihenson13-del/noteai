import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { backend } from '../../app/backend';
import { env } from '../../config/env';
import { localStore } from '../../app/localStore';
import { RETENTION_OPTIONS } from '../../domain/schemas';
import type { DataTransfer } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { useAuthStore } from '../../state/authStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useSettingsStore } from '../../state/settingsStore';
import { toast } from '../../state/toastStore';
import { ConfirmDialog, Modal } from '../components/Modal';
import { Banner, Button, Card } from '../components/primitives';

const TRANSFER_TEXT: Record<DataTransfer['kind'], string> = {
  audio_upload: 'Audio uploaded to your private cloud storage',
  transcription: 'Audio sent to the speech-to-text provider',
  notes: 'Transcript sent to the notes provider',
  ask: 'Question and matching transcript passages sent to the AI provider',
};

function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="switch-row">
      <div className="grow">
        <div className="label">{label}</div>
        <div className="hint">{hint}</div>
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
        <span />
      </button>
    </div>
  );
}

/**
 * One place to see and control what leaves this device: where recordings live, consent, the
 * log of third-party transfers, retention and deletion.
 */
export function TrustScreen() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const recordings = useLibraryStore((s) => s.recordings);
  const loadLibrary = useLibraryStore((s) => s.load);
  const user = useAuthStore((s) => s.user);

  const [transfers, setTransfers] = useState<DataTransfer[] | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'cloud-audio' | 'local-data' | 'account' | 'revoke'>(null);
  const [deleteText, setDeleteText] = useState('');
  const [busy, setBusy] = useState(false);

  const titles = useMemo(() => new Map(recordings.map((r) => [r.id, r.title])), [recordings]);
  const onDeviceOnly = recordings.filter((r) => !r.inCloud).length;
  const inCloud = recordings.filter((r) => r.inCloud).length;
  const cloudAudio = recordings.filter((r) => r.remotePath !== null);

  useEffect(() => {
    if (!backend || !user) {
      setTransfers(null);
      return;
    }
    let cancelled = false;
    backend
      .fetchTransfers(30)
      .then((rows) => !cancelled && setTransfers(rows))
      .catch((error) => !cancelled && setTransferError(errorMessage(error, 'Could not load the activity log.')));
    return () => {
      cancelled = true;
    };
  }, [user]);

  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await task();
      toast.success(success);
      setConfirm(null);
      setDeleteText('');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteAllCloudAudio = () =>
    run(async () => {
      if (!backend) return;
      for (const recording of cloudAudio) await useLibraryStore.getState().removeAudio(recording.id);
    }, 'Cloud audio deleted. Transcripts and notes were kept.');

  const deleteLocalData = () =>
    run(async () => {
      await localStore.clearEverything();
      await useSettingsStore.getState().load();
      await loadLibrary();
    }, 'All data on this device was deleted.');

  const deleteAccount = () =>
    run(async () => {
      if (!backend) return;
      await backend.deleteAccount();
    }, 'Your account and cloud data were deleted.');

  return (
    <div className="page">
      <header>
        <h1 className="h1 display">Trust center</h1>
        <p className="muted">What stays on this device, what has left it, and how to take it back.</p>
      </header>

      <section className="stats" aria-label="Where your recordings live">
        <div className="stat">
          <div className="stat-number">{onDeviceOnly}</div>
          <div className="stat-label">only on this device</div>
        </div>
        <div className="stat">
          <div className="stat-number">{backend ? inCloud : 0}</div>
          <div className="stat-label">{backend ? 'in your private cloud' : 'cloud not configured'}</div>
        </div>
      </section>

      <Card>
        <h2 className="h2">Consent</h2>
        {backend && env.cloudAi && (
        <Switch
          label="Allow cloud processing"
          hint={
            settings.uploadConsentAt
              ? `Allowed since ${new Date(settings.uploadConsentAt).toLocaleDateString()}. Audio is uploaded only when you press Transcribe.`
              : 'Not granted. You will be asked the first time you process a recording.'
          }
          checked={settings.uploadConsentAt !== null}
          onChange={(checked) => {
            if (checked) void update({ uploadConsentAt: new Date().toISOString() });
            else setConfirm('revoke');
          }}
        />
        )}
        <Switch
          label="Recording consent reminder"
          hint="Ask me to confirm that people being recorded agree, before each recording starts."
          checked={settings.showRecordingReminder}
          onChange={(showRecordingReminder) => void update({ showRecordingReminder })}
        />
      </Card>

      <Card className="stack">
        <h2 className="h2">What has left this device</h2>
        {!backend ? (
          <p className="muted">
            Nothing. This deployment has no cloud backend, so every recording stays in your browser, and transcription runs on this device.
          </p>
        ) : !user ? (
          <p className="muted">Sign in to see the activity log for your account.</p>
        ) : transferError ? (
          <Banner tone="danger">{transferError}</Banner>
        ) : transfers === null ? (
          <p className="muted" role="status">Loading…</p>
        ) : transfers.length === 0 ? (
          <p className="muted">Nothing yet. Audio is only sent when you choose to process a recording.</p>
        ) : (
          <ul className="activity">
            {transfers.map((transfer) => (
              <li key={transfer.id}>
                <div className="small">
                  <strong>{TRANSFER_TEXT[transfer.kind]}</strong>
                  {transfer.provider ? ` (${transfer.provider})` : ''}
                </div>
                <div className="tiny muted">
                  {formatDateTime(transfer.createdAt)}
                  {transfer.recordingId && titles.get(transfer.recordingId) ? ` · ${titles.get(transfer.recordingId)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
        {backend && (
          <p className="tiny muted">
            Cloud transcription and notes are done by third-party AI providers chosen by this app’s operator. Share links expose a notes
            snapshot only, never audio. Transcribing on this device sends nothing anywhere.
          </p>
        )}
      </Card>

      <Card className="stack">
        <h2 className="h2">Original audio retention</h2>
        <div className="field">
          <label className="label" htmlFor="retention">
            Delete original audio
          </label>
          <select
            id="retention"
            className="select"
            value={settings.audioRetentionDays === null ? '' : String(settings.audioRetentionDays)}
            onChange={(e) => void update({ audioRetentionDays: e.target.value === '' ? null : Number(e.target.value) })}
          >
            {RETENTION_OPTIONS.map((option) => (
              <option key={String(option.value)} value={option.value === null ? '' : String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="hint">
            Audio is deleted (device and cloud) only after transcription and notes completed successfully. Failed or unprocessed
            recordings are never deleted automatically. The check runs when you open the app while signed in.
          </span>
        </div>
      </Card>

      <Card className="stack">
        <h2 className="h2">Delete data</h2>
        <div className="row-wrap">
          <Button variant="danger-soft" size="sm" icon={<Trash2 />} disabled={!backend || cloudAudio.length === 0} onClick={() => setConfirm('cloud-audio')}>
            Delete all cloud audio
          </Button>
          <Button variant="danger-soft" size="sm" icon={<Trash2 />} onClick={() => setConfirm('local-data')}>
            Wipe this device
          </Button>
          {backend && user && (
            <Button variant="danger-soft" size="sm" icon={<Trash2 />} onClick={() => setConfirm('account')}>
              Delete my account
            </Button>
          )}
        </div>
      </Card>

      {confirm === 'revoke' && (
        <ConfirmDialog
          title="Stop cloud processing?"
          confirmLabel="Turn off"
          message="New recordings will stay on this device and can’t be transcribed until you allow uploads again. Existing cloud data is not deleted — use the delete options for that."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            void update({ uploadConsentAt: null });
            setConfirm(null);
          }}
        />
      )}
      {confirm === 'cloud-audio' && (
        <ConfirmDialog
          title="Delete all cloud audio?"
          destructive
          busy={busy}
          confirmLabel="Delete cloud audio"
          message={`This permanently deletes ${cloudAudio.length} audio file${cloudAudio.length === 1 ? '' : 's'} from your cloud storage and from this device. Transcripts and notes are kept.`}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteAllCloudAudio()}
        />
      )}
      {confirm === 'local-data' && (
        <ConfirmDialog
          title="Wipe everything on this device?"
          destructive
          busy={busy}
          confirmLabel="Wipe device"
          message="All recordings, audio, transcripts, notes and settings stored in this browser will be removed. Recordings already synced to the cloud are not affected. Download audio you want to keep first."
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteLocalData()}
        />
      )}
      {confirm === 'account' && (
        <Modal
          title="Delete your account?"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy} disabled={deleteText !== 'DELETE'} onClick={() => void deleteAccount()}>
                Delete account
              </Button>
            </>
          }
        >
          <p className="muted">
            This permanently deletes your account, every cloud recording, transcript, note, share link and audio file. Data on this
            device is kept until you wipe it separately.
          </p>
          <div className="field">
            <label className="label" htmlFor="delete-confirm">
              Type DELETE to confirm
            </label>
            <input id="delete-confirm" data-autofocus className="input" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} />
          </div>
        </Modal>
      )}
    </div>
  );
}
