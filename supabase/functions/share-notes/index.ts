// Supabase Edge Function (Deno): manage read-only share links for a recording's notes.
//
// POST { action: "create", recordingId, expiresInDays: 1|7|30, device? } -> { id, token, expiresAt }
//   `device` carries the notes of a recording made on the device (it has no cloud row); without it the notes are read
//   from the database.
// POST { action: "list", recordingId }                          -> { links: [...] }
// POST { action: "revoke", shareId }                            -> { status: "revoked" }
//   Authorization: Bearer <user JWT>
//
// A link is a SNAPSHOT of the notes taken at creation time (never audio, transcript, storage
// paths or user ids). Only a SHA-256 hash of the token is stored; the token is returned once.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildShareSnapshot, generateShareToken, hashShareToken } from '../_shared/share.ts';
import { parseShareRequest } from '../_shared/validation.ts';

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

  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in to share notes.' });
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
  const parsed = parseShareRequest(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const request = parsed.value;

  if (request.action === 'list') {
    const { data, error } = await admin
      .from('shared_notes')
      .select('id, recording_id, local_recording_id, created_at, expires_at, revoked_at')
      .eq('user_id', userId)
      .or(`recording_id.eq.${request.recordingId},local_recording_id.eq.${request.recordingId}`)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return json(500, { error: 'Could not load share links.' });
    return json(200, {
      links: (data ?? []).map((row) => ({
        id: row.id,
        recordingId: row.recording_id ?? row.local_recording_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      })),
    });
  }

  if (request.action === 'revoke') {
    const { data, error } = await admin
      .from('shared_notes')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', request.shareId)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .select('id');
    if (error) return json(500, { error: 'Could not revoke the link.' });
    if (!data || data.length === 0) return json(404, { error: 'Link not found or already revoked.' });
    return json(200, { status: 'revoked' });
  }

  if (request.device) {
    const device = request.device;
    const snapshot = buildShareSnapshot(
      { title: device.title, recordedAt: device.recordedAt, durationMs: device.durationMs },
      device.notes,
      device.actionItems,
    );
    const shareToken = generateShareToken();
    const expiresAt = new Date(Date.now() + request.expiresInDays * 86_400_000).toISOString();
    const { data: inserted, error: insertError } = await admin
      .from('shared_notes')
      .insert({
        user_id: userId,
        recording_id: null,
        local_recording_id: request.recordingId,
        token_hash: await hashShareToken(shareToken),
        snapshot,
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (insertError || !inserted) return json(500, { error: 'Could not create the link.' });
    return json(200, { id: inserted.id, token: shareToken, expiresAt });
  }

  // create
  const { data: recording, error: recordingError } = await admin
    .from('recordings')
    .select('id, title, recorded_at, duration_ms, status')
    .eq('id', request.recordingId)
    .eq('user_id', userId)
    .maybeSingle();
  if (recordingError) return json(500, { error: 'Could not look up the recording.' });
  if (!recording) return json(404, { error: 'Recording not found.' });

  const { data: notes } = await admin
    .from('summaries')
    .select('summary, key_takeaways, decisions, chapters, provider, model, user_edited')
    .eq('recording_id', recording.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!notes) return json(409, { error: 'This recording has no notes to share yet.' });

  const { data: actions } = await admin
    .from('action_items')
    .select('text, assignee, due_date, done, sort_order')
    .eq('recording_id', recording.id)
    .eq('user_id', userId)
    .order('sort_order', { ascending: true });

  const snapshot = buildShareSnapshot(
    { title: recording.title as string, recordedAt: recording.recorded_at as string, durationMs: recording.duration_ms as number },
    {
      summary: notes.summary as string,
      keyTakeaways: notes.key_takeaways,
      decisions: notes.decisions,
      chapters: notes.chapters,
      provider: notes.provider as string,
      model: notes.model as string,
      userEdited: notes.user_edited === true,
    },
    (actions ?? []).map((a) => ({
      text: a.text as string,
      assignee: (a.assignee as string | null) ?? null,
      dueDate: (a.due_date as string | null) ?? null,
      done: a.done === true,
    })),
  );

  const shareToken = generateShareToken();
  const expiresAt = new Date(Date.now() + request.expiresInDays * 86_400_000).toISOString();
  const { data: inserted, error: insertError } = await admin
    .from('shared_notes')
    .insert({
      user_id: userId,
      recording_id: recording.id,
      token_hash: await hashShareToken(shareToken),
      snapshot,
      expires_at: expiresAt,
    })
    .select('id')
    .single();
  if (insertError || !inserted) return json(500, { error: 'Could not create the link.' });

  return json(200, { id: inserted.id, token: shareToken, expiresAt });
});
