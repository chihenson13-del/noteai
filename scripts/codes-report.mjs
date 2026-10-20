#!/usr/bin/env node
/**
 * Who has activated which access code?
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service role key> \
 *     node scripts/codes-report.mjs [--csv]
 *
 * Needs the SERVICE ROLE key (server secret). Run it on your own machine only; never put that
 * key in .env.local or the website. Prints one line per code with status, the name and email
 * given at the first login, devices used and last use. Codes themselves are never shown (only
 * their labels): the database does not contain them.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your shell first.');
  process.exit(1);
}
const asCsv = process.argv.includes('--csv');

const client = createClient(url, key, { auth: { persistSession: false } });

const { data: codes, error } = await client
  .from('access_codes')
  .select('id, label, max_devices, owner_name, owner_email, activated_at, last_used_at, revoked_at')
  .order('label', { ascending: true });
if (error) {
  console.error('Could not read access codes:', error.message);
  process.exit(1);
}
const { data: devices, error: devicesError } = await client
  .from('access_code_devices')
  .select('code_id, label, full_name, contact_email, first_seen_at, last_seen_at');
if (devicesError) {
  console.error('Could not read devices:', devicesError.message);
  process.exit(1);
}

const byCode = new Map();
for (const device of devices ?? []) {
  const list = byCode.get(device.code_id) ?? [];
  list.push(device);
  byCode.set(device.code_id, list);
}

const rows = (codes ?? []).map((code) => {
  const list = byCode.get(code.id) ?? [];
  const status = code.revoked_at ? 'revoked' : list.length === 0 ? 'unused' : 'active';
  return {
    label: code.label ?? '',
    status,
    name: code.owner_name ?? '',
    email: code.owner_email ?? '',
    devices: `${list.length}/${code.max_devices}`,
    deviceList: list.map((d) => `${d.label ?? 'device'}${d.full_name ? ` (${d.full_name} <${d.contact_email}>)` : ''}`).join('; '),
    lastUsed: code.last_used_at ?? '',
  };
});

if (asCsv) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const head = ['label', 'status', 'name', 'email', 'devices', 'deviceList', 'lastUsed'];
  console.log(head.join(','));
  for (const r of rows) console.log(head.map((h) => esc(r[h])).join(','));
} else {
  console.table(rows.map(({ deviceList, ...r }) => r));
  const used = rows.filter((r) => r.status === 'active').length;
  console.log(`${rows.length} codes: ${used} active, ${rows.filter((r) => r.status === 'unused').length} unused, ${rows.filter((r) => r.status === 'revoked').length} revoked.`);
}
