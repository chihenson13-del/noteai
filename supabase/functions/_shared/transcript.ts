export interface ParsedSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ParsedTranscript {
  text: string;
  language: string | null;
  segments: ParsedSegment[];
}

const SECOND = 1000;

/**
 * Normalizes an OpenAI `/audio/transcriptions` response.
 *  - `verbose_json` (whisper-1): `{ text, language, segments: [{ start, end, text }] }`
 *  - `json` (gpt-4o-transcribe family): `{ text }` only — no timestamps are invented.
 */
export function parseTranscriptionResponse(payload: unknown): ParsedTranscript {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('The transcription provider returned an unexpected response.');
  }
  const data = payload as { text?: unknown; language?: unknown; segments?: unknown };
  const segments: ParsedSegment[] = [];

  if (Array.isArray(data.segments)) {
    for (const entry of data.segments) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { start, end, text } = entry as { start?: unknown; end?: unknown; text?: unknown };
      if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') continue;
      const cleaned = text.trim();
      if (!cleaned) continue;
      segments.push({
        startMs: Math.max(0, Math.round(start * SECOND)),
        endMs: Math.max(0, Math.round(end * SECOND)),
        text: cleaned,
      });
    }
  }

  const textFromSegments = segments.map((s) => s.text).join(' ');
  const text = typeof data.text === 'string' && data.text.trim() ? data.text.trim() : textFromSegments;
  if (!text) {
    throw new Error('No speech was detected in the recording, so there is nothing to transcribe.');
  }
  const language = typeof data.language === 'string' && data.language.trim() ? data.language.trim().toLowerCase() : null;
  return { text, language, segments };
}

/** Clips a transcript for the summarization model. Reports whether anything was cut. */
export function clipTranscript(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
