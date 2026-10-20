#!/usr/bin/env node
/**
 * Removes build output that the site never requests.
 *
 * onnxruntime-web references its own WebAssembly files with `new URL(..., import.meta.url)`, so the
 * bundler emits a 27 MB copy. The transcriber worker points the runtime at public/ort/ instead
 * (src/ondevice/whisper.worker.ts), so that copy is dead weight.
 */
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist', 'assets');
let removed = 0;
for (const name of await readdir(assets)) {
  if (/^ort-wasm.*\.wasm$/.test(name)) {
    await rm(join(assets, name));
    removed += 1;
    console.log(`removed unused dist/assets/${name}`);
  }
}
console.log(removed === 0 ? 'nothing to remove' : 'done');
