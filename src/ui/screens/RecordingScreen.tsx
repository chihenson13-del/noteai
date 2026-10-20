import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Cloud, Download, FolderPlus, HardDrive, Pencil, Pin, PinOff, Sparkles, Trash2, X } from 'lucide-react';
import { backend } from '../../app/backend';
import { pipeline } from '../../app/container';
import { MOMENT_LABEL, sortMoments } from '../../domain/moments';
import { isProcessing } from '../../domain/status';
import type { Recording } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { LONG_RECORDING_WARNING_MS, ON_DEVICE_MODELS } from '../../ondevice/config';
import { downloadOriginalAudio } from '../../services/audioExport';
import { useAuthStore } from '../../state/authStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useSettingsStore } from '../../state/settingsStore';
import { toast } from '../../state/toastStore';
import { AudioPlayer, type AudioPlayerHandle, type PlayerMarker } from '../components/AudioPlayer';
import { CollectionDialog } from '../components/CollectionDialog';
import { ConfirmDialog } from '../components/Modal';
import { NotesPanel } from '../components/NotesPanel';
import { ShareDialog } from '../components/ShareDialog';
import { TimeChip } from '../components/TimeChip';
import { TranscriptPanel } from '../components/TranscriptPanel';
import { Banner, Button, Card, EmptyState, LinkButton, SkeletonList } from '../components/primitives';
import { DeleteRecordingDialog, RenameDialog } from '../components/recordingDialogs';
import { StatusBadge, useProcessRecording } from '../components/shared';
import { useAudioSource } from '../hooks/useAudioSource';
import { useOnDevice, useOnDeviceProgress } from '../hooks/useOnDevice';
import { useRecordingDetails } from '../hooks/useRecordingDetails';

type StepState = 'pending' | 'active' | 'done' | 'failed';

function stepStates(recording: Recording, hasTranscript: boolean): Record<'upload' | 'transcribe' | 'notes', StepState> {
  const { status, failedStage } = recording;
  const uploaded = recording.remotePath !== null || ['uploaded', 'transcribing', 'summarizing', 'completed'].includes(status);
  return {
    upload: failedStage === 'upload' && status === 'failed' ? 'failed' : status === 'uploading' ? 'active' : uploaded ? 'done' : 'pending',
    transcribe:
      failedStage === 'transcribe' && status === 'failed'
        ? 'failed'
        : status === 'transcribing'
          ? 'active'
          : hasTranscript || status === 'summarizing' || status === 'completed'
            ? 'done'
            : 'pending',
    notes:
      failedStage === 'summarize' && status === 'failed'
        ? 'failed'
        : status === 'summarizing'
          ? 'active'
          : status === 'completed'
            ? 'done'
            : 'pending',
  };
}

const STEP_LABEL: Record<StepState, string> = { pending: 'Waiting', active: 'In progress…', done: 'Done', failed: 'Failed' };

