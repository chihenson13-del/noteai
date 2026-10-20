/**
 * Access codes: sign-in without an account.
 *
 * A code is 16 characters from the Crockford base32 alphabet (80 bits of randomness), written
 * as XXXX-XXXX-XXXX-XXXX. Only a SHA-256 hash of the normalized code is ever stored, and with
 * 80 bits an offline guess against a leaked hash list is infeasible.
 *
 * Pure functions only (no Deno or DOM APIs) so the browser, the Edge Function and the
 * generation script share one definition.
 */

/** Crockford base32: no I, L, O, U, so codes survive being read aloud or hand-copied. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 16;
export const CODE_GROUP = 4;
/**
 * Member codes are 4 digits (1000-9999): easy to type on a phone, but only ~13 bits, so they can be guessed. The server
 * therefore rate-limits failures per address and overall (see redeem-code). Admin codes stay at the long form.
 */
export const SHORT_CODE_LENGTH = 4;

/** Uppercases, maps look-alikes (O→0, I/L→1) and drops separators and spaces. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
}

export function isWellFormedCode(normalized: string): boolean {
  if (normalized.length === SHORT_CODE_LENGTH) return /^[0-9]{4}$/.test(normalized);
  if (normalized.length !== CODE_LENGTH) return false;
  for (const char of normalized) {
    if (!CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/** "ABCD1234EFGH5678" -> "ABCD-1234-EFGH-5678". Works on partial input too. */
export function formatCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += CODE_GROUP) groups.push(normalized.slice(i, i + CODE_GROUP));
  return groups.join('-');
}

/** What a text field should show for whatever the user has typed or pasted so far. */
export function formatCodeInput(raw: string): string {
  return formatCode(normalizeCode(raw).slice(0, CODE_LENGTH));
}

/** Generates one code (normalized form). `random` is injectable for tests. */
export function generateCode(random: (length: number) => Uint8Array = defaultRandom): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH * 2)) {
      // 256 is a multiple of 32, so masking is unbiased.
      code += CODE_ALPHABET[byte & 31];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** A random 4-digit member code, 1000-9999 (no leading zero, so it survives being typed as a number). */
export function generateShortCode(random: (length: number) => Uint8Array = defaultRandom): string {
  for (;;) {
    const bytes = random(2);
    const value = (bytes[0] ?? 0) * 256 + (bytes[1] ?? 0);
    // 63000 = 7 * 9000: rejecting the tail keeps every number equally likely.
    if (value < 63_000) return String(1000 + (value % 9000));
  }
}

function defaultRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hash stored in the database for a code (accepts formatted or normalized input). */
export function hashCode(code: string): Promise<string> {
  return sha256Hex(`noteai-code:v1:${normalizeCode(code)}`);
}

export function hashDeviceId(deviceId: string): Promise<string> {
  return sha256Hex(`noteai-device:v1:${deviceId}`);
}

export function hashIp(ip: string): Promise<string> {
  return sha256Hex(`noteai-ip:v1:${ip}`);
}

/** Device ids are random UUIDs (or similar tokens) made by the browser. */
export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(value);
}

/** Human label shown to the code owner / admin, e.g. "Chrome on Windows". Stripped and bounded. */
export function sanitizeDeviceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned === '' ? null : cleaned;
}

/** Synthetic, non-routable address that identifies the auth user behind a code. */
export function codeUserEmail(codeId: string): string {
  return `code-${codeId}@codes.noteai.invalid`;
}

export function isCodeUserEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.endsWith('@codes.noteai.invalid');
}

// ---- first-login profile (collected once per device) ------------------------------------------------

export interface DeviceProfile {
  fullName: string;
  email: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Collapses whitespace and strips control characters and angle brackets. */
export function cleanFullName(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
}

export function validateFullName(input: unknown): Validated<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Enter your full name.' };
  const name = cleanFullName(input);
  if (name.length < 2) return { ok: false, error: 'Enter your full name.' };
  if (name.length > 100) return { ok: false, error: 'Names can be up to 100 characters.' };
  if (!/\p{L}/u.test(name)) return { ok: false, error: 'Enter your full name using letters.' };
  return { ok: true, value: name };
}

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function validateEmail(input: unknown): Validated<string> {
  if (typeof input !== 'string') return { ok: false, error: 'Enter your email address.' };
  const email = input.trim().toLowerCase();
  if (email.length === 0) return { ok: false, error: 'Enter your email address.' };
  if (email.length > 254 || email.includes('..') || !EMAIL_PATTERN.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  return { ok: true, value: email };
}

/** Both fields are required the first time a device uses a code. */
export function validateProfile(fullName: unknown, email: unknown): Validated<DeviceProfile> {
  const name = validateFullName(fullName);
  if (!name.ok) return name;
  const mail = validateEmail(email);
  if (!mail.ok) return mail;
  return { ok: true, value: { fullName: name.value, email: mail.value } };
}

// ---- device binding decision ---------------------------------------------------------------------------

export type DeviceDecision =
  /** This device already holds a slot: just sign in. */
  | { kind: 'known' }
  /** All slots belong to other devices. Refused BEFORE any personal data is requested. */
  | { kind: 'limit_reached' }
  /** A slot is free but we need the person's name and email first. Nothing is bound yet. */
  | { kind: 'needs_profile'; error: string; asked: boolean }
  /** Claim the free slot and store the profile. */
  | { kind: 'bind'; profile: DeviceProfile };

/**
 * The single rule behind "one device per code", kept pure so it can be tested exhaustively.
 * Order matters: a refused device never gets asked for personal information.
 */
export function decideDeviceAccess(input: {
  known: boolean;
  boundCount: number;
  maxDevices: number;
  fullName: unknown;
  email: unknown;
}): DeviceDecision {
  if (input.known) return { kind: 'known' };
  if (input.boundCount >= input.maxDevices) return { kind: 'limit_reached' };
  const profile = validateProfile(input.fullName, input.email);
  if (!profile.ok) {
    const asked = input.fullName !== undefined || input.email !== undefined;
    return {
      kind: 'needs_profile',
      asked,
      error: asked ? profile.error : 'First time on this device: please enter your full name and email.',
    };
  }
  return { kind: 'bind', profile: profile.value };
}
