// Supabase Edge Function (Deno): permanently delete the calling user's account and data.
//
// POST { confirm: true }   Authorization: Bearer <user JWT>
// Removes every audio object under "<userId>/" in the private bucket, then deletes the auth
// user. Database rows (recordings, transcripts, summaries, action items, jobs) are removed
// by ON DELETE CASCADE from auth.users.

import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'recordings';

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
  if (!token) return json(401, { error: 'Sign in first.' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json(401, { error: 'Your session has expired. Please sign in again.' });

  let body: { confirm?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* handled below */
  }
  if (body.confirm !== true) return json(400, { error: 'Deletion must be confirmed.' });

  const userId = data.user.id;

  // Delete audio first: if this fails we stop before the account (and the ability to retry) disappears.
  for (;;) {
    const { data: objects, error: listError } = await admin.storage.from(BUCKET).list(userId, { limit: 100 });
    if (listError) return json(502, { error: 'Could not list stored audio. Nothing was deleted from your account.' });
    if (!objects || objects.length === 0) break;
    const { error: removeError } = await admin.storage.from(BUCKET).remove(objects.map((o) => `${userId}/${o.name}`));
    if (removeError) return json(502, { error: 'Could not delete stored audio. Your account was not deleted; please retry.' });
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) return json(502, { error: 'Audio was deleted but the account could not be removed. Please retry.' });

  return json(200, { status: 'deleted' });
});
