// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  cleanFullName,
  codeUserEmail,
  decideDeviceAccess,
  formatCode,
  formatCodeInput,
  generateCode,
  hashCode,
  hashDeviceId,
  isCodeUserEmail,
  isValidDeviceId,
  isWellFormedCode,
  normalizeCode,
  sanitizeDeviceLabel,
  validateEmail,
  validateFullName,
  validateProfile,
} from './accessCode.ts';
import * as script from '../../../scripts/generate-codes.mjs';

describe('access code format', () => {
  it('normalizes pasted / hand-typed codes', () => {
    expect(normalizeCode(' abcd-1234 efgh_5678 ')).toBe('ABCD1234EFGH5678');
    expect(normalizeCode('oIlL')).toBe('0111'); // O→0, I/L→1
    expect(formatCode('ABCD1234EFGH5678')).toBe('ABCD-1234-EFGH-5678');
    expect(formatCode('ABCD12')).toBe('ABCD-12');
  });

  it('formats as the user types, capped at the code length', () => {
    expect(formatCodeInput('abcd')).toBe('ABCD');
    expect(formatCodeInput('abcd1')).toBe('ABCD-1');
    expect(formatCodeInput('abcd1234efgh5678zzzz9999')).toBe('ABCD-1234-EFGH-5678');
    expect(formatCodeInput('')).toBe('');
  });

  it('accepts only 16 characters from the alphabet', () => {
    expect(isWellFormedCode('0123456789ABCDEF')).toBe(true);
    expect(isWellFormedCode('0123456789ABCDE')).toBe(false);
    expect(isWellFormedCode('0123456789ABCDEFG')).toBe(false);
    expect(isWellFormedCode('0123456789ABCDEU')).toBe(false); // U is not in the alphabet
    expect(isWellFormedCode(normalizeCode('0123-4567-89ab-cdef'))).toBe(true);
  });
});

describe('code generation', () => {
  it('produces well-formed codes with enough spread', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(isWellFormedCode(code)).toBe(true);
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
  });

  it('uses every symbol of the alphabet roughly evenly (no modulo bias)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const ch of generateCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(CODE_ALPHABET.length);
    const values = [...counts.values()];
    const expected = (4000 * CODE_LENGTH) / CODE_ALPHABET.length; // 2000
    for (const v of values) expect(Math.abs(v - expected)).toBeLessThan(expected * 0.15);
  });

  it('is deterministic for a given byte source', () => {
    const fixed = () => Uint8Array.from({ length: 32 }, (_, i) => i);
    expect(generateCode(fixed)).toBe(generateCode(fixed));
    expect(generateCode(fixed)).toHaveLength(CODE_LENGTH);
  });
});

describe('hashing', () => {
  it('hashes the normalized code, so formatting does not matter', async () => {
    const a = await hashCode('ABCD-1234-EFGH-5678');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashCode('abcd1234efgh5678')).toBe(a);
    expect(await hashCode('ABCD-1234-EFGH-5679')).not.toBe(a);
  });

  it('keeps code, device and ip hashes in separate domains', async () => {
    expect(await hashDeviceId('11111111-2222-3333-4444-555555555555')).not.toBe(await hashCode('11111111-2222-3333-4444-555555555555'));
  });

  it('matches the generation script exactly (so seeded hashes work)', async () => {
    expect(script.CODE_ALPHABET).toBe(CODE_ALPHABET);
    expect(script.CODE_LENGTH).toBe(CODE_LENGTH);
    for (const sample of ['ABCD-1234-EFGH-5678', 'oiLo-1111-zzzz-0000', '0123456789abcdef']) {
      expect(script.normalizeCode(sample)).toBe(normalizeCode(sample));
      expect(script.hashCode(sample)).toBe(await hashCode(sample));
    }
    const batch = script.generateBatch({ count: 25, prefix: 'Test' });
    expect(new Set(batch.map((r) => r.code)).size).toBe(25);
    expect(batch[0]?.label).toBe('Test 001');
    for (const row of batch) {
      expect(isWellFormedCode(row.code)).toBe(true);
      expect(row.hash).toBe(await hashCode(row.code));
    }
  });

  it('seed SQL contains hashes and escapes labels, never codes', () => {
    const batch = script.generateBatch({ count: 2, prefix: "O'Brien" });
    const sql = script.buildSeedSql(batch, 1);
    expect(sql).toContain("'O''Brien 001'");
    expect(sql).toContain('on conflict (code_hash) do nothing');
    for (const row of batch) {
      expect(sql).toContain(row.hash);
      expect(sql).not.toContain(row.code);
    }
  });
});

