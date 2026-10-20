import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Cloud, Library, Mic, Search } from 'lucide-react';
import { backend } from '../../app/backend';
import { attentionItems } from '../../domain/attention';
import { greetingName } from '../../domain/auth';
import { DEFAULT_LIBRARY_QUERY, NO_COLLECTION, collectionsOf, queryLibrary } from '../../domain/library';
import { FILTERABLE_STATUSES, STATUS_LABEL } from '../../domain/status';
import type { RecordingStatus } from '../../domain/types';
import { formatBytes } from '../../lib/format';
import { detectRecordingSupport } from '../../recording/capabilities';
import { useAuthStore } from '../../state/authStore';
import { useLibraryStore } from '../../state/libraryStore';
import { Banner, Button, EmptyState, LinkButton, SkeletonList } from '../components/primitives';
import { RecordingRow, snippetAround } from '../components/shared';
import { useOnDevice } from '../hooks/useOnDevice';
import { useStorageEstimate } from '../hooks/useStorageEstimate';

function greeting(hour: number): string {
  if (hour < 5) return 'Working late?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

type MicState = 'granted' | 'prompt' | 'denied' | 'unknown';

/** Reads the microphone permission without triggering a prompt (not available in every browser). */
function useMicPermission(): MicState {
  const [state, setState] = useState<MicState>('unknown');
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const update = () => {
      if (status && !cancelled) setState(status.state as MicState);
    };
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((result) => {
        status = result;
        update();
        result.addEventListener('change', update);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      status?.removeEventListener('change', update);
    };
  }, []);
  return state;
}

const MIC_TEXT: Record<MicState, { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  granted: { text: 'Mic allowed', tone: 'good' },
  prompt: { text: 'Browser will ask for the mic', tone: 'neutral' },
  denied: { text: 'Mic blocked in browser', tone: 'bad' },
  unknown: { text: 'Mic permission unknown', tone: 'neutral' },
};

