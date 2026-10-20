// Supabase Edge Function (Deno): answer a question from the caller's own transcripts.
//
// POST { question, recordingIds?, sinceDays? }   Authorization: Bearer <user JWT>
// -> { found: boolean, answer: string, sources: [{ recordingId, recordingTitle, atMs, quote }], searched: number }
//
// Retrieval is lexical (see _shared/ask.ts). If no passage matches, the AI provider is NOT
// called and the answer is "not found". Citations that do not match a supplied source are
// discarded; an answer with no valid citation is also "not found".

import { createClient } from 'npm:@supabase/supabase-js@2';
import { ASK_MAX_RECORDINGS } from '../_shared/limits.ts';
import { ASK_JSON_SCHEMA, buildAskPrompt, parseAskAnswer, selectSources, type AskCandidate } from '../_shared/ask.ts';
import { DEFAULT_NOTES_MODEL, UserFacingError, readNotesProvider, structuredWithProvider } from '../_shared/providers.ts';
import { parseAskRequest } from '../_shared/validation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) return json(503, { error: 'The backend is not configured.' });

  const provider = readNotesProvider(Deno.env.get('SUMMARY_PROVIDER'));
  const apiKey = Deno.env.get(provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY');
  const model = Deno.env.get('ASK_MODEL') ?? Deno.env.get('SUMMARY_MODEL') ?? DEFAULT_NOTES_MODEL[provider];
  if (!apiKey) return json(503, { error: 'Ask is not configured on the server.' });

  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in to ask questions.' });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: authError } = await admin.auth.getUser(token);
  if (authError || !userData.user) return json(401, { error: 'Your session has expired. Please sign in again.' });
  const userId = userData.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' });
  }
  const parsed = parseAskRequest(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { question, recordingIds, sinceDays } = parsed.value;

  // Only the caller's own, fully processed recordings are searched.
  let query = admin
    .from('recordings')
    .select('id, title, recorded_at')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('recorded_at', { ascending: false })
    .limit(ASK_MAX_RECORDINGS);
  if (recordingIds) query = query.in('id', recordingIds);
  if (sinceDays) query = query.gte('recorded_at', new Date(Date.now() - sinceDays * 86_400_000).toISOString());
  const { data: recordings, error: recordingsError } = await query;
  if (recordingsError) return json(500, { error: 'Could not search your recordings.' });
  if (!recordings || recordings.length === 0) {
    return json(200, { found: false, answer: '', sources: [], searched: 0 });
  }

  const ids = recordings.map((r) => r.id as string);
  const { data: transcripts, error: transcriptsError } = await admin
    .from('transcripts')
    .select('recording_id, full_text, segments')
    .eq('user_id', userId)
    .in('recording_id', ids);
  if (transcriptsError) return json(500, { error: 'Could not read your transcripts.' });

  const byId = new Map((transcripts ?? []).map((t) => [t.recording_id as string, t]));
  const candidates: AskCandidate[] = [];
  for (const recording of recordings) {
    const transcript = byId.get(recording.id as string);
    if (!transcript) continue;
    const segments = Array.isArray(transcript.segments)
      ? (transcript.segments as Array<{ startMs?: unknown; endMs?: unknown; text?: unknown }>)
          .filter((s) => typeof s.startMs === 'number' && typeof s.endMs === 'number' && typeof s.text === 'string')
          .map((s) => ({ startMs: s.startMs as number, endMs: s.endMs as number, text: s.text as string }))
      : [];
    candidates.push({ recordingId: recording.id as string, title: recording.title as string, fullText: transcript.full_text as string, segments });
  }

  const sources = selectSources(question, candidates);
  if (sources.length === 0) {
    // Nothing matched: do not spend a model call (or send any text to a provider).
    return json(200, { found: false, answer: '', sources: [], searched: candidates.length });
  }

  try {
    const prompt = buildAskPrompt(question, sources);
    const raw = await structuredWithProvider({
      provider,
      apiKey,
      model,
      system: prompt.system,
      user: prompt.user,
      schema: ASK_JSON_SCHEMA,
      schemaName: 'answer_from_sources',
      toolDescription: 'Return the answer and the ids of the sources that support it.',
    });
    await admin
      .from('data_transfers')
      .insert({ user_id: userId, recording_id: null, kind: 'ask', provider })
      .then(() => undefined, () => undefined);
    const result = parseAskAnswer(raw, sources);
    return json(200, { ...result, searched: candidates.length });
  } catch (error) {
    if (error instanceof UserFacingError) return json(error.status, { error: error.message });
    console.error('ask-recordings failure', error);
    return json(500, { error: 'The question could not be answered. Please retry.' });
  }
});