describe('device identity', () => {
  it('accepts random browser ids and rejects junk', () => {
    expect(isValidDeviceId('3f2b8c1e-9a4d-4e6b-8a1f-0c2d4e6f8a1b')).toBe(true);
    expect(isValidDeviceId('short')).toBe(false);
    expect(isValidDeviceId("'; drop table access_codes; --")).toBe(false);
    expect(isValidDeviceId(42)).toBe(false);
  });

  it('sanitizes device labels', () => {
    expect(sanitizeDeviceLabel('  Chrome   on <b>Windows</b>\n')).toBe('Chrome on bWindows/b');
    expect(sanitizeDeviceLabel('x'.repeat(200))).toHaveLength(80);
    expect(sanitizeDeviceLabel('   ')).toBeNull();
    expect(sanitizeDeviceLabel(null)).toBeNull();
  });

  it('recognises synthetic code-user addresses', () => {
    const email = codeUserEmail('3f2b8c1e-9a4d-4e6b-8a1f-0c2d4e6f8a1b');
    expect(isCodeUserEmail(email)).toBe(true);
    expect(isCodeUserEmail('person@example.com')).toBe(false);
    expect(isCodeUserEmail(null)).toBe(false);
  });
});

describe('first-login profile', () => {
  it('validates and cleans the full name', () => {
    expect(validateFullName('  Ada   Lovelace ')).toEqual({ ok: true, value: 'Ada Lovelace' });
    expect(validateFullName('José Álvarez-Núñez')).toMatchObject({ ok: true });
    expect(validateFullName('李小龍')).toMatchObject({ ok: true });
    expect(cleanFullName('A\u0000da <script>')).toBe('Ada script');
    for (const bad of ['', ' ', 'A', '12345', '!!!', 'x'.repeat(101), null, 42]) {
      expect(validateFullName(bad).ok).toBe(false);
    }
  });

  it('validates and lower-cases the email', () => {
    expect(validateEmail('  Ada@Example.COM ')).toEqual({ ok: true, value: 'ada@example.com' });
    expect(validateEmail('first.last+tag@sub.example.org')).toMatchObject({ ok: true });
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com', 'ada@@example.com', 'a..b@example.com', `${'a'.repeat(250)}@x.io`, null]) {
      expect(validateEmail(bad).ok).toBe(false);
    }
  });

  it('requires both, reporting the first problem', () => {
    expect(validateProfile('Ada Lovelace', 'ada@example.com')).toEqual({
      ok: true,
      value: { fullName: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect(validateProfile('', 'ada@example.com')).toMatchObject({ ok: false, error: 'Enter your full name.' });
    expect(validateProfile('Ada Lovelace', 'nope')).toMatchObject({ ok: false, error: 'Enter a valid email address.' });
    expect(validateProfile(undefined, undefined).ok).toBe(false);
  });
});

describe('device binding decision', () => {
  const profile = { fullName: 'Ada Lovelace', email: 'ada@example.com' };

  it('lets a known device straight in, with or without a profile', () => {
    expect(decideDeviceAccess({ known: true, boundCount: 1, maxDevices: 1, fullName: undefined, email: undefined })).toEqual({ kind: 'known' });
    expect(decideDeviceAccess({ known: true, boundCount: 1, maxDevices: 1, ...profile, fullName: 'Ada Lovelace', email: 'x' })).toEqual({ kind: 'known' });
  });

  it('asks a new device for name and email before binding anything', () => {
    const first = decideDeviceAccess({ known: false, boundCount: 0, maxDevices: 1, fullName: undefined, email: undefined });
    expect(first).toMatchObject({ kind: 'needs_profile', asked: false });
    expect((first as { error: string }).error).toMatch(/first time on this device/i);

    const bad = decideDeviceAccess({ known: false, boundCount: 0, maxDevices: 1, fullName: 'Ada Lovelace', email: 'nope' });
    expect(bad).toMatchObject({ kind: 'needs_profile', asked: true, error: 'Enter a valid email address.' });
  });

  it('binds a new device once a valid profile arrives', () => {
    expect(decideDeviceAccess({ known: false, boundCount: 0, maxDevices: 1, fullName: ' Ada  Lovelace ', email: 'ADA@example.com' })).toEqual({
      kind: 'bind',
      profile,
    });
  });

  it('refuses a second device on a one-device code, without asking for personal data', () => {
    for (const fullName of [undefined, 'Grace Hopper']) {
      expect(decideDeviceAccess({ known: false, boundCount: 1, maxDevices: 1, fullName, email: 'grace@example.com' })).toEqual({ kind: 'limit_reached' });
    }
  });

  it('honours larger limits', () => {
    expect(decideDeviceAccess({ known: false, boundCount: 1, maxDevices: 2, fullName: 'Grace Hopper', email: 'grace@example.com' })).toMatchObject({ kind: 'bind' });
    expect(decideDeviceAccess({ known: false, boundCount: 2, maxDevices: 2, fullName: 'Grace Hopper', email: 'grace@example.com' })).toEqual({ kind: 'limit_reached' });
  });
});
