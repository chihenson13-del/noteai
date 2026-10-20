// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_CODES_PER_REQUEST, cleanLabel, codeStatus, parseAdminRequest } from './admin.ts';

const ID = '3f2b8c1e-9a4d-4e6b-8a1f-0c2d4e6f8a1b';
const HASH = 'a'.repeat(64);

describe('parseAdminRequest', () => {
  it('accepts every supported action', () => {
    expect(parseAdminRequest({ action: 'whoami' })).toEqual({ ok: true, value: { action: 'whoami' } });
    expect(parseAdminRequest({ action: 'list' })).toEqual({ ok: true, value: { action: 'list' } });
    expect(parseAdminRequest({ action: 'revoke', codeId: ID.toUpperCase() })).toEqual({ ok: true, value: { action: 'revoke', codeId: ID } });
    expect(parseAdminRequest({ action: 'restore', codeId: ID })).toEqual({ ok: true, value: { action: 'restore', codeId: ID } });
    expect(parseAdminRequest({ action: 'release_device', codeId: ID, deviceHash: HASH })).toEqual({
      ok: true,
      value: { action: 'release_device', codeId: ID, deviceHash: HASH },
    });
    expect(parseAdminRequest({ action: 'create', count: 5, label: '  Beta   group ' })).toEqual({
      ok: true,
      value: { action: 'create', count: 5, label: 'Beta group' },
    });
  });

  it('rejects malformed requests', () => {
    const bad = [
      null,
      [],
      'x',
      { action: 'delete_everything' },
      { action: 'revoke', codeId: 'nope' },
      { action: 'release_device', codeId: ID, deviceHash: 'short' },
      { action: 'create', count: 0 },
      { action: 'create', count: MAX_CODES_PER_REQUEST + 1 },
      { action: 'create', count: 2.5 },
      { action: 'create', count: '5' },
    ];
    for (const entry of bad) expect(parseAdminRequest(entry).ok).toBe(false);
  });

  it('cleans labels and never allows an empty one', () => {
    expect(cleanLabel('<b>Team</b>\n A', 'Beta')).toBe('bTeam/b A');
    expect(cleanLabel('   ', 'Beta')).toBe('Beta');
    expect(cleanLabel(undefined, 'Beta')).toBe('Beta');
    expect(cleanLabel('x'.repeat(300), 'Beta')).toHaveLength(80);
  });
});

describe('codeStatus', () => {
  it('derives unused / in use / revoked', () => {
    expect(codeStatus({ revoked_at: null, activated_at: null, user_id: null })).toBe('unused');
    expect(codeStatus({ revoked_at: null, activated_at: '2026-10-20T00:00:00Z', user_id: null })).toBe('in_use');
    expect(codeStatus({ revoked_at: null, activated_at: null, user_id: ID })).toBe('in_use');
    expect(codeStatus({ revoked_at: '2026-10-21T00:00:00Z', activated_at: '2026-10-20T00:00:00Z', user_id: ID })).toBe('revoked');
  });
});
