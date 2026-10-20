function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const supabaseUrl = clean(import.meta.env.VITE_SUPABASE_URL);
const supabaseAnonKey = clean(import.meta.env.VITE_SUPABASE_ANON_KEY);

export type AuthMethod = 'code' | 'email';

/** `VITE_AUTH_METHODS=code,email` (default) | `code` | `email`. Unknown values are ignored. */
function readAuthMethods(): AuthMethod[] {
  const raw = clean(import.meta.env.VITE_AUTH_METHODS).toLowerCase();
  const methods = raw.split(',').map((m) => m.trim()).filter((m): m is AuthMethod => m === 'code' || m === 'email');
  return methods.length > 0 ? [...new Set(methods)] : ['code', 'email'];
}

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  /** Cloud features (sign-in, sync, transcription, AI notes) need both values. */
  backendConfigured: supabaseUrl !== '' && supabaseAnonKey !== '',
  authMethods: readAuthMethods(),
  /**
   * Cloud transcription / AI notes / cloud Ask need the `process-recording` and `ask-recordings` functions plus provider
   * keys on the server. Off unless `VITE_CLOUD_AI=true`, so the app never shows buttons that cannot work.
   */
  cloudAi: clean(import.meta.env.VITE_CLOUD_AI).toLowerCase() === 'true',
  /** Beta gate: nothing but the sign-in screen until an access code was used on this device. Needs a backend. */
  requireLogin: clean(import.meta.env.VITE_REQUIRE_LOGIN).toLowerCase() === 'true',
  privacyPolicyUrl: clean(import.meta.env.VITE_PRIVACY_POLICY_URL),
  termsUrl: clean(import.meta.env.VITE_TERMS_URL),
} as const;
