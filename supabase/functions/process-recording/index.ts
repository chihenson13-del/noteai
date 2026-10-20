// Supabase Edge Function (Deno): transcribe + summarize one recording.
//
// POST { recordingId, stage: "all" | "summarize", force?: boolean, options?: {...} }
//   Authorization: Bearer <user JWT>
//
// - Provider API keys are read from function secrets and never leave the server.
// - The caller can only process their own recordings (user_id is checked explicitly,
//   because this function uses the service-role client to write results).
// - Work runs in the background (EdgeRuntime.waitUntil); the response is 202 immediately and
//   the client polls recordings.status. A partial unique index on processing_jobs makes
//   concurrent / duplicate requests collapse into one job.
// - The original audio object is never modified or deleted by this function.
// - Evidence timestamps in the notes are verified against real transcript segments
//   (_shared/notes.ts#snapEvidence); unverifiable ones are dropped, never shown.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { MAX_AUDIO_BYTES, MAX_TRANSCRIPT_CHARS, STALE_JOB_MS } from '../_shared/limits.ts';
import { buildSummaryPrompt, formatTranscriptForPrompt, normalizeNotes } from '../_shared/notes.ts';
import {
  DEFAULT_NOTES_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  UserFacingError,
  readNotesProvider,
  readSpeechProvider,
  summarizeWithProvider,
  transcribeWithOpenAI,
  type NotesProvider,
  type SpeechProvider,
} from '../_shared/providers.ts';
import type { ParsedSegment } from '../_shared/transcript.ts';
import { isOwnedStoragePath, parseProcessRequest, type ProcessRequest } from '../_shared/validation.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const BUCKET = 'recordings';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface Config {
  supabaseUrl: string;
  serviceKey: string;
  openaiKey: string | null;
  anthropicKey: string | null;
  groqKey: string | null;
  transcriptionProvider: SpeechProvider;
  transcriptionModel: string;
  summaryProvider: NotesProvider;
  summaryModel: string;
}

function keyFor(config: Config, provider: NotesProvider): string | null {
  return provider === 'anthropic' ? config.anthropicKey : provider === 'groq' ? config.groqKey : config.openaiKey;
}

function readConfig(): Config {
  const summaryProvider = readNotesProvider(Deno.env.get('SUMMARY_PROVIDER'));
  const transcriptionProvider = readSpeechProvider(Deno.env.get('TRANSCRIPTION_PROVIDER'));
  return {
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    openaiKey: Deno.env.get('OPENAI_API_KEY') ?? null,
    anthropicKey: Deno.env.get('ANTHROPIC_API_KEY') ?? null,
    groqKey: Deno.env.get('GROQ_API_KEY') ?? null,
    transcriptionProvider,
    transcriptionModel: Deno.env.get('TRANSCRIPTION_MODEL') ?? DEFAULT_TRANSCRIPTION_MODEL[transcriptionProvider],
    summaryProvider,
    summaryModel: Deno.env.get('SUMMARY_MODEL') ?? DEFAULT_NOTES_MODEL[summaryProvider],
  };
}

interface RecordingRow {
  id: string;
  user_id: string;
  title: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number;
  storage_path: string | null;
  language: string | null;
}

async function setFailed(admin: SupabaseClient, recordingId: string, stage: 'transcribe' | 'summarize', message: string) {
  await admin
    .from('recordings')
    .update({ status: 'failed', failed_stage: stage, error_message: message.slice(0, 500) })
    .eq('id', recordingId);
}

/** Records what was sent to which third party, for the user's Trust center. Best effort. */
async function logTransfer(admin: SupabaseClient, recording: RecordingRow, kind: 'transcription' | 'notes', provider: string) {
  await admin
    .from('data_transfers')
    .insert({ user_id: recording.user_id, recording_id: recording.id, kind, provider })
    .then(() => undefined, () => undefined);
}

function segmentsFromRow(value: unknown): ParsedSegment[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedSegment[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { startMs, endMs, text } = entry as { startMs?: unknown; endMs?: unknown; text?: unknown };
    if (typeof startMs === 'number' && typeof endMs === 'number' && typeof text === 'string') out.push({ startMs, endMs, text });
  }
  return out;
}

