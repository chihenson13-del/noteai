#!/usr/bin/env node
/**
 * Builds the site for GitHub Pages (served from a sub-path such as /noteai/):
 *
 *   node scripts/build-pages.mjs --base /noteai/ --out pages-build
 *
 * On top of a normal build it
 *   - copies index.html to 404.html so deep links such as /noteai/library reach the router,
 *   - adds .nojekyll,
 *   - adds the content-security policy as a <meta> tag (Pages cannot send response headers),
 *   - drops the unused 27 MB WebAssembly copy the bundler emits.
 * Publish the resulting folder to the Pages branch. It contains build output only.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = option('base', '/noteai/');
// A relative path: the build runs through a shell, which would split an absolute path containing spaces.
const outArg = option('out', 'pages-build');
const out = resolve(root, outArg);

// Keep in sync with vercel.json. frame-ancestors / X-Frame-Options cannot be set from a meta tag.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob: https://*.supabase.co",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "font-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const build = spawnSync('npx', ['vite', 'build', '--outDir', outArg, '--emptyOutDir'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_BASE_PATH: base },
});
if (build.status !== 0) process.exit(build.status ?? 1);

for (const name of await readdir(join(out, 'assets'))) {
  if (/^ort-wasm.*\.wasm$/.test(name)) await rm(join(out, 'assets', name));
}

let html = await readFile(join(out, 'index.html'), 'utf8');
if (!html.includes('Content-Security-Policy')) {
  html = html.replace(
    '<meta charset="UTF-8" />',
    `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="strict-origin-when-cross-origin" />`,
  );
}
await writeFile(join(out, 'index.html'), html);
await writeFile(join(out, '404.html'), html);
await writeFile(join(out, '.nojekyll'), '');
await copyFile(join(out, 'index.html'), join(out, '404.html'));
console.log(`GitHub Pages build written to ${out} (base ${base})`);
