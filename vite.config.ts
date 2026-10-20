import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // "/" by default; the GitHub Pages build sets VITE_BASE_PATH=/noteai/
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  // The transcriber worker lazy-loads chunks, which needs the ES module worker format.
  worker: { format: 'es' },
  server: { port: 5173, host: true },
  // Never inline assets as data: URIs: the site's CSP (font-src 'self') would block them.
  build: { sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
  test: {
    // Tests must never depend on a developer's .env.local: they run in local-only mode.
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_CLOUD_AI: '', VITE_REQUIRE_LOGIN: '', VITE_AUTH_METHODS: '' },
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/_shared/**/*.test.ts'],
  },
});
