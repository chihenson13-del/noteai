#!/usr/bin/env node
/**
 * Bundles each Supabase Edge Function (plus the ../_shared modules it imports) into ONE file so it can be
 * pasted into the Supabase dashboard's function editor, which cannot resolve imports outside the function.
 *
 *   node scripts/bundle-functions.mjs [outDir]      (default: edge-bundles/, git-ignored)
 *
 * `npm:` / `jsr:` / `https:` imports stay external (Deno resolves them); everything relative is inlined.
 * Uses Rolldown, which ships with Vite, so nothing extra needs to be installed.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = join(root, 'supabase', 'functions');
const outDir = resolve(root, process.argv[2] ?? 'edge-bundles');
await mkdir(outDir, { recursive: true });

const names = (await readdir(functionsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name);

for (const name of names) {
  const bundle = await rolldown({
    input: join(functionsDir, name, 'index.ts'),
    external: [/^npm:/, /^jsr:/, /^https?:/, /^node:/],
    platform: 'neutral',
    treeshake: false,
  });
  await bundle.write({ file: join(outDir, `${name}.ts`), format: 'esm', minify: false });
  await bundle.close();
  console.log(`bundled ${name}`);
}
