// Supabase Edge Function (Deno): admin tools for access codes. Only a user who signed in with a code flagged `is_admin`
// (and not revoked) may call anything but "whoami".
//
// POST { action: "whoami" }                                   -> { admin: boolean }
// POST { action: "list" }                                     -> { codes: [...] }
// POST { action: "revoke" | "restore", codeId }               -> { status: "ok" }
// POST { action: "release_device", codeId, deviceHash }       -> { status: "ok" }
// POST { action: "create", count: 1..50, label? }             -> { codes: ["4821", ...] }  (plain codes, shown once)
//   Authorization: Bearer <user JWT>
//
// Plain codes are never stored: only their SHA-256 hash. Revoking also bans the code's auth user, so the device is signed
// out when its short-lived token expires and cannot sign in again until the code is restored.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { formatCode, generateShortCode, hashCode } from '../_shared/accessCode.ts';
import { codeStatus, parseAdminRequest } from '../_shared/admin.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
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
  const { data: userData, error: authError } = await admin.auth.getUser(token);
  if (authError || !userData.user) return json(401, { error: 'Your session has expired. Please sign in again.' });
  const userId = userData.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' });
  }
  const parsed = parseAdminRequest(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const request = parsed.value;

  const { data: self } = await admin
    .from('access_codes')
    .select('id')
    .eq('user_id', userId)
    .eq('is_admin', true)
    .is('revoked_at', null)
    .maybeSingle();
  if (request.action === 'whoami') return json(200, { admin: !!self });
  if (!self) return json(403, { error: 'This code is not an admin code.' });

  if (request.action === 'list') {
    const [codes, devices] = await Promise.all([
      admin
        .from('access_codes')
        .select('id, label, max_devices, is_admin, owner_name, owner_email, activated_at, last_used_at, created_at, revoked_at, user_id')
        .order('created_at', { ascending: true })
        .order('label', { ascending: true })
        .limit(1000),
      admin
        .from('access_code_devices')
        .select('code_id, device_hash, label, full_name, contact_email, first_seen_at, last_seen_at')
        .limit(5000),
    ]);
    if (codes.error || devices.error) return json(500, { error: 'Could not load the codes.' });
    const byCode = new Map<string, Array<Record<string, unknown>>>();
    for (const device of devices.data ?? []) {
      const list = byCode.get(device.code_id as string) ?? [];
      list.push({
        deviceHash: device.device_hash,
        label: device.label,
        fullName: device.full_name,
        contactEmail: device.contact_email,
        firstSeenAt: device.first_seen_at,
        lastSeenAt: device.last_seen_at,
      });
      byCode.set(device.code_id as string, list);
    }
    return json(200, {
      codes: (codes.data ?? []).map((row) => ({
        id: row.id,
        label: row.label,
        status: codeStatus(row as { revoked_at: string | null; activated_at: string | null; user_id: string | null }),
        isAdmin: row.is_admin === true,
        maxDevices: row.max_devices,
        ownerName: row.owner_name,
        ownerEmail: row.owner_email,
        activatedAt: row.activated_at,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
        devices: byCode.get(row.id as string) ?? [],
      })),
    });
  }

  if (request.action === 'revoke' || request.action === 'restore') {
    if (request.action === 'revoke' && request.codeId === self.id) {
      return json(400, { error: 'You cannot revoke the code you are signed in with.' });
    }
    const revoking = request.action === 'revoke';
    const { data: row, error } = await admin
      .from('access_codes')
      .update({ revoked_at: revoking ? new Date().toISOString() : null })
      .eq('id', request.codeId)
      .select('user_id')
      .maybeSingle();
    if (error) return json(500, { error: 'Could not update the code.' });
    if (!row) return json(404, { error: 'Code not found.' });
    if (row.user_id) {
      await admin.auth.admin
        .updateUserById(row.user_id as string, { ban_duration: revoking ? '876000h' : 'none' })
        .then(() => undefined, () => undefined);
    }
    return json(200, { status: 'ok' });
  }

  if (request.action === 'release_device') {
    const { error } = await admin
      .from('access_code_devices')
      .delete()
      .eq('code_id', request.codeId)
      .eq('device_hash', request.deviceHash);
    if (error) return json(500, { error: 'Could not free the device.' });
    return json(200, { status: 'ok' });
  }

  // create
  // Member codes are 4 digits, so a new one can collide with an existing code: skip those and try another.
  const created: string[] = [];
  const rows: Array<{ code_hash: string; label: string; max_devices: number }> = [];
  const hashes = new Set<string>();
  for (let attempts = 0; created.length < request.count && attempts < 2000; attempts += 1) {
    const code = generateShortCode();
    const hash = await hashCode(code);
    if (hashes.has(hash)) continue;
    const { data: taken } = await admin.from('access_codes').select('id').eq('code_hash', hash).maybeSingle();
    if (taken) continue;
    hashes.add(hash);
    created.push(formatCode(code));
    rows.push({ code_hash: hash, label: `${request.label} ${created.length}`.slice(0, 120), max_devices: 1 });
  }
  if (created.length < request.count) return json(500, { error: 'Not enough free 4-digit codes. Try fewer.' });
  const { error: insertError } = await admin.from('access_codes').insert(rows);
  if (insertError) return json(500, { error: 'Could not create the codes. Please try again.' });
  return json(200, { codes: created });
});
