/**
 * Pure helpers for the `admin-codes` Edge Function: request validation and the status shown for a code.
 * No Deno or DOM APIs, so they are unit-tested under Node.
 */

export type AdminRequest =
  | { action: 'whoami' }
  | { action: 'list' }
  | { action: 'revoke'; codeId: string }
  | { action: 'restore'; codeId: string }
  | { action: 'release_device'; codeId: string; deviceHash: string }
  | { action: 'create'; count: number; label: string };

export type AdminParse = { ok: true; value: AdminRequest } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const MAX_CODES_PER_REQUEST = 50;

export function cleanLabel(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim() : '';
  return (text || fallback).slice(0, 80);
}

export function parseAdminRequest(body: unknown): AdminParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  switch (input.action) {
    case 'whoami':
      return { ok: true, value: { action: 'whoami' } };
    case 'list':
      return { ok: true, value: { action: 'list' } };
    case 'revoke':
    case 'restore': {
      if (typeof input.codeId !== 'string' || !UUID.test(input.codeId)) return { ok: false, error: 'codeId must be a UUID.' };
      return { ok: true, value: { action: input.action, codeId: input.codeId.toLowerCase() } };
    }
    case 'release_device': {
      if (typeof input.codeId !== 'string' || !UUID.test(input.codeId)) return { ok: false, error: 'codeId must be a UUID.' };
      if (typeof input.deviceHash !== 'string' || !SHA256_HEX.test(input.deviceHash)) return { ok: false, error: 'deviceHash is not valid.' };
      return { ok: true, value: { action: 'release_device', codeId: input.codeId.toLowerCase(), deviceHash: input.deviceHash } };
    }
    case 'create': {
      const count = input.count;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_CODES_PER_REQUEST) {
        return { ok: false, error: `count must be a whole number from 1 to ${MAX_CODES_PER_REQUEST}.` };
      }
      return { ok: true, value: { action: 'create', count, label: cleanLabel(input.label, 'Beta') } };
    }
    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

export type CodeStatus = 'unused' | 'in_use' | 'revoked';

/** unused = never activated, in_use = a device has activated it, revoked = switched off by an admin. */
export function codeStatus(row: { revoked_at: string | null; activated_at: string | null; user_id: string | null }): CodeStatus {
  if (row.revoked_at) return 'revoked';
  return row.activated_at || row.user_id ? 'in_use' : 'unused';
}
