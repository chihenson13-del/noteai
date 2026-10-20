import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Mic, Pause, Play, ShieldAlert, Square, Trash2 } from 'lucide-react';
import { localStore } from '../../app/localStore';
import { recorder, whenSaved } from '../../app/container';
import { QUALITY_LABEL } from '../../domain/audioMime';
import { isSessionLive } from '../../domain/recordingMachine';
import { AppError, errorMessage } from '../../lib/errors';
import { defaultRecordingTitle, formatDuration } from '../../lib/format';
import { newId } from '../../lib/id';
import { detectRecordingSupport } from '../../recording/capabilities';
import { useLibraryStore } from '../../state/libraryStore';
import { useSettingsStore } from '../../state/settingsStore';
import { toast } from '../../state/toastStore';
import { CaptureHealth } from '../components/CaptureHealth';
import { ConfirmDialog } from '../components/Modal';
import { LevelBars } from '../components/LevelBars';
import { LiveMoments } from '../components/LiveMoments';
import { Banner, Button, Spinner } from '../components/primitives';
import { useElapsed } from '../hooks/useElapsed';
import { useNow } from '../hooks/useNow';
import { useLevelSubscription, useRecorderSnapshot } from '../hooks/useRecorder';

const PHASE_LABEL = {
  idle: 'Ready',
  requesting: 'Waiting for microphone',
  recording: 'Recording',
  paused: 'Paused',
  interrupted: 'Interrupted — not recording',
  stopping: 'Saving',
  error: 'Stopped',
} as const;

export function BackgroundRecordingNotice() {
  return (
    <Banner tone="warning" title="Keep this tab open and your screen on">
      <strong>Recording with the screen off or the browser in the background is not guaranteed.</strong> This is a website, and
      mobile browsers can pause or stop the microphone when the screen locks, you switch apps, or a call comes in — some suspend
      background tabs entirely. NoteAI keeps the screen awake where the browser allows it, shows the moment capture stops and
      saves what it has, but it cannot prevent the interruption. For a mobile recording that must not be lost, keep the screen on
      with this tab in front.
    </Banner>
  );
}

