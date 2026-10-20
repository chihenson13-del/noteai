import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Pause, Play } from 'lucide-react';
import { formatDuration } from '../../lib/format';
import { Spinner } from './primitives';

export interface PlayerMarker {
  atMs: number;
  kind: 'chapter' | 'moment';
  label: string;
}

export interface AudioPlayerHandle {
  seekTo(ms: number): void;
  play(): void;
}

/**
 * MediaRecorder output (WebM) usually has no duration header, so `audio.duration` is
 * Infinity until the whole file was scanned. We use the known recording duration for the UI
 * and trigger the browser to compute the real value with the classic seek-to-end trick.
 */
export function AudioPlayer({
  src,
  loading,
  knownDurationMs,
  markers = [],
  ref,
}: {
  src: string | null;
  loading?: boolean;
  knownDurationMs: number;
  /** Chapter starts and user moments drawn on the seek bar. */
  markers?: PlayerMarker[];
  ref?: Ref<AudioPlayerHandle>;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const duration = mediaDuration ?? knownDurationMs / 1000;

  useImperativeHandle(ref, () => ({
    seekTo(ms: number) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.max(0, ms / 1000);
    },
    play() {
      void audioRef.current?.play().catch(() => undefined);
    },
  }));

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setMediaDuration(null);
    setPlaybackError(null);
  }, [src]);

  const onLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration)) {
      setMediaDuration(audio.duration);
      return;
    }
    // Force the browser to scan to the end so seeking works and duration becomes finite.
    const restore = () => {
      audio.removeEventListener('timeupdate', restore);
      audio.currentTime = 0;
      if (Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
    };
    audio.addEventListener('timeupdate', restore);
    audio.currentTime = 1e6;
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => setPlaybackError('Playback was blocked or the audio could not be decoded.'));
    } else {
      audio.pause();
    }
  };

  const shownDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const markerDots = markers
    .filter((m) => shownDuration > 0 && m.atMs >= 0 && m.atMs / 1000 <= shownDuration)
    .map((m, index) => (
      <span
        key={`${m.kind}-${m.atMs}-${index}`}
        className={`seek-marker seek-marker--${m.kind}`}
        style={{ left: `${(m.atMs / 1000 / shownDuration) * 100}%` }}
        title={`${m.label} · ${formatDuration(m.atMs)}`}
        aria-hidden
      />
    ));

  return (
    <div className="player">
      <div className="player-bar">
        <button type="button" className="player-play" onClick={toggle} disabled={!src || loading} aria-label={playing ? 'Pause' : 'Play'}>
          {loading ? <Spinner label="Loading audio" /> : playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </button>
        <div className="seek-wrap">
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(shownDuration, 0.01)}
          step={0.1}
          value={Math.min(current, shownDuration || 0)}
          disabled={!src}
          aria-label="Seek"
          onChange={(event) => {
            const audio = audioRef.current;
            if (audio) audio.currentTime = Number(event.target.value);
            setCurrent(Number(event.target.value));
          }}
        />
          {markerDots}
        </div>
        <span className="time">
          {formatDuration(current * 1000)} / {formatDuration(shownDuration * 1000)}
        </span>
      </div>
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={() => {
            const audio = audioRef.current;
            if (audio && Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
          }}
          onTimeUpdate={() => setCurrent(audioRef.current?.currentTime ?? 0)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setPlaybackError('This audio could not be played in your browser. You can still download the original file.')}
        />
      )}
      {playbackError && (
        <p className="small" role="alert" style={{ color: 'var(--danger)' }}>
          {playbackError}
        </p>
      )}
    </div>
  );
}
