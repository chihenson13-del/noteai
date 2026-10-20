#!/usr/bin/env node
/**
 * Downloads the files the on-device transcriber needs and puts them under public/ so the site
 * serves everything itself (no CDN, no third-party request at runtime):
 *
 *   public/ort/ort-wasm-simd-threaded.{mjs,wasm}   ONNX Runtime WebAssembly build (copied from node_modules)
 *   public/models/<name>/...                        Whisper weights (MIT licence, OpenAI) in ONNX form
 *
 * Run once after `npm install` and before `npm run build`:  npm run models:fetch
 * Existing files with the right size are kept, so it is cheap to run again.
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HF = 'https://huggingface.co';

/** Keep in sync with src/ondevice/config.ts. */
const MODELS = [
  { name: 'whisper-tiny', repo: 'onnx-community/whisper-tiny' },
  { name: 'whisper-base', repo: 'onnx-community/whisper-base' },
];

const SMALL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'vocab.json',
  'merges.txt',
  'normalizer.json',
];
// 8-bit weights: about a quarter of the float32 size and what runs well on a phone.
const ONNX_FILES = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

async function exists(path, size) {
  try {
    const info = await stat(path);
    return size === undefined ? info.size > 0 : info.size === size;
  } catch {
    return false;
  }
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes.length;
}

async function main() {
  const ortSource = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  const ortTarget = join(root, 'public', 'ort');
  await mkdir(ortTarget, { recursive: true });
  for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    await copyFile(join(ortSource, file), join(ortTarget, file));
    console.log(`copied  ort/${file}`);
  }

  for (const model of MODELS) {
    for (const file of [...SMALL_FILES, ...ONNX_FILES]) {
      const target = join(root, 'public', 'models', model.name, file);
      if (await exists(target)) {
        console.log(`kept    ${model.name}/${file}`);
        continue;
      }
      try {
        const size = await download(`${HF}/${model.repo}/resolve/main/${file}`, target);
        console.log(`fetched ${model.name}/${file} (${(size / 1048576).toFixed(1)} MB)`);
      } catch (error) {
        // added_tokens.json / normalizer.json do not exist for every repo; the weights and tokenizer must.
        if (SMALL_FILES.includes(file) && !['tokenizer.json', 'config.json', 'preprocessor_config.json'].includes(file)) {
          console.warn(`skipped ${model.name}/${file}: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
  }
  console.log('done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