export function RecordScreen() {
  const navigate = useNavigate();
  const snapshot = useRecorderSnapshot();
  const elapsed = useElapsed(snapshot);
  const levelSubscribe = useLevelSubscription();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const savedRecording = useLibraryStore((s) => (snapshot.sessionId ? s.recordings.find((r) => r.id === snapshot.sessionId) : undefined));
  const support = useMemo(() => detectRecordingSupport(), []);

  const [title, setTitle] = useState(() => defaultRecordingTitle());
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);

  const phase = snapshot.phase;
  const live = isSessionLive(snapshot);
  const now = useNow(500, live);
  const showAck = settings.showRecordingReminder;
  const needsAck = showAck && !acknowledged;
  const displayTitle = live ? snapshot.title : title;

  const start = async () => {
    if (!recorder || busy) return;
    setBusy(true);
    try {
      await updateSettings({ recordingReminderAckAt: new Date().toISOString() });
      await recorder.start({
        sessionId: newId(),
        title: title.trim() || defaultRecordingTitle(),
        quality: settings.quality,
      });
      // The reminder applies to each recording, so the next one asks again.
      setAcknowledged(false);
    } catch (error) {
      // The recorder state already carries the error for the banner; the toast is a courtesy.
      if (!(error instanceof AppError) || error.code !== 'MIC_DENIED') toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!recorder || busy) return;
    setBusy(true);
    try {
      const audio = await recorder.stop();
      const recording = await whenSaved(audio.sessionId);
      toast.success('Recording saved to your library.');
      navigate(`/recording/${recording.id}`);
    } catch (error) {
      toast.error(errorMessage(error, 'The recording could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!recorder) return;
    setConfirmDiscard(false);
    const sessionId = await recorder.discard();
    if (sessionId) await localStore.deleteSession(sessionId).catch(() => undefined);
    toast.info('Recording discarded.');
  };

  const resume = () => {
    if (!recorder) return;
    if (phase === 'interrupted' && !recorder.resume()) {
      toast.error('The microphone is still unavailable. Stop & save what was captured, or try again in a moment.');
    } else if (phase === 'paused') {
      recorder.resume();
    }
  };

  const pillClass = `live-pill live-pill--${phase}`;

  return (
    <div className="page">
      <header>
        <h1 className="h1">Record</h1>
      </header>

      {!support.supported && (
        <Banner tone="danger" title="This browser can’t record audio">
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {support.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Banner>
      )}

      {phase === 'interrupted' && snapshot.interruption && (
        <Banner tone="danger" title="Recording is NOT capturing audio right now">
          {snapshot.interruption.message} Nothing is being recorded until the microphone is back. Audio captured so far is safe.
        </Banner>
      )}

      {phase === 'error' && snapshot.error && (
        <Banner
          tone="danger"
          title={snapshot.error.code === 'MIC_DENIED' ? 'Microphone access is blocked' : 'Recording stopped'}
          actions={
            savedRecording ? (
              <Link className="btn btn--secondary btn--sm" to={`/recording/${savedRecording.id}`}>
                Open saved audio
              </Link>
            ) : undefined
          }
        >
          {snapshot.error.message}
          {savedRecording && ' The audio captured before it stopped was saved to your library.'}
          {snapshot.error.code === 'MIC_DENIED' && (
            <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              <li>Click the lock / tune icon next to the address bar.</li>
              <li>Set Microphone to “Allow” for this site.</li>
              <li>Come back here and press Start recording.</li>
            </ol>
          )}
        </Banner>
      )}

      <section className="card record-stage" aria-label="Recorder">
        <span className={pillClass} role="status" aria-live="polite">
          <i aria-hidden />
          {PHASE_LABEL[phase]}
        </span>

        <div className={`timer${phase === 'idle' ? ' timer--idle' : ''}`} aria-label={`Elapsed time ${formatDuration(elapsed)}`}>
          {formatDuration(elapsed)}
        </div>

        <LevelBars subscribe={levelSubscribe} active={phase === 'recording'} />

        <div className="field" style={{ width: 'min(420px, 100%)' }}>
          <label className="label" htmlFor="rec-title">
            Title
          </label>
          <input
            id="rec-title"
            className="input"
            value={displayTitle}
            maxLength={120}
            disabled={phase === 'stopping' || phase === 'requesting'}
            onChange={(e) => {
              setTitle(e.target.value);
              if (live) recorder?.rename(e.target.value);
            }}
            onBlur={() => {
              if (!displayTitle.trim()) {
                const fallback = defaultRecordingTitle();
                setTitle(fallback);
                if (live) recorder?.rename(fallback);
              }
            }}
          />
        </div>

        {(phase === 'idle' || phase === 'error') && (
          <div className="stack" style={{ alignItems: 'center', width: 'min(420px, 100%)' }}>
            {showAck && (
              <label className="check card card--soft card--tight">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                <span className="small">
                  <strong>Recording consent.</strong> I will tell the people being recorded and get their permission where the law or
                  good practice requires it.
                </span>
              </label>
            )}
            <Button
              variant="primary"
              size="lg"
              block
              icon={<Mic />}
              onClick={() => void start()}
              loading={busy}
              disabled={!support.supported || needsAck || !recorder}
            >
              Start recording
            </Button>
            <p className="tiny muted" style={{ textAlign: 'center' }}>
              {QUALITY_LABEL[settings.quality].name} quality · {QUALITY_LABEL[settings.quality].description.split(' · ')[0]}. Your
              browser will ask for microphone access.
            </p>
          </div>
        )}

        {phase === 'requesting' && (
          <div className="row muted" role="status">
            <Spinner /> Allow microphone access in your browser’s prompt…
          </div>
        )}

        {(phase === 'recording' || phase === 'paused' || phase === 'interrupted') && (
          <div className="controls">
            <div>
              {phase === 'recording' ? (
                <button type="button" className="round" onClick={() => recorder?.pause()} aria-label="Pause recording">
                  <Pause aria-hidden />
                </button>
              ) : (
                <button type="button" className="round round--primary" onClick={resume} aria-label={phase === 'paused' ? 'Resume recording' : 'Try to resume recording'}>
                  <Play aria-hidden />
                </button>
              )}
              <div className="control-label">{phase === 'recording' ? 'Pause' : phase === 'paused' ? 'Resume' : 'Try again'}</div>
            </div>
            <div>
              <button type="button" className="round round--stop" onClick={() => void stop()} disabled={busy} aria-label="Stop and save recording">
                {busy ? <Spinner /> : <Square aria-hidden />}
              </button>
              <div className="control-label">Stop &amp; save</div>
            </div>
          </div>
        )}

        {phase === 'stopping' && (
          <div className="row muted" role="status">
            <Spinner /> Saving your recording…
          </div>
        )}

        {(phase === 'recording' || phase === 'paused' || phase === 'interrupted') && (
          <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => setConfirmDiscard(true)}>
            Discard recording
          </Button>
        )}
      </section>

      <CaptureHealth snapshot={snapshot} subscribeLevel={levelSubscribe} now={now} />

      <LiveMoments snapshot={snapshot} />

      {snapshot.persistenceWarning && (
        <Banner tone="warning" title="Auto-save is limited">
          {snapshot.persistenceWarning}
        </Banner>
      )}

      {snapshot.hiddenSince !== null && live && (
        <Banner tone="warning" title="This tab was in the background">
          Capture may have been paused by your device. Check that the status above still says “Recording”.
        </Banner>
      )}

      <BackgroundRecordingNotice />

      <Banner tone="info" title="Privacy">
        <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <ShieldAlert size={16} aria-hidden style={{ marginTop: 3, flex: 'none' }} />
          <span>
            Audio is saved on this device first. It is uploaded only if you choose to transcribe it. Only record people who know and
            agree they are being recorded.
          </span>
        </span>
      </Banner>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this recording?"
          destructive
          confirmLabel="Discard"
          cancelLabel="Keep recording"
          message={
            <span>
              <AlertTriangle size={16} aria-hidden style={{ verticalAlign: '-3px' }} /> The {formatDuration(elapsed)} captured so far will
              be permanently deleted and cannot be recovered.
            </span>
          }
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => void discard()}
        />
      )}
    </div>
  );
}
