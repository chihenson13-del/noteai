import type { AskResponse } from '../data/backend';
import type { Recording, Transcript } from '../domain/types';
import { selectSources, type AskCandidate } from '../../supabase/functions/_shared/ask';

export interface LocalAskRequest {
  question: string;
  /** Limit to one recording. */
  recordingId?: string;
  /** Only recordings made within this many days. */
  sinceDays?: number;
}

const MAX_RECORDINGS = 60;
const MAX_SOURCES = 6;

/**
 * "Ask" without any server or AI model: finds the passages of your own transcripts that contain
 * the words of the question and shows them, with the time they were said. It never writes an
 * answer, so there is nothing to get wrong, and "not found" is a normal result.
 */
export function localAsk(
  request: LocalAskRequest,
  recordings: Recording[],
  getTranscript: (recordingId: string) => Transcript | undefined,
  now: number = Date.now(),
): AskResponse {
  const cutoff = request.sinceDays ? now - request.sinceDays * 86_400_000 : null;
  const scoped = recordings
    .filter((r) => r.status === 'completed')
    .filter((r) => (request.recordingId ? r.id === request.recordingId : true))
    .filter((r) => (cutoff === null ? true : Date.parse(r.createdAt) >= cutoff))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_RECORDINGS);

  const candidates: AskCandidate[] = [];
  for (const recording of scoped) {
    const transcript = getTranscript(recording.id);
    if (!transcript || !transcript.text.trim()) continue;
    candidates.push({
      recordingId: recording.id,
      title: recording.title,
      fullText: transcript.text,
      segments: transcript.segments,
    });
  }

  const sources = selectSources(request.question, candidates, MAX_SOURCES);
  if (sources.length === 0) return { found: false, answer: '', sources: [], searched: candidates.length };

  return {
    found: true,
    answer: `The closest passages in your recordings (matched on the words in your question):`,
    sources: sources.map((s) => ({
      recordingId: s.recordingId,
      recordingTitle: s.recordingTitle,
      atMs: s.atMs,
      quote: s.text.replace(/\s+/g, ' ').trim(),
    })),
    searched: candidates.length,
  };
}
