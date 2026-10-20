import { useState } from 'react';
import { backend } from '../../app/backend';
import { titleSchema } from '../../domain/schemas';
import type { Recording } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { useLibraryStore } from '../../state/libraryStore';
import { toast } from '../../state/toastStore';
import { ConfirmDialog, Modal } from './Modal';
import { Button } from './primitives';

export function RenameDialog({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const rename = useLibraryStore((s) => s.rename);
  const [value, setValue] = useState(recording.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const parsed = titleSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title.');
      return;
    }
    setBusy(true);
    try {
      await rename(recording.id, parsed.data);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Rename recording"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="label" htmlFor="rename-input">
          Title
        </label>
        <input
          id="rename-input"
          data-autofocus
          className="input"
          value={value}
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && (
          <p className="small" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function DeleteRecordingDialog({
  recording,
  onClose,
  onDeleted,
}: {
  recording: Recording;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const remove = useLibraryStore((s) => s.remove);
  const [busy, setBusy] = useState(false);
  const [alsoCloud, setAlsoCloud] = useState(true);
  const hasCloud = recording.inCloud && backend !== null;

  const confirm = async () => {
    setBusy(true);
    try {
      await remove(recording.id, { alsoCloud: hasCloud && alsoCloud });
      toast.success('Recording deleted.');
      onClose();
      onDeleted?.();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not delete the recording.'));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title="Delete this recording?"
      destructive
      busy={busy}
      confirmLabel="Delete permanently"
      onCancel={onClose}
      onConfirm={() => void confirm()}
      message={
        <div className="stack">
          <p>“{recording.title}” and its audio, transcript and notes on this device will be deleted. This can’t be undone.</p>
          {hasCloud && (
            <label className="check">
              <input type="checkbox" checked={alsoCloud} onChange={(e) => setAlsoCloud(e.target.checked)} />
              <span>Also delete the cloud copy (audio, transcript and notes)</span>
            </label>
          )}
        </div>
      }
    />
  );
}
