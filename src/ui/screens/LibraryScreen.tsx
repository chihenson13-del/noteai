import { useMemo, useState } from 'react';
import { ArrowDownUp, Download, FolderPlus, Mic, Pencil, Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { backend } from '../../app/backend';
import {
  DEFAULT_LIBRARY_QUERY,
  NO_COLLECTION,
  collectionsOf,
  queryLibrary,
  type SortDirection,
  type SortKey,
} from '../../domain/library';
import { FILTERABLE_STATUSES, STATUS_LABEL } from '../../domain/status';
import type { Recording, RecordingStatus } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { downloadOriginalAudio } from '../../services/audioExport';
import { useLibraryStore } from '../../state/libraryStore';
import { toast } from '../../state/toastStore';
import { CollectionDialog } from '../components/CollectionDialog';
import { Button, EmptyState, LinkButton, SkeletonList } from '../components/primitives';
import { DeleteRecordingDialog, RenameDialog } from '../components/recordingDialogs';
import { ImportAudioButton } from '../components/ImportAudioButton';
import { RecordingRow, snippetAround } from '../components/shared';

export function LibraryScreen() {
  const recordings = useLibraryStore((s) => s.recordings);
  const transcriptIndex = useLibraryStore((s) => s.transcriptIndex);
  const loaded = useLibraryStore((s) => s.loaded);
  const setPinned = useLibraryStore((s) => s.setPinned);

  const [query, setQuery] = useState(DEFAULT_LIBRARY_QUERY.query);
  const [status, setStatus] = useState<RecordingStatus | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('date');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [renaming, setRenaming] = useState<Recording | null>(null);
  const [deleting, setDeleting] = useState<Recording | null>(null);
  const [organising, setOrganising] = useState<Recording | null>(null);
  const [collection, setCollection] = useState<string>('all');

  const hits = useMemo(
    () => queryLibrary(recordings, transcriptIndex, { query, status, sort, direction, collection, pinnedFirst: true }),
    [recordings, transcriptIndex, query, status, sort, direction, collection],
  );
  const collections = useMemo(() => collectionsOf(recordings), [recordings]);

  const download = async (recording: Recording) => {
    try {
      await downloadOriginalAudio(recording);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="page">
      <header className="spread">
        <div>
          <h1 className="h1">Library</h1>
          <p className="muted">
            {recordings.length} recording{recordings.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="row-wrap">
          <ImportAudioButton />
          <LinkButton to="/record" variant="primary" icon={<Mic />}>
            New
          </LinkButton>
        </div>
      </header>

      <div className="card card--tight stack">
        <div className="search">
          <Search aria-hidden />
          <input
            className="input"
            type="search"
            placeholder="Search by title or transcript"
            aria-label="Search recordings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="row-wrap">
          <label className="row small">
            <span className="muted">Sort</span>
            <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="date">Date</option>
              <option value="duration">Duration</option>
              <option value="title">Title</option>
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowDownUp />}
            onClick={() => setDirection((d) => (d === 'desc' ? 'asc' : 'desc'))}
            aria-label={`Sort direction: ${direction === 'desc' ? 'descending' : 'ascending'}`}
          >
            {direction === 'desc' ? 'Descending' : 'Ascending'}
          </Button>
          {collections.length > 0 && (
            <label className="row small">
              <span className="muted">Collection</span>
              <select className="select" style={{ width: 'auto' }} value={collection} onChange={(e) => setCollection(e.target.value)}>
                <option value="all">All</option>
                {collections.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.count})
                  </option>
                ))}
                <option value={NO_COLLECTION}>Unsorted</option>
              </select>
            </label>
          )}
          <label className="row small">
            <span className="muted">Status</span>
            <select
              className="select"
              style={{ width: 'auto' }}
              value={status}
              onChange={(e) => setStatus(e.target.value as RecordingStatus | 'all')}
            >
              <option value="all">All</option>
              {FILTERABLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {!loaded ? (
        <SkeletonList rows={4} />
      ) : recordings.length === 0 ? (
        <EmptyState
          icon={<Mic />}
          title="No recordings yet"
          action={
            <div className="row-wrap" style={{ justifyContent: 'center' }}>
              <LinkButton to="/record" variant="primary" icon={<Mic />}>
                Start recording
              </LinkButton>
              <ImportAudioButton />
            </div>
          }
        >
          Your recordings will appear here with their transcripts and notes. You can also import an existing audio file.
        </EmptyState>
      ) : hits.length === 0 ? (
        <EmptyState icon={<Search />} title="No matches">
          No recordings match the current search and filter.
        </EmptyState>
      ) : (
        <div className="rec-list">
          {hits.map(({ recording, matchedIn }) => (
            <div key={recording.id} className="stack" style={{ gap: 6 }}>
              <RecordingRow
                recording={recording}
                query={query}
                snippet={matchedIn.includes('transcript') ? snippetAround(transcriptIndex.get(recording.id), query) : undefined}
              />
              <div className="row-wrap" style={{ paddingLeft: 8 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={recording.pinned ? <PinOff /> : <Pin />}
                  aria-pressed={recording.pinned}
                  onClick={() => void setPinned(recording.id, !recording.pinned)}
                >
                  {recording.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button variant="ghost" size="sm" icon={<FolderPlus />} onClick={() => setOrganising(recording)}>
                  {recording.collection ? 'Move' : 'Add to collection'}
                </Button>
                <Button variant="ghost" size="sm" icon={<Pencil />} onClick={() => setRenaming(recording)}>
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Download />}
                  disabled={!recording.hasLocalAudio && !(recording.remotePath && backend)}
                  onClick={() => void download(recording)}
                >
                  Download audio
                </Button>
                <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => setDeleting(recording)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {renaming && <RenameDialog recording={renaming} onClose={() => setRenaming(null)} />}
      {organising && <CollectionDialog recording={organising} onClose={() => setOrganising(null)} />}
      {deleting && <DeleteRecordingDialog recording={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