function PipelineSteps({ recording, hasTranscript, showUpload }: { recording: Recording; hasTranscript: boolean; showUpload: boolean }) {
  const states = stepStates(recording, hasTranscript);
  const steps: Array<[keyof typeof states, string]> = [
    ...(showUpload ? ([['upload', 'Upload']] as Array<[keyof typeof states, string]>) : []),
    ['transcribe', 'Transcribe'],
    ['notes', 'Notes'],
  ];
  return (
    <ol
      className="steps"
      aria-label="Processing progress"
      style={{ listStyle: 'none', padding: 0, margin: 0, gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}
    >
      {steps.map(([key, label]) => (
        <li key={key} className={`step step--${states[key] === 'pending' ? 'pending' : states[key]}`}>
          {label}
          <small>{STEP_LABEL[states[key]]}</small>
        </li>
      ))}
    </ol>
  );
}

function OnDeviceProgressView({
  progress,
  modelMb,
  onCancel,
}: {
  progress: { phase: 'decoding' | 'loading-model' | 'transcribing' | 'notes'; pct: number | null };
  modelMb: number;
  onCancel: () => void;
}) {
  const label =
    progress.phase === 'decoding'
      ? 'Preparing the audio…'
      : progress.phase === 'loading-model'
        ? `Loading the speech model… ${progress.pct ?? 0}%`
        : progress.phase === 'transcribing'
          ? `Transcribing on this device… ${progress.pct ?? 0}%`
          : 'Selecting the key sentences…';
  const pct = progress.phase === 'notes' ? 100 : progress.phase === 'decoding' ? null : (progress.pct ?? 0);
  return (
    <div className="stack" style={{ gap: 10 }} role="status" aria-live="polite">
      <div className="spread">
        <strong>{label}</strong>
        <Button variant="ghost" size="sm" icon={<X />} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="meter" aria-hidden>
        <div style={{ width: `${pct ?? 8}%`, transition: 'width .3s ease' }} />
      </div>
      {progress.phase === 'loading-model' && (
        <p className="tiny muted">
          The first time only, the speech model (about {modelMb} MB) is copied from this site to your device. After that it works
          without a connection. Your audio is not uploaded.
        </p>
      )}
      {progress.phase === 'transcribing' && <p className="tiny muted">Keep this page open. Long recordings take a while on a phone.</p>}
    </div>
  );
}

type TabKey = 'notes' | 'transcript' | 'moments';

export function RecordingScreen() {
  const { id, tab } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const recording = useLibraryStore((s) => s.recordings.find((r) => r.id === id));
  const loaded = useLibraryStore((s) => s.loaded);
  const removeAudio = useLibraryStore((s) => s.removeAudio);
  const setPinned = useLibraryStore((s) => s.setPinned);
  const acknowledgeInterruption = useLibraryStore((s) => s.acknowledgeInterruption);
  const user = useAuthStore((s) => s.user);
  const audio = useAudioSource(recording);
  const details = useRecordingDetails(recording);
  const process = useProcessRecording();
  const onDevice = useOnDevice();
  const onDeviceProgress = useOnDeviceProgress(id);
  const modelId = useSettingsStore((s) => s.settings.onDeviceModel);
  const playerRef = useRef<AudioPlayerHandle>(null);

  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [choosingCollection, setChoosingCollection] = useState(false);
  const [confirmAudioDelete, setConfirmAudioDelete] = useState(false);
  const [busyAudioDelete, setBusyAudioDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const activeTab: TabKey = tab === 'transcript' ? 'transcript' : tab === 'moments' ? 'moments' : 'notes';
  const working = useMemo(
    () =>
      recording ? isProcessing(recording.status) || (pipeline?.isRunning(recording.id) ?? false) || onDeviceProgress !== null : false,
    [recording, onDeviceProgress],
  );

  // Deep link from "Ask": /recording/:id/transcript?t=<ms> jumps the player to that moment.
  const requestedMs = Number(searchParams.get('t'));
  const audioUrl = audio.url;
  useEffect(() => {
    if (!audioUrl || !Number.isFinite(requestedMs) || requestedMs <= 0) return;
    const timer = setTimeout(() => playerRef.current?.seekTo(requestedMs), 350);
    return () => clearTimeout(timer);
  }, [audioUrl, requestedMs]);

  const markers = useMemo<PlayerMarker[]>(() => {
    if (!recording) return [];
    const chapters: PlayerMarker[] = (details.notes?.chapters ?? [])
      .filter((c) => c.startMs !== null && c.startMs > 0)
      .map((c) => ({ atMs: c.startMs as number, kind: 'chapter', label: c.title }));
    const moments: PlayerMarker[] = recording.moments.map((m) => ({ atMs: m.atMs, kind: 'moment', label: MOMENT_LABEL[m.kind] }));
    return [...chapters, ...moments];
  }, [recording, details.notes]);

  if (!loaded) {
    return (
      <div className="page">
        <SkeletonList rows={3} />
      </div>
    );
  }

  if (!recording) {
    return (
      <div className="page">
        <EmptyState
          icon={<Pencil />}
          title="Recording not found"
          action={
            <LinkButton to="/library" variant="primary">
              Back to library
            </LinkButton>
          }
        >
          It may have been deleted, or it belongs to another browser profile.
        </EmptyState>
      </div>
    );
  }

  const modelInfo = ON_DEVICE_MODELS[modelId];
  const notesFromDevice = details.notes?.provider === 'on-device';
  const notesCanProcess = details.notes ? (notesFromDevice ? onDevice.supported : process.available) : onDevice.supported || process.available;
  const showUploadStep = !!pipeline && (recording.remotePath !== null || recording.inCloud || recording.status === 'uploading');
  const audioAvailable = audio.url !== null || audio.loading;
  const canSeek = audio.url !== null;
  const seek = canSeek
    ? (ms: number) => {
        playerRef.current?.seekTo(ms);
        playerRef.current?.play();
      }
    : undefined;
  const canShareLink = !!backend && !!user && recording.status === 'completed';

  const download = async () => {
    setDownloading(true);
    try {
      await downloadOriginalAudio(recording);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDownloading(false);
    }
  };

  const deleteAudioOnly = async () => {
    setBusyAudioDelete(true);
    try {
      await removeAudio(recording.id);
      toast.success('Original audio deleted. Transcript and notes were kept.');
      setConfirmAudioDelete(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyAudioDelete(false);
    }
  };

  const showProcessCard = recording.status !== 'completed';
  const moments = sortMoments(recording.moments);

  return (
    <div className="page">
      <div>
        <Link to="/library" className="row small muted" style={{ textDecoration: 'none' }}>
          <ArrowLeft size={16} aria-hidden /> Library
        </Link>
      </div>

      <header className="stack" style={{ gap: 10 }}>
        <div className="row">
          <h1 className="h1 grow" style={{ overflowWrap: 'anywhere' }}>
            {recording.title}
          </h1>
          <Button
            variant="ghost"
            iconOnly
            icon={recording.pinned ? <PinOff /> : <Pin />}
            aria-label={recording.pinned ? 'Unpin recording' : 'Pin recording'}
            aria-pressed={recording.pinned}
            onClick={() => void setPinned(recording.id, !recording.pinned)}
          />
          <Button variant="ghost" iconOnly icon={<Pencil />} aria-label="Rename recording" onClick={() => setRenaming(true)} />
        </div>
        <div className="row-wrap">
          <StatusBadge recording={recording} />
          {recording.collection ? (
            <button type="button" className="chip chip--static" onClick={() => setChoosingCollection(true)}>
              {recording.collection}
            </button>
          ) : (
            <Button variant="ghost" size="sm" icon={<FolderPlus />} onClick={() => setChoosingCollection(true)}>
              Add to collection
            </Button>
          )}
          <span className="small muted">{formatDateTime(recording.createdAt)}</span>
          <span className="dot" aria-hidden />
          <span className="small muted">{formatDuration(recording.durationMs)}</span>
          <span className="dot" aria-hidden />
          <span className="small muted">{formatBytes(recording.sizeBytes)}</span>
          <span className="dot" aria-hidden />
          <span className="small muted row" style={{ gap: 4 }}>
            {recording.inCloud ? <Cloud size={14} aria-hidden /> : <HardDrive size={14} aria-hidden />}
            {recording.inCloud ? 'Synced to your cloud' : 'On this device only'}
          </span>
        </div>
      </header>

      {recording.wasInterrupted && (
        <Banner
          tone="warning"
          title="This recording was interrupted"
          actions={
            !recording.interruptionAcknowledged ? (
              <Button variant="secondary" size="sm" onClick={() => void acknowledgeInterruption(recording.id)}>
                Got it
              </Button>
            ) : undefined
          }
        >
          {recording.interruptionNote ?? 'Capture stopped or paused unexpectedly, so parts of the conversation may be missing.'}
        </Banner>
      )}

      <Card className="stack">
        {audioAvailable ? (
          <AudioPlayer ref={playerRef} src={audio.url} loading={audio.loading} knownDurationMs={recording.durationMs} markers={markers} />
        ) : audio.error ? (
          <Banner tone="danger" title="Couldn’t load the audio">
            {audio.error}
          </Banner>
        ) : (
          <Banner tone="warning" title="Original audio isn’t available here">
            {recording.audioDeletedAt
              ? `The original audio was deleted on ${formatDateTime(recording.audioDeletedAt)}. The transcript and notes were kept.`
              : 'This recording’s audio is not stored on this device. Sign in to open the cloud copy if one exists.'}
          </Banner>
        )}
        {audio.source && (
          <p className="tiny muted">Playing the {audio.source === 'device' ? 'copy saved on this device' : 'private cloud copy'}.</p>
        )}
        {markers.length > 0 && (
          <p className="tiny muted">
            <span className="seek-key seek-key--chapter" aria-hidden /> chapter&nbsp;&nbsp;
            <span className="seek-key seek-key--moment" aria-hidden /> your moment
          </p>
        )}
        <div className="row-wrap">
          <Button
            variant="secondary"
            size="sm"
            icon={<Download />}
            onClick={() => void download()}
            loading={downloading}
            disabled={!recording.hasLocalAudio && !(recording.remotePath && backend)}
          >
            Download original audio
          </Button>
          {(recording.hasLocalAudio || recording.remotePath) && recording.status === 'completed' && (
            <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => setConfirmAudioDelete(true)}>
              Delete audio only
            </Button>
          )}
          <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => setDeleting(true)}>
            Delete recording
          </Button>
        </div>
      </Card>

      {showProcessCard && (
        <Card className="stack">
          <div className="spread">
            <div>
              <h2 className="h3">Transcript &amp; notes</h2>
              <p className="small muted">
                {recording.status === 'local' &&
                  'Not transcribed yet. Transcription runs on this device, so the audio is not uploaded anywhere.'}
                {recording.status === 'uploading' && 'Uploading to your private cloud storage…'}
                {recording.status === 'uploaded' && 'Uploaded. Ready to transcribe.'}
                {recording.status === 'transcribing' && 'Transcribing the audio…'}
                {recording.status === 'summarizing' && 'Writing summary, chapters, takeaways and action items…'}
                {recording.status === 'failed' && (recording.errorMessage ?? 'Processing failed.')}
              </p>
            </div>
            {!working && (
              <Button
                variant="primary"
                icon={<Sparkles />}
                disabled={!onDevice.supported || !recording.hasLocalAudio}
                onClick={() => onDevice.start(recording.id)}
              >
                {recording.status === 'failed' ? 'Retry' : 'Transcribe & summarize'}
              </Button>
            )}
          </div>
          {onDeviceProgress && (
            <OnDeviceProgressView progress={onDeviceProgress} modelMb={modelInfo.approxMb} onCancel={() => onDevice.cancel(recording.id)} />
          )}
          <PipelineSteps recording={recording} hasTranscript={!!details.transcript} showUpload={showUploadStep} />
          {recording.status === 'failed' && (
            <p className="tiny muted">Your original audio is safe — retrying continues from the step that failed.</p>
          )}
          {!onDevice.supported && (
            <Banner tone="warning" title="This browser can’t transcribe on the device">
              On-device transcription needs Web Workers, WebAssembly and Web Audio. Update your browser (a current Safari, Chrome or Edge
              works){process.available ? ', or use cloud AI below.' : '.'}
            </Banner>
          )}
          {onDevice.supported && !working && recording.durationMs > LONG_RECORDING_WARNING_MS && (
            <Banner tone="info" title="This is a long recording">
              Phones can run out of memory while decoding recordings this long. If transcription fails, try the Fast model or a computer.
            </Banner>
          )}
          {onDevice.supported && !working && (
            <p className="tiny muted">
              Speech model: {modelInfo.label} (about {modelInfo.approxMb} MB, runs in your browser, change it in Settings). The summary is
              built from sentences in the transcript, so it is an extract, not an AI rewrite.
            </p>
          )}
          {process.available && !working && (
            <div>
              <Button variant="secondary" size="sm" icon={<Cloud />} onClick={() => process.start(recording.id)}>
                {user ? 'Use cloud AI instead' : 'Sign in to use cloud AI'}
              </Button>
            </div>
          )}
        </Card>
      )}

      <div>
        <div className="tabs" role="tablist" aria-label="Recording content">
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={activeTab === 'notes'}
            onClick={() => navigate(`/recording/${recording.id}/notes`, { replace: true })}
          >
            Notes
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={activeTab === 'transcript'}
            onClick={() => navigate(`/recording/${recording.id}/transcript`, { replace: true })}
          >
            Transcript
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={activeTab === 'moments'}
            onClick={() => navigate(`/recording/${recording.id}/moments`, { replace: true })}
          >
            Moments{moments.length ? ` · ${moments.length}` : ''}
          </button>
        </div>
      </div>

      {activeTab === 'notes' && (
        <NotesPanel
          recording={recording}
          notes={details.notes}
          items={details.items}
          loading={details.loading}
          canProcess={notesCanProcess}
          processing={working}
          onProcess={() => onDevice.start(recording.id)}
          onRegenerate={() =>
            notesFromDevice
              ? onDevice.start(recording.id, { summarizeOnly: true })
              : process.start(recording.id, { force: true, summarizeOnly: true })
          }
          onChanged={details.reload}
          onSeek={seek}
          onShare={canShareLink ? () => setSharing(true) : undefined}
        />
      )}

      {activeTab === 'transcript' && (
        <TranscriptPanel
          recording={recording}
          transcript={details.transcript}
          loading={details.loading}
          canProcess={onDevice.supported}
          processing={working}
          onProcess={() => onDevice.start(recording.id)}
          onRetranscribe={
            details.transcript?.provider === 'on-device' && onDevice.supported && recording.hasLocalAudio
              ? () => onDevice.start(recording.id)
              : undefined
          }
          onSeek={(ms) => seek?.(ms)}
        />
      )}

      {activeTab === 'moments' &&
        (moments.length === 0 ? (
          <EmptyState icon={<Pin />} title="No moments marked">
            While recording, tap Key point, Action or Question to mark a moment. Markers you drop appear here and on the player.
          </EmptyState>
        ) : (
          <Card>
            <ul className="moment-list moment-list--roomy">
              {moments.map((moment) => (
                <li key={moment.id}>
                  <TimeChip atMs={moment.atMs} onSeek={seek} label={`Play ${MOMENT_LABEL[moment.kind]}`} />
                  <span className="grow">
                    <strong>{MOMENT_LABEL[moment.kind]}</strong>
                    {moment.text ? ` · ${moment.text}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ))}

      {process.consentModal}
      {renaming && <RenameDialog recording={recording} onClose={() => setRenaming(false)} />}
      {choosingCollection && <CollectionDialog recording={recording} onClose={() => setChoosingCollection(false)} />}
      {sharing && <ShareDialog recording={recording} onClose={() => setSharing(false)} />}
      {deleting && (
        <DeleteRecordingDialog recording={recording} onClose={() => setDeleting(false)} onDeleted={() => navigate('/library')} />
      )}
      {confirmAudioDelete && (
        <ConfirmDialog
          title="Delete the original audio?"
          destructive
          busy={busyAudioDelete}
          confirmLabel="Delete audio"
          message="The audio file will be deleted from this device and from your cloud storage. The transcript and notes stay. This can’t be undone."
          onCancel={() => setConfirmAudioDelete(false)}
          onConfirm={() => void deleteAudioOnly()}
        />
      )}
    </div>
  );
}
