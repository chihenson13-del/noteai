import { useState } from 'react';
import { Bookmark, X } from 'lucide-react';
import { recorder } from '../../app/container';
import { MOMENT_LABEL, sortMoments } from '../../domain/moments';
import type { MomentKind } from '../../domain/types';
import { formatTimestamp } from '../../lib/format';
import type { RecorderSnapshot } from '../../recording/recorder';
import { Button } from './primitives';

const QUICK: MomentKind[] = ['key', 'action', 'question'];

/** One-tap markers while recording. They become anchors in the notes and on the playback timeline. */
export function LiveMoments({ snapshot }: { snapshot: RecorderSnapshot }) {
  const [text, setText] = useState('');
  const enabled = snapshot.phase === 'recording' || snapshot.phase === 'paused' || snapshot.phase === 'interrupted';
  const recent = sortMoments(snapshot.moments).slice(-5).reverse();

  const add = (kind: MomentKind) => {
    if (!recorder) return;
    if (kind === 'note' && !text.trim()) return;
    if (recorder.addMoment(kind, text)) setText('');
  };

  return (
    <section className="card stack" aria-label="Moments">
      <div className="spread">
        <h2 className="h3">Moments</h2>
        <span className="tiny muted">{snapshot.moments.length} marked</span>
      </div>

      <div className="row-wrap">
        {QUICK.map((kind) => (
          <Button
            key={kind}
            variant="secondary"
            size="sm"
            icon={kind === 'key' ? <Bookmark /> : undefined}
            disabled={!enabled}
            onClick={() => add(kind)}
          >
            {MOMENT_LABEL[kind]}
          </Button>
        ))}
      </div>

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          add('note');
        }}
      >
        <label className="sr-only" htmlFor="moment-text">
          Moment note
        </label>
        <input
          id="moment-text"
          className="input grow"
          placeholder="Optional note for the next marker"
          maxLength={280}
          value={text}
          disabled={!enabled}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={!enabled || !text.trim()}>
          Add note
        </Button>
      </form>

      {recent.length > 0 ? (
        <ul className="moment-list">
          {recent.map((moment) => (
            <li key={moment.id}>
              <span className="mono moment-time">{formatTimestamp(moment.atMs)}</span>
              <span className="grow">
                <strong>{MOMENT_LABEL[moment.kind]}</strong>
                {moment.text ? ` · ${moment.text}` : ''}
              </span>
              <button type="button" className="icon-btn" aria-label={`Remove ${MOMENT_LABEL[moment.kind]} at ${formatTimestamp(moment.atMs)}`} onClick={() => recorder?.removeMoment(moment.id)}>
                <X size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">Tap a button during the recording to mark something worth coming back to.</p>
      )}
    </section>
  );
}