async function runPipeline(
  admin: SupabaseClient,
  config: Config,
  recording: RecordingRow,
  request: ProcessRequest,
  jobId: string,
): Promise<void> {
  let stage: 'transcribe' | 'summarize' = request.stage === 'all' ? 'transcribe' : 'summarize';
  try {
    // ---- transcription ------------------------------------------------------------------
    const existing = await admin
      .from('transcripts')
      .select('full_text, language, segments')
      .eq('recording_id', recording.id)
      .maybeSingle();
    let transcriptText: string | null = existing.data?.full_text ?? null;
    let segments: ParsedSegment[] = segmentsFromRow(existing.data?.segments);

    const mustTranscribe = request.stage === 'all' && (request.force || transcriptText === null);
    if (request.stage === 'summarize' && transcriptText === null) {
      throw new UserFacingError('There is no transcript to summarize yet. Transcribe the recording first.', 409);
    }

    if (mustTranscribe) {
      const speechKey = keyFor(config, config.transcriptionProvider);
      if (!speechKey) throw new UserFacingError('Transcription is not configured on the server.', 503);
      if (!recording.storage_path) throw new UserFacingError('The recording has not been uploaded yet.', 409);

      const { data: file, error: downloadError } = await admin.storage.from(BUCKET).download(recording.storage_path);
      if (downloadError || !file) throw new UserFacingError('The uploaded audio could not be read from storage.', 502);
      if (file.size > MAX_AUDIO_BYTES) {
        throw new UserFacingError(
          `This recording is ${(file.size / 1048576).toFixed(1)} MB, above the 25 MB transcription limit. ` +
            'Your audio is safe — download it, or record shorter sessions / use Economy quality.',
          413,
        );
      }

      const extension = recording.storage_path.split('.').pop() ?? 'webm';
      const result = await transcribeWithOpenAI({
        provider: config.transcriptionProvider,
        apiKey: speechKey,
        model: config.transcriptionModel,
        file,
        fileName: `${recording.id}.${extension}`,
        language: request.options.language,
      });
      await logTransfer(admin, recording, 'transcription', config.transcriptionProvider);

      const { error: saveError } = await admin.from('transcripts').upsert(
        {
          recording_id: recording.id,
          user_id: recording.user_id,
          language: result.language,
          full_text: result.text,
          segments: result.segments,
          provider: config.transcriptionProvider,
          model: config.transcriptionModel,
        },
        { onConflict: 'recording_id' },
      );
      if (saveError) throw new UserFacingError('The transcript could not be saved.', 500);
      transcriptText = result.text;
      segments = result.segments;
      await admin
        .from('recordings')
        .update({ status: 'summarizing', language: result.language ?? recording.language })
        .eq('id', recording.id);
    } else {
      await admin.from('recordings').update({ status: 'summarizing' }).eq('id', recording.id);
    }

    // ---- summarization --------------------------------------------------------------------
    stage = 'summarize';
    const providerKey = keyFor(config, config.summaryProvider);
    if (!providerKey) throw new UserFacingError('AI notes are not configured on the server.', 503);

    const transcript = formatTranscriptForPrompt(segments, transcriptText ?? '', MAX_TRANSCRIPT_CHARS);
    const prompt = buildSummaryPrompt(transcript.text, request.options, {
      title: recording.title,
      truncated: transcript.truncated,
      hasTimestamps: transcript.hasTimestamps,
    });
    const raw = await summarizeWithProvider({
      provider: config.summaryProvider,
      apiKey: providerKey,
      model: config.summaryModel,
      system: prompt.system,
      user: prompt.user,
    });
    await logTransfer(admin, recording, 'notes', config.summaryProvider);

    let notes;
    try {
      notes = normalizeNotes(raw, request.options, { segments, durationMs: recording.duration_ms > 0 ? recording.duration_ms : null });
    } catch (error) {
      throw new UserFacingError(error instanceof Error ? error.message : 'The AI notes could not be read.', 502);
    }

    const now = new Date().toISOString();
    const { error: notesError } = await admin.from('summaries').upsert(
      {
        recording_id: recording.id,
        user_id: recording.user_id,
        summary: notes.summary,
        key_takeaways: notes.keyTakeaways,
        decisions: notes.decisions,
        chapters: notes.chapters,
        topics: [],
        provider: config.summaryProvider,
        model: config.summaryModel,
        user_edited: false,
        updated_at: now,
      },
      { onConflict: 'recording_id' },
    );
    if (notesError) throw new UserFacingError('The notes could not be saved.', 500);

    // Replace action items atomically enough for this use: delete then insert.
    await admin.from('action_items').delete().eq('recording_id', recording.id);
    if (notes.actionItems.length > 0) {
      const { error: itemsError } = await admin.from('action_items').insert(
        notes.actionItems.map((item, index) => ({
          recording_id: recording.id,
          user_id: recording.user_id,
          text: item.text,
          assignee: item.assignee,
          due_date: item.dueDate,
          evidence_ms: item.atMs,
          sort_order: index,
        })),
      );
      if (itemsError) throw new UserFacingError('The action items could not be saved.', 500);
    }

    await admin
      .from('recordings')
      .update({ status: 'completed', failed_stage: null, error_message: null })
      .eq('id', recording.id);
    await admin
      .from('processing_jobs')
      .update({ status: 'succeeded', finished_at: new Date().toISOString() })
      .eq('id', jobId);
  } catch (error) {
    const message =
      error instanceof UserFacingError ? error.message : 'Processing failed unexpectedly. Please retry in a moment.';
    if (!(error instanceof UserFacingError)) console.error('process-recording failure', error);
    await setFailed(admin, recording.id, stage, message);
    await admin
      .from('processing_jobs')
      .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
      .eq('id', jobId);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const config = readConfig();
  if (!config.supabaseUrl || !config.serviceKey) return json(503, { error: 'The backend is not configured.' });

  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in to process recordings.' });

  const admin = createClient(config.supabaseUrl, config.serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: authError } = await admin.auth.getUser(token);
  if (authError || !userData.user) return json(401, { error: 'Your session has expired. Please sign in again.' });
  const userId = userData.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' });
  }
  const parsed = parseProcessRequest(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const request = parsed.value;

  // Ownership is enforced here because the service-role client bypasses RLS.
  const { data: recording, error: lookupError } = await admin
    .from('recordings')
    .select('id, user_id, title, mime_type, size_bytes, duration_ms, storage_path, language')
    .eq('id', request.recordingId)
    .eq('user_id', userId)
    .maybeSingle<RecordingRow>();
  if (lookupError) return json(500, { error: 'Could not look up the recording.' });
  if (!recording) return json(404, { error: 'Recording not found.' });

  if (request.stage === 'all') {
    if (!recording.storage_path || !isOwnedStoragePath(recording.storage_path, userId)) {
      return json(409, { error: 'Upload the audio before processing it.' });
    }
    if (recording.size_bytes > MAX_AUDIO_BYTES) {
      const message =
        'This recording is above the 25 MB transcription limit. Your audio is safe — download it, or record shorter sessions / use Economy quality.';
      await setFailed(admin, recording.id, 'transcribe', message);
      return json(413, { error: message });
    }
    if (!keyFor(config, config.transcriptionProvider)) return json(503, { error: 'Transcription is not configured on the server.' });
  }
  const summaryKey = keyFor(config, config.summaryProvider);
  if (!summaryKey) return json(503, { error: 'AI notes are not configured on the server.' });

  // Retire jobs that were abandoned (function timeout / crash) so a retry is possible.
  await admin
    .from('processing_jobs')
    .update({ status: 'failed', error: 'Timed out', finished_at: new Date().toISOString() })
    .eq('recording_id', recording.id)
    .eq('status', 'running')
    .lt('started_at', new Date(Date.now() - STALE_JOB_MS).toISOString());

  const { data: job, error: jobError } = await admin
    .from('processing_jobs')
    .insert({
      recording_id: recording.id,
      user_id: userId,
      kind: request.stage === 'all' ? 'pipeline' : 'summarize',
      status: 'running',
    })
    .select('id')
    .single();
  if (jobError) {
    // 23505 = unique_violation on the "one running job per recording" index: de-duplicated.
    if (jobError.code === '23505') return json(202, { status: 'already_running' });
    return json(500, { error: 'Could not start processing.' });
  }

  // Flip the status before answering so the client's first poll already sees progress.
  await admin
    .from('recordings')
    .update({
      status: request.stage === 'all' ? 'transcribing' : 'summarizing',
      failed_stage: null,
      error_message: null,
    })
    .eq('id', recording.id);

  EdgeRuntime.waitUntil(runPipeline(admin, config, recording, request, job.id as string));
  return json(202, { status: 'accepted', jobId: job.id });
});
