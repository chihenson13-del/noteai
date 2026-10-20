import { useMemo, useState } from 'react';
import { Copy, Download, FileText, RefreshCw, Search } from 'lucide-react';
import { matchingSegmentIndexes, paragraphsFromText, countMatches } from '../../domain/transcript';
import { transcriptToExportText } from '../../domain/exporters';
import { STAGE_LABEL } from '../../domain/status';
import type { Recording, Transcript } from '../../domain/types';
import { copyText, saveText } from '../../lib/download';
import { formatTimestamp, safeFileName } from '../../lib/format';
import { toast } from '../../state/toastStore';
import { ConfirmDialog } from './Modal';
import { Banner, Button, EmptyState } from './primitives';
import { Highlight } from './shared';

export function TranscriptPanel({
  recording,
  transcript,
  loading,
  canProcess,
  processing,
  onProcess,
  onSeek,
  onRetranscribe,
}: {
  recording: Recording;
  transcript: Transcript | null;
  loading: boolean;
  canProcess: boolean;
  processing: boolean;
  onProcess: () => void;
  onSeek: (ms: number) => void;
  /** Run the speech model again (only offered for transcripts made on this device). */
  onRetranscribe?: () => void;
}) {
  const [confirmAgain, setConfirmAgain] = useState(false);
  const [query, setQuery] = useState('');
  const [withTimestamps, setWithTimestamps] = useState(true);

  const hits = useMemo(() => (transcript ? matchingSegmentIndexes(transcript.segments, query) : []), [transcript, query]);
  const paragraphs = useMemo(
    () => (transcript && transcript.segments.length === 0 ? paragraphsFromText(transcript.text) : []),
    [transcript],
  );
  const totalMatches = transcript ? countMatches(transcript.text, query) : 0;

  if (loading && !transcript) {
    return <p className="muted" role="status">Loading transcript…</p>;
  }

  if (!transcript) {
    const failedHere = recording.status === 'failed' && recording.failedStage !== 'summarize';
    if (failedHere) {
      return (
        <Banner
          tone="danger"
          title={`${recording.failedStage ? STAGE_LABEL[recording.failedStage] : 'Processing'} failed`}
          actions={
            <Button variant="primary" size="sm" icon={<RefreshCw />} onClick={onProcess} loading={processing} disabled={!canProcess}>
              Retry transcription
            </Button>
          }
        >
          {recording.errorMessage ?? 'Something went wrong.'} Your original recording is untouched.
        </Banner>
      );
    }
    return (
      <EmptyState
        icon={<FileText />}
        title="No transcript yet"
        action={
          canProcess ? (
            <Button variant="primary" onClick={onProcess} loading={processing} disabled={processing}>
              Transcribe &amp; summarize
            </Button>
          ) : undefined
        }
      >
        {canProcess
          ? 'Create a transcript and notes from this recording. It runs on this device; nothing is uploaded.'
          : 'This browser can’t transcribe on the device (it needs Web Workers, WebAssembly and Web Audio).'}
      </EmptyState>
    );
  }

  const copy = async () => {
    const ok = await copyText(transcriptToExportText(recording, transcript, withTimestamps));
    if (ok) toast.success('Transcript copied.');
    else toast.error('Copy is not available here. Use Download instead.');
  };

  const download = () => {
    saveText(transcriptToExportText(recording, transcript, withTimestamps), `${safeFileName(recording.title)}-transcript.txt`);
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="tiny muted">
        Transcribed by {transcript.provider} ({transcript.model}){transcript.language ? ` · language: ${transcript.language}` : ''}.
        Automatic transcripts can contain mistakes — check important details against the audio.
      </p>

      <div className="row-wrap">
        <div className="search grow" style={{ minWidth: 200 }}>
          <Search aria-hidden />
          <input
            className="input"
            type="search"
            placeholder="Search in transcript"
            aria-label="Search in transcript"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button variant="secondary" size="sm" icon={<Copy />} onClick={() => void copy()}>
          Copy
        </Button>
        <Button variant="secondary" size="sm" icon={<Download />} onClick={download}>
          Export .txt
        </Button>
        {onRetranscribe && (
          <Button variant="ghost" size="sm" icon={<RefreshCw />} loading={processing} onClick={() => setConfirmAgain(true)}>
            Transcribe again
          </Button>
        )}
      </div>

      <div className="row-wrap">
        {transcript.segments.length > 0 && (
          <label className="check small">
            <input type="checkbox" checked={withTimestamps} onChange={(e) => setWithTimestamps(e.target.checked)} />
            <span>Include timestamps in copy / export</span>
          </label>
        )}
        {query.trim() && (
          <span className="small muted" role="status">
            {totalMatches === 0 ? 'No matches' : `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`}
          </span>
        )}
      </div>

      <div className="card" style={{ padding: 12 }}>
        {transcript.segments.length > 0 ? (
          transcript.segments.map((segment, index) => (
            <div key={index} className={`segment${hits.includes(index) ? ' segment--hit' : ''}`}>
              <button
                type="button"
                className="ts"
                onClick={() => onSeek(segment.startMs)}
                aria-label={`Play from ${formatTimestamp(segment.startMs)}`}
              >
                {formatTimestamp(segment.startMs)}
              </button>
              <p>
                <Highlight text={segment.text.trim()} query={query} />
              </p>
            </div>
          ))
        ) : (
          <div className="prose" style={{ padding: 6 }}>
            {paragraphs.map((paragraph, index) => (
              <p key={index}>
                <Highlight text={paragraph} query={query} />
              </p>
            ))}
            <p className="tiny faint" style={{ marginTop: 14 }}>
              This provider did not return timestamps.
            </p>
          </div>
        )}
      </div>

      {confirmAgain && onRetranscribe && (
        <ConfirmDialog
          title="Transcribe again?"
          confirmLabel="Transcribe again"
          destructive
          message="This runs the speech model again (with the model chosen in Settings) and replaces the transcript, summary, takeaways, decisions and action items, including any edits you made. The original audio is not changed."
          onCancel={() => setConfirmAgain(false)}
          onConfirm={() => {
            setConfirmAgain(false);
            onRetranscribe();
          }}
        />
      )}
    </div>
  );
}
