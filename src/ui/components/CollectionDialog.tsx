import { useId, useState } from 'react';
import { collectionsOf, normalizeCollectionName } from '../../domain/library';
import type { Recording } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { useLibraryStore } from '../../state/libraryStore';
import { Modal } from './Modal';
import { Button } from './primitives';

/** Put a recording in a named collection (or take it out). Collections are just names. */
export function CollectionDialog({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const recordings = useLibraryStore((s) => s.recordings);
  const setCollection = useLibraryStore((s) => s.setCollection);
  const [value, setValue] = useState(recording.collection ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const existing = collectionsOf(recordings);

  const save = async (name: string | null) => {
    setBusy(true);
    try {
      await setCollection(recording.id, name);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Collection"
      onClose={onClose}
      actions={
        <>
          {recording.collection && (
            <Button variant="ghost" onClick={() => void save(null)} disabled={busy}>
              Remove from collection
            </Button>
          )}
          <Button variant="primary" onClick={() => void save(normalizeCollectionName(value))} loading={busy} disabled={!normalizeCollectionName(value)}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          const name = normalizeCollectionName(value);
          if (name) void save(name);
        }}
      >
        <label className="label" htmlFor="collection-input">
          Collection name
        </label>
        <input
          id="collection-input"
          data-autofocus
          className="input"
          list={listId}
          value={value}
          maxLength={40}
          placeholder="e.g. Meetings, Lectures, Ideas"
          onChange={(e) => setValue(e.target.value)}
        />
        <datalist id={listId}>
          {existing.map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
        {error && <p className="small" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      </form>
    </Modal>
  );
}