export function DashboardScreen() {
  const recordings = useLibraryStore((s) => s.recordings);
  const transcriptIndex = useLibraryStore((s) => s.transcriptIndex);
  const loaded = useLibraryStore((s) => s.loaded);
  const loadError = useLibraryStore((s) => s.loadError);
  const acknowledgeInterruption = useLibraryStore((s) => s.acknowledgeInterruption);
  const user = useAuthStore((s) => s.user);
  const onDevice = useOnDevice();
  const storage = useStorageEstimate(60_000);
  const mic = useMicPermission();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<RecordingStatus | 'all'>('all');
  const [collection, setCollection] = useState<string>('all');
  const support = useMemo(() => detectRecordingSupport(), []);

  const collections = useMemo(() => collectionsOf(recordings), [recordings]);
  const attention = useMemo(() => attentionItems(recordings), [recordings]);

  const filtering = query.trim() !== '' || status !== 'all' || collection !== 'all';
  const hits = useMemo(
    () => queryLibrary(recordings, transcriptIndex, { ...DEFAULT_LIBRARY_QUERY, query, status, collection }),
    [recordings, transcriptIndex, query, status, collection],
  );
  const shown = filtering ? hits : hits.slice(0, 6);
  const micInfo = MIC_TEXT[mic];

  return (
    <div className="page">
      <header>
        <p className="eyebrow">
          {greeting(new Date().getHours())}
          {user && greetingName(user) ? `, ${greetingName(user)}` : ''}
        </p>
        <h1 className="h1 display">What are we capturing today?</h1>
      </header>

      <section className="hero" aria-label="Start a recording">
        <Link to="/record" className="start-btn">
          <Mic aria-hidden />
          Start recording
        </Link>
        <ul className="preflight" aria-label="Before you record">
          <li className={`preflight-chip preflight-chip--${micInfo.tone}`}>{micInfo.text}</li>
          <li className="preflight-chip">
            {storage.freeBytes === null ? 'Free space unknown' : `${formatBytes(storage.freeBytes)} free`}
          </li>
          <li className="preflight-chip preflight-chip--warn">Keep this tab in front</li>
        </ul>
        <p className="muted small">
          Recording happens right here in your browser. Audio is saved to this device as you go and is transcribed on this device, so
          nothing is uploaded.
        </p>
      </section>

      {!support.supported && (
        <Banner tone="warning" title="Recording isn’t available in this browser">
          {support.problems.join(' ')}
        </Banner>
      )}

      {attention.length > 0 && (
        <section className="card attention" aria-label="Needs attention">
          <div className="row">
            <AlertTriangle size={20} aria-hidden />
            <h2 className="h3 grow">
              {attention.length === 1 ? '1 recording needs attention' : `${attention.length} recordings need attention`}
            </h2>
          </div>
          <ul className="attention-list">
            {attention.slice(0, 3).map((item) => (
              <li key={item.recording.id}>
                <div className="grow">
                  <Link to={`/recording/${item.recording.id}`} className="attention-title">
                    {item.recording.title}
                  </Link>
                  <div className="tiny">
                    {item.message}
                    {item.kind === 'failed' && item.recording.hasLocalAudio ? ' Audio is safe on this device.' : ''}
                  </div>
                </div>
                {item.kind === 'failed' && onDevice.supported ? (
                  <Button size="sm" variant="secondary" onClick={() => onDevice.start(item.recording.id)}>
                    Retry
                  </Button>
                ) : item.kind === 'interrupted' ? (
                  <Button size="sm" variant="secondary" onClick={() => void acknowledgeInterruption(item.recording.id)}>
                    Got it
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {attention.length > 3 && <p className="tiny">…and {attention.length - 3} more in your library.</p>}
        </section>
      )}

      {!backend && (
        <Banner tone="info" title="Running in local-only mode">
          Everything stays in this browser: recording, playback, transcription and notes all run on this device. Sign-in, sync and
          cloud AI need a backend, which this site doesn’t have.
        </Banner>
      )}

      {loadError && (
        <Banner tone="danger" title="Your library could not be opened">
          {loadError}
        </Banner>
      )}

      <section className="stack" aria-label="Recent recordings">
        <div className="spread">
          <h2 className="h2">{filtering ? 'Search results' : 'Recent recordings'}</h2>
          {recordings.length > 6 && !filtering && (
            <Link to="/library" className="small">
              View all ({recordings.length})
            </Link>
          )}
        </div>

        {collections.length > 0 && (
          <div className="chips" role="group" aria-label="Collections">
            <button type="button" className="chip" aria-pressed={collection === 'all'} onClick={() => setCollection('all')}>
              All
            </button>
            {collections.map((c) => (
              <button key={c.name} type="button" className="chip" aria-pressed={collection === c.name} onClick={() => setCollection(c.name)}>
                {c.name} <span className="chip-count">{c.count}</span>
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={collection === NO_COLLECTION} onClick={() => setCollection(NO_COLLECTION)}>
              Unsorted
            </button>
          </div>
        )}

        {recordings.length > 0 && (
          <div className="row-wrap">
            <div className="search grow" style={{ minWidth: 200 }}>
              <Search aria-hidden />
              <input
                className="input"
                type="search"
                placeholder="Search titles and transcripts"
                aria-label="Search recordings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="Filter by status"
              value={status}
              onChange={(e) => setStatus(e.target.value as RecordingStatus | 'all')}
            >
              <option value="all">All statuses</option>
              {FILTERABLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        )}

        {!loaded ? (
          <SkeletonList />
        ) : recordings.length === 0 ? (
          <EmptyState
            icon={<Mic />}
            title="Your first recording starts here"
            action={
              <LinkButton to="/record" variant="primary" icon={<Mic />}>
                Record something
              </LinkButton>
            }
          >
            Record a meeting, lecture or idea. Audio is saved on this device and can be transcribed on it too — nothing is uploaded.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState icon={<Search />} title="No matches">
            Nothing matches “{query}”{status !== 'all' ? ` with status “${STATUS_LABEL[status]}”` : ''}. Try a different word or clear
            the filter.
          </EmptyState>
        ) : (
          <div className="rec-list">
            {shown.map(({ recording, matchedIn }) => (
              <RecordingRow
                key={recording.id}
                recording={recording}
                query={query}
                snippet={matchedIn.includes('transcript') ? snippetAround(transcriptIndex.get(recording.id), query) : undefined}
              />
            ))}
          </div>
        )}
      </section>

      <section className="row-wrap" aria-label="Quick links">
        <LinkButton to="/library" variant="secondary" icon={<Library />}>
          Open library
        </LinkButton>
        {backend && !user && (
          <LinkButton to="/auth" variant="ghost" icon={<Cloud />}>
            Sign in with an access code
          </LinkButton>
        )}
      </section>

    </div>
  );
}
