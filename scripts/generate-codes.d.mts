export const CODE_ALPHABET: string;
export const CODE_LENGTH: number;
export function normalizeCode(input: string): string;
export function formatCode(normalized: string): string;
export function generateCode(random?: (length: number) => Uint8Array): string;
export function generateShortCode(random?: (length: number) => Uint8Array): string;
export function hashCode(code: string): string;
export function generateBatch(options: {
  count: number;
  prefix: string;
  long?: boolean;
  random?: (length: number) => Uint8Array;
}): Array<{ number: number; label: string; code: string; hash: string }>;
export function buildSeedSql(rows: Array<{ hash: string; label: string }>, maxDevices: number): string;
