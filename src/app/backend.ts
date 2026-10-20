import { env } from '../config/env';
import type { CloudBackend } from '../data/backend';
import { createSupabaseBackend } from '../data/supabaseBackend';

/**
 * The Supabase backend, or null when no project is configured. With null the app runs in
 * local-only mode: recording, playback, download and the local library keep working, while
 * sign-in, sync, transcription and AI notes are unavailable (and say so).
 */
export const backend: CloudBackend | null = env.backendConfigured
  ? createSupabaseBackend(env.supabaseUrl, env.supabaseAnonKey)
  : null;
