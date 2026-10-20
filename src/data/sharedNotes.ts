import { appUrl } from '../config/base';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

export interface SharedSnapshot {
  version: 1;
  title: string;
  recordedAt: string;
  durationMs: number;
  summary: string;
  keyTakeaways: Array<{ text: string }>;
  decisions: Array<{ text: string }>;
  chapters: Array<{ title: string; startMs: number | null; points: Array<{ text: string }> }>;
  actionItems: Array<{ text: string; assignee: string | null; dueDate: string | null; done: boolean }>;
  generatedBy: { provider: string; model: string; userEdited: boolean };
}

export interface SharedNotesResult {
  snapshot: SharedSnapshot;
  expiresAt: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedShareToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function shareUrlFor(token: string, origin: string = window.location.origin): string {
  return appUrl(`/s/${token}`, origin);
}

/** Reads a public share link. No authentication: the unguessable token is the credential. */
export async function fetchSharedNotes(token: string, fetchImpl: typeof fetch = fetch): Promise<SharedNotesResult> {
  if (!env.backendConfigured) {
    throw new AppError('BACKEND_NOT_CONFIGURED', 'Shared notes are not available on this deployment.');
  }
  if (!isWellFormedShareToken(token)) {
    throw new AppError('UNKNOWN', 'This link is invalid or has expired.');
  }
  let response: Response;
  try {
    response = await fetchImpl(`${env.supabaseUrl}/functions/v1/shared-notes?t=${encodeURIComponent(token)}`, {
      headers: { apikey: env.supabaseAnonKey },
    });
  } catch (error) {
    throw new AppError('NETWORK', 'Could not reach the server. Check your connection and try again.', { cause: error, retryable: true });
  }
  if (response.status === 404) throw new AppError('UNKNOWN', 'This link is invalid or has expired.');
  if (!response.ok) throw new AppError('PROCESSING_FAILED', 'This page could not be loaded right now. Please try again.', { retryable: true });
  const data = (await response.json()) as Partial<SharedNotesResult>;
  if (!data.snapshot || typeof data.expiresAt !== 'string') {
    throw new AppError('PROCESSING_FAILED', 'This link returned unexpected data.');
  }
  return { snapshot: data.snapshot, expiresAt: data.expiresAt };
}
