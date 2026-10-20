// Supabase Edge Function (Deno): PUBLIC read-only endpoint behind share links.
//
// GET ?t=<token>  -> { snapshot, expiresAt }   (no authentication; the token is the credential)
//
// Unknown, revoked and expired tokens are indistinguishable (same 404) so links cannot be probed.
// The response is a snapshot of notes only: no audio, transcript, storage path or user id.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { hashShareToken, isWellFormedToken } from '../_shared/share.ts';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Type': 'application/json',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const NOT_FOUND = { error: 'This link is invalid or has expired.' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed.' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) return json(503, { error: 'The backend is not configured.' });

  const token = new URL(req.url).searchParams.get('t') ?? '';
  if (!isWellFormedToken(token)) return json(404, NOT_FOUND);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from('shared_notes')
    .select('snapshot, expires_at, revoked_at')
    .eq('token_hash', await hashShareToken(token))
    .maybeSingle();
  if (error) return json(500, { error: 'Could not load this link.' });
  if (!data || data.revoked_at !== null || Date.parse(data.expires_at as string) <= Date.now()) {
    return json(404, NOT_FOUND);
  }
  return json(200, { snapshot: data.snapshot, expiresAt: data.expires_at });
});
