// Supabase Edge Function (Deno): sign in with an access code. No account, no sign-up.
//
// POST { code, deviceId, deviceLabel?, fullName?, email? }  (public: the code is the credential)
// -> 200 { tokenHash, type: "magiclink" }  — the browser exchanges it with auth.verifyOtp() for a real session
// -> 400 malformed | 401 unknown / revoked code | 403 code bound to another device | 429 too many attempts
// -> 422 { needsProfile: true }  first time on this device: send fullName + email too (nothing is bound yet)
//
// What happens:
//  1. The code is normalized and hashed; only the hash is looked up.
//  2. Failed attempts are rate-limited per client IP (hashed).
//  3. Device binding: a code accepts at most `max_devices` distinct devices. The first device to
//     use a code claims a slot; that device can log in again at any time. A device's FIRST login
//     must include the person's full name and email, which are stored with the device.
//  4. The code owns one dedicated auth user (created on first use), so Row Level Security and
//     private storage work exactly as for email users.
//  5. A one-time magic-link token hash is generated for that user and returned.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  codeUserEmail,
  hashCode,
  hashDeviceId,
  decideDeviceAccess,
  hashIp,
  isValidDeviceId,
  isWellFormedCode,
  normalizeCode,
  sanitizeDeviceLabel,
} from '../_shared/accessCode.ts';

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

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

function randomPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) return json(503, { error: 'The backend is not configured.' });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: { code?: unknown; deviceId?: unknown; deviceLabel?: unknown; fullName?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Request body must be valid JSON.' });
  }

  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || req.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = await hashIp(ip);
  const record = (success: boolean) =>
    admin.from('code_login_attempts').insert({ ip_hash: ipHash, success }).then(() => undefined, () => undefined);

  // Rate limit: too many recent failures from this address.
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count } = await admin
    .from('code_login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .eq('success', false)
    .gte('created_at', since);
  if ((count ?? 0) >= MAX_FAILURES) {
    return json(429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const normalized = typeof body.code === 'string' ? normalizeCode(body.code) : '';
  if (!isWellFormedCode(normalized) || !isValidDeviceId(body.deviceId)) {
    await record(false);
    return json(400, { error: 'Enter the full 16-character access code.' });
  }

  const { data: row, error: lookupError } = await admin
    .from('access_codes')
    .select('id, user_id, max_devices, revoked_at, owner_name')
    .eq('code_hash', await hashCode(normalized))
    .maybeSingle();
  if (lookupError) return json(500, { error: 'Could not check the code. Please retry.' });
  if (!row || row.revoked_at) {
    await record(false);
    // Same answer for "unknown" and "revoked": do not reveal which.
    return json(401, { error: 'That code is not valid.' });
  }

  // ---- device binding ---------------------------------------------------------------------
  const deviceHash = await hashDeviceId(body.deviceId);
  const { data: devices, error: devicesError } = await admin
    .from('access_code_devices')
    .select('device_hash')
    .eq('code_id', row.id);
  if (devicesError) return json(500, { error: 'Could not check the device. Please retry.' });

  const decision = decideDeviceAccess({
    known: (devices ?? []).some((d) => d.device_hash === deviceHash),
    boundCount: (devices ?? []).length,
    maxDevices: row.max_devices as number,
    fullName: body.fullName,
    email: body.email,
  });
  const limitMessage =
    (row.max_devices as number) === 1
      ? 'This code is already in use on another device. Each code works on one device.'
      : `This code is already in use on ${row.max_devices} devices, which is its limit.`;

  let newProfile: { fullName: string; email: string } | null = null;
  if (decision.kind === 'limit_reached') {
    await record(false);
    return json(403, { error: limitMessage });
  }
  if (decision.kind === 'needs_profile') {
    // The code is valid and a slot is free, but we need to know who will use it. Nothing is
    // bound or recorded until a valid name and email arrive (and this is not a failed attempt).
    return json(422, { needsProfile: true, error: decision.error });
  }
  if (decision.kind === 'bind') {
    newProfile = decision.profile;
    const { error: insertError } = await admin.from('access_code_devices').insert({
      code_id: row.id,
      device_hash: deviceHash,
      label: sanitizeDeviceLabel(body.deviceLabel),
      full_name: decision.profile.fullName,
      contact_email: decision.profile.email,
    });
    if (insertError) {
      // The database trigger refused: another device took the last slot a moment ago.
      await record(false);
      return json(403, { error: limitMessage });
    }
  } else {
    await admin
      .from('access_code_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('code_id', row.id)
      .eq('device_hash', deviceHash)
      .then(() => undefined, () => undefined);
  }

  // ---- the auth user that belongs to this code --------------------------------------------------
  const email = codeUserEmail(row.id as string);
  let userId = (row.user_id as string | null) ?? null;
  if (!userId) {
    const created = await admin.auth.admin.createUser({
      email,
      password: randomPassword(),
      email_confirm: true,
      user_metadata: {
        access_code_id: row.id,
        ...(newProfile ? { full_name: newProfile.fullName, contact_email: newProfile.email } : {}),
      },
    });
    if (created.error || !created.data.user) {
      // Probably a concurrent first login created it; pick up the winner.
      const { data: again } = await admin.from('access_codes').select('user_id').eq('id', row.id).maybeSingle();
      userId = (again?.user_id as string | null) ?? null;
      if (!userId) return json(500, { error: 'Could not prepare your session. Please retry.' });
    } else {
      const { data: claimed } = await admin
        .from('access_codes')
        .update({ user_id: created.data.user.id })
        .eq('id', row.id)
        .is('user_id', null)
        .select('user_id');
      if (claimed && claimed.length > 0) {
        userId = created.data.user.id;
      } else {
        await admin.auth.admin.deleteUser(created.data.user.id).then(() => undefined, () => undefined);
        const { data: winner } = await admin.from('access_codes').select('user_id').eq('id', row.id).maybeSingle();
        userId = (winner?.user_id as string | null) ?? null;
        if (!userId) return json(500, { error: 'Could not prepare your session. Please retry.' });
      }
    }
  }

  // A device was just added: remember who holds the code (first device wins the code-level owner
  // fields) and expose the name to the app through the auth user's metadata.
  if (newProfile) {
    if (!row.owner_name) {
      await admin
        .from('access_codes')
        .update({ owner_name: newProfile.fullName, owner_email: newProfile.email, activated_at: new Date().toISOString() })
        .eq('id', row.id)
        .then(() => undefined, () => undefined);
    }
    await admin.auth.admin
      .updateUserById(userId, {
        user_metadata: { access_code_id: row.id, full_name: newProfile.fullName, contact_email: newProfile.email },
      })
      .then(() => undefined, () => undefined);
  }

  // ---- one-time token the browser turns into a session ---------------------------------------------
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return json(500, { error: 'Could not start your session. Please retry.' });

  await admin.from('access_codes').update({ last_used_at: new Date().toISOString() }).eq('id', row.id).then(() => undefined, () => undefined);
  await record(true);

  // Housekeeping: drop old attempt rows now and then.
  if (Math.random() < 0.05) {
    await admin
      .from('code_login_attempts')
      .delete()
      .lt('created_at', new Date(Date.now() - 2 * 86_400_000).toISOString())
      .then(() => undefined, () => undefined);
  }

  return json(200, { tokenHash, type: 'magiclink' });
});
