import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Cloud, HardDrive, Mic, Pause, Pin, Play, Sparkles } from 'lucide-react';
import { backend } from '../../app/backend';
import { env } from '../../config/env';
import { pipeline } from '../../app/container';
import { STATUS_TONE, statusLabel } from '../../domain/status';
import type { Recording, RecordingStatus } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { formatDurationWords, formatRelativeDay } from '../../lib/format';
import { highlightParts } from '../../domain/transcript';
import { useAuthStore } from '../../state/authStore';
import { useSettingsStore } from '../../state/settingsStore';
import { toast } from '../../state/toastStore';
import { useInlinePlayback } from '../hooks/useInlinePlayback';
import { Modal } from './Modal';
import { Badge, Button, Spinner } from './primitives';

// --- status ------------------------------------------------------------------------

const STATUS_ICON: Record<RecordingStatus, ReactNode> = {
  local: <HardDrive aria-hidden />,
  uploading: <Spinner />,
  uploaded: <Cloud aria-hidden />,
  transcribing: <Spinner />,
  summarizing: <Sparkles aria-hidden />,
  completed: <CheckCircle2 aria-hidden />,
  failed: <AlertTriangle aria-hidden />,
};

export function StatusBadge({ recording }: { recording: Pick<Recording, 'status' | 'failedStage'> }) {
  return (
    <Badge tone={STATUS_TONE[recording.status]} icon={STATUS_ICON[recording.status]}>
      {statusLabel(recording)}
    </Badge>
  );
}

// --- highlighted text ------------------------------------------------------------------

export function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

// --- recording row ------------------------------------------------------------------------

export function RecordingRow({ recording, query = '', snippet }: { recording: Recording; query?: string; snippet?: string }) {
  const toggle = useInlinePlayback((s) => s.toggle);
  const activeId = useInlinePlayback((s) => s.activeId);
  const playing = useInlinePlayback((s) => s.playing);
  const loading = useInlinePlayback((s) => s.loading);
  const isActive = activeId === recording.id;
  const canPlay = recording.hasLocalAudio || (recording.remotePath !== null && backend !== null);

  return (
    <div className="rec-row">
      <button
        type="button"
        className="rec-icon"
        style={{ border: 0, cursor: canPlay ? 'pointer' : 'default' }}
        disabled={!canPlay}
        aria-label={isActive && playing ? `Pause ${recording.title}` : `Play ${recording.title}`}
        onClick={() => void toggle(recording)}
      >
        {isActive && loading ? <Spinner /> : isActive && playing ? <Pause size={20} aria-hidden /> : canPlay ? <Play size={20} aria-hidden /> : <Mic size={20} aria-hidden />}
      </button>
      <Link to={`/recording/${recording.id}`} className="grow" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="rec-title truncate">
          {recording.pinned && <Pin size={14} aria-label="Pinned" className="pin-mark" />}
          <Highlight text={recording.title} query={query} />
        </div>
        <div className="rec-meta">
          <span>{formatRelativeDay(recording.createdAt)}</span>
          <span className="dot" aria-hidden />
          <span>{formatDurationWords(recording.durationMs)}</span>
          {recording.collection && (
            <>
              <span className="dot" aria-hidden />
              <span>{recording.collection}</span>
            </>
          )}
          {recording.moments.length > 0 && (
            <>
              <span className="dot" aria-hidden />
              <span>{recording.moments.length} moment{recording.moments.length === 1 ? '' : 's'}</span>
            </>
          )}
          {recording.wasInterrupted && (
            <>
              <span className="dot" aria-hidden />
              <span style={{ color: 'var(--warning)' }}>Interrupted</span>
            </>
          )}
        </div>
        {snippet && (
          <div className="snippet">
            <Highlight text={snippet} query={query} />
          </div>
        )}
      </Link>
      <StatusBadge recording={recording} />
    </div>
  );
}

/** A short excerpt of the transcript around the first match. */
export function snippetAround(text: string | undefined, query: string, radius = 70): string | undefined {
  const q = query.trim().toLowerCase();
  if (!text || !q) return undefined;
  const index = text.toLowerCase().indexOf(q);
  if (index < 0) return undefined;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + q.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

// --- consent ----------------------------------------------------------------------------------

export function UploadConsentModal({ onAccept, onCancel }: { onAccept: () => void; onCancel: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Modal
      title="Process this recording in the cloud?"
      onClose={onCancel}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Not now
          </Button>
          <Button variant="primary" disabled={!checked} onClick={onAccept} data-autofocus>
            Upload &amp; process
          </Button>
        </>
      }
    >
      <p className="muted">To create a transcript and AI notes, NoteAI needs to:</p>
      <ul className="muted" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
        <li>upload the recording to your private cloud storage (only you can access it),</li>
        <li>send the audio to a third-party transcription provider, and the transcript to an AI provider, chosen by this app’s operator.</li>
      </ul>
      <p className="muted small">
        Recordings that are never processed stay on this device. You can delete the cloud audio at any time in Settings → Privacy.
      </p>
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>
          I understand this, and I have permission from everyone in this recording where the law or good practice requires it.
        </span>
      </label>
    </Modal>
  );
}

/**
 * Entry point for "transcribe & summarize". Handles the preconditions (backend configured,
 * signed in, consent) and surfaces results as toasts; state changes flow through the pipeline.
 */
export function useProcessRecording() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const consentAt = useSettingsStore((s) => s.settings.uploadConsentAt);
  const updateSettings = useSettingsStore((s) => s.update);
  const [pending, setPending] = useState<{ id: string; options?: { force?: boolean; summarizeOnly?: boolean } } | null>(null);

  const execute = async (id: string, options?: { force?: boolean; summarizeOnly?: boolean }) => {
    if (!pipeline) return;
    try {
      await pipeline.run(id, options);
      toast.success('Transcript and notes are ready.');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return {
    available: pipeline !== null && env.cloudAi,
    start(id: string, options?: { force?: boolean; summarizeOnly?: boolean }) {
      if (!pipeline) {
        toast.error('Cloud processing is not configured for this deployment.');
        return;
      }
      if (!user) {
        navigate('/auth', { state: { from: `/recording/${id}` } });
        return;
      }
      if (!consentAt) {
        setPending({ id, options });
        return;
      }
      void execute(id, options);
    },
    consentModal: pending ? (
      <UploadConsentModal
        onCancel={() => setPending(null)}
        onAccept={() => {
          const job = pending;
          setPending(null);
          void updateSettings({ uploadConsentAt: new Date().toISOString() }).then(() => execute(job.id, job.options));
        }}
      />
    ) : null,
  };
}
