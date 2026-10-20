import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp } from 'lucide-react';
import { backend } from '../../app/backend';
import { localStore } from '../../app/localStore';
import type { AskResponse } from '../../data/backend';
import { formatTimestamp } from '../../lib/format';
import { env } from '../../config/env';
import { errorMessage } from '../../lib/errors';
import { localAsk } from '../../services/localAsk';
import { useAuthStore } from '../../state/authStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useSettingsStore } from '../../state/settingsStore';
import { Banner, Button, Card, Spinner } from '../components/primitives';
import { UploadConsentModal } from '../components/shared';

interface Turn {
  id: number;
  question: string;
  state: 'pending' | 'done' | 'error';
  response?: AskResponse;
  error?: string;
}

const STARTERS = ['What decisions were made?', 'What did we say about the budget?', 'Who is responsible for follow-ups?'];

/**
 * Ask across your processed recordings. Answers cite the transcript passages they came from,
 * and "not found" is a normal outcome: the server refuses to answer without evidence.
 */
export function AskScreen() {
  const user = useAuthStore((s) => s.user);
  const recordings = useLibraryStore((s) => s.recordings);
  const consentAt = useSettingsStore((s) => s.settings.uploadConsentAt);
  const updateSettings = useSettingsStore((s) => s.update);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<string>('all');
  const [recentOnly, setRecentOnly] = useState(false);
  const [needsConsent, setNeedsConsent] = useState<string | null>(null);
  const nextId = useRef(1);

  // With an account the cloud answers (an AI provider, with citations). Otherwise the search runs
  // on this device over the transcripts stored here, and only shows matching passages.
  const cloud = !!backend && !!user && env.cloudAi;
  const processed = useMemo(
    () => recordings.filter((r) => r.status === 'completed' && (cloud ? r.inCloud : true)),
    [recordings, cloud],
  );

  const run = async (text: string) => {
    const id = nextId.current++;
    setTurns((prev) => [...prev, { id, question: text, state: 'pending' }]);
    setQuestion('');
    try {
      let response: AskResponse;
      if (cloud && backend) {
        response = await backend.askRecordings({
          question: text,
          recordingIds: scope === 'all' ? undefined : [scope],
          sinceDays: recentOnly ? 30 : undefined,
        });
      } else {
        const transcripts = new Map<string, Awaited<ReturnType<typeof localStore.getTranscript>>>();
        const wanted = scope === 'all' ? processed : processed.filter((r) => r.id === scope);
        for (const recording of wanted) transcripts.set(recording.id, await localStore.getTranscript(recording.id));
        response = localAsk(
          { question: text, recordingId: scope === 'all' ? undefined : scope, sinceDays: recentOnly ? 30 : undefined },
          processed,
          (recordingId) => transcripts.get(recordingId),
        );
      }
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, state: 'done', response } : t)));
    } catch (error) {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, state: 'error', error: errorMessage(error, 'The question could not be answered.') } : t)));
    }
  };

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 3) return;
    if (cloud && !consentAt) {
      setNeedsConsent(trimmed);
      return;
    }
    void run(trimmed);
  };

  return (
    <div className="page">
      <header>
        <h1 className="h1 display">Ask your recordings</h1>
        <p className="muted">
          {cloud
            ? 'Answers come only from what was said in your processed recordings, with the source one tap away.'
            : 'Finds the passages of your transcribed recordings that mention what you ask about, with the time they were said.'}
        </p>
      </header>

      <Card className="stack" tight>
        <div className="row-wrap">
          <label className="row small">
            <span className="muted">Search in</span>
            <select className="select" style={{ width: 'auto', maxWidth: 260 }} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All processed recordings ({processed.length})</option>
              {processed.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
          <label className="check small">
            <input type="checkbox" checked={recentOnly} onChange={(e) => setRecentOnly(e.target.checked)} />
            <span>Last 30 days only</span>
          </label>
        </div>
        <p className="tiny muted">
          Searching uses keywords from your question, not meaning, so use words that were actually said.{' '}
          {cloud
            ? 'Matching passages (not whole transcripts) are sent to the AI provider.'
            : 'This search runs on your device and nothing is sent anywhere.'}
        </p>
        {!cloud && backend && env.cloudAi && (
          <p className="tiny muted">
            <Link to="/auth" state={{ from: '/ask' }}>
              Sign in
            </Link>{' '}
            to have an AI write answers from your synced recordings.
          </p>
        )}
      </Card>

      {processed.length === 0 && (
        <Banner tone="info" title="Nothing to search yet">
          Transcribe a recording first (open it and press Transcribe &amp; summarize). Ask searches recordings that have a transcript.
        </Banner>
      )}

      <section className="stack" aria-label="Conversation" aria-live="polite">
        {turns.length === 0 && processed.length > 0 && (
          <div className="chips" role="group" aria-label="Question ideas">
            {STARTERS.map((starter) => (
              <button key={starter} type="button" className="chip" onClick={() => submit(starter)}>
                {starter}
              </button>
            ))}
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="stack" style={{ gap: 10 }}>
            <div className="bubble bubble--user">{turn.question}</div>

            {turn.state === 'pending' && (
              <div className="bubble bubble--answer row muted" role="status">
                <Spinner /> Searching your recordings…
              </div>
            )}

            {turn.state === 'error' && (
              <div className="bubble bubble--answer" role="alert" style={{ color: 'var(--danger)' }}>
                {turn.error}
              </div>
            )}

            {turn.state === 'done' && turn.response && !turn.response.found && (
              <div className="bubble bubble--answer">
                <strong>I couldn’t find that.</strong>{' '}
                <span className="muted">
                  {turn.response.searched === 0
                    ? 'There are no processed recordings in that scope.'
                    : `Nothing in the ${turn.response.searched} recording${turn.response.searched === 1 ? '' : 's'} I searched clearly answers it. Try different keywords.`}
                </span>
              </div>
            )}

            {turn.state === 'done' && turn.response?.found && (
              <div className="bubble bubble--answer stack" style={{ gap: 12 }}>
                <p style={{ whiteSpace: 'pre-line' }}>{turn.response.answer}</p>
                <div className="stack" style={{ gap: 8 }}>
                  <div className="eyebrow">Sources</div>
                  {turn.response.sources.map((source, index) => (
                    <Link
                      key={`${source.recordingId}-${source.atMs}-${index}`}
                      className="source"
                      to={`/recording/${source.recordingId}/transcript${source.atMs !== null ? `?t=${source.atMs}` : ''}`}
                    >
                      <span className="source-head">
                        <span className="truncate">{source.recordingTitle}</span>
                        {source.atMs !== null && <span className="mono">▶ {formatTimestamp(source.atMs)}</span>}
                      </span>
                      <span className="source-quote">“{source.quote}”</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </section>

      <form
        className="ask-bar"
        onSubmit={(event) => {
          event.preventDefault();
          submit(question);
        }}
      >
        <label className="sr-only" htmlFor="ask-input">
          Ask a question
        </label>
        <input
          id="ask-input"
          className="input"
          placeholder="Ask about your meetings and notes"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button type="submit" variant="primary" iconOnly icon={<ArrowUp />} aria-label="Send question" disabled={question.trim().length < 3} />
      </form>
      <p className="tiny muted" style={{ textAlign: 'center' }}>
        {cloud ? 'AI can be wrong. Check the sources before you rely on an answer.' : 'Check the source passages — this search does not understand meaning.'}
      </p>

      {cloud && needsConsent && (
        <UploadConsentModal
          onCancel={() => setNeedsConsent(null)}
          onAccept={() => {
            const text = needsConsent;
            setNeedsConsent(null);
            void updateSettings({ uploadConsentAt: new Date().toISOString() }).then(() => run(text));
          }}
        />
      )}
    </div>
  );
}
