# Architecture

NoteAI is a single-page web app. There is no native code and nothing to install.

> **Limitation by design:** a browser-only app cannot guarantee recording while the screen is off, the
> browser is in the background, or the OS suspends the browser or takes the microphone. Everything below
> is detection, mitigation and recovery — not a guarantee.

## Recording

`BrowserRecorder` (`src/recording/recorder.ts`) owns `getUserMedia` + `MediaRecorder`. It is a plain class
(not a React component), created once in `src/app/container.ts`, so navigating between screens never
interrupts a recording.

State is derived by a pure reducer (`src/domain/recordingMachine.ts`):

```
idle ─START_REQUESTED→ requesting ─STARTED→ recording ⇄ paused
                         │                    │  ▲
                   START_FAILED               ▼  │ RECOVERED
                         ▼                interrupted   (muted mic / no data for 4 s)
                       error ◀── FAILED ── (any live phase)   (track ended / recorder stopped / error)
recording|paused|interrupted ─STOP_REQUESTED→ stopping ─STOPPED→ idle
```

Rules that keep the UI truthful:

1. `recording` is entered only via `STARTED` / `RECOVERED`, which the recorder emits after checking that the
   `MediaRecorder` is `recording`, the track is `live` and not `muted`.
2. A 1 s watchdog flips to `interrupted` if no data arrives for 4 s. The gap is *not* counted as recorded time
   (the interruption is settled at the last time data was seen).
3. If the track ends or the recorder stops without being asked, the session fails: the chunks captured so
   far are assembled and saved as a normal library entry flagged *interrupted*, and the screen says
   "Stopped".
4. Every `dataavailable` chunk (1 s) is written to IndexedDB with the elapsed time. Reloads/crashes leave
   a session record with chunks; the next page load recovers it (`recoverOrphanedSessions`).
   Liveness is decided by a Web Lock held by the recording tab (immediate), with a heartbeat fallback.
5. Save order is *audio blob → library entry → delete chunks*, so a failure at any step cannot lose audio.

Helpers: Screen Wake Lock (best effort), Web Audio analyser for the level meter (never required for
recording), `beforeunload` guard and live tab title while a session is open.

## Capture health & moments

`summarizeCaptureHealth` (`src/domain/captureHealth.ts`) turns *measured* signals into one status: recorder phase,
track mute state, the time the newest chunk was **confirmed written** to IndexedDB (`lastSavedAt`), storage estimate and
the real wake-lock state. It reports "All good" only while capturing with a recent confirmed write.

Moments (`recorder.addMoment`) are timestamped on the same clock as the recording (paused time excluded), mirrored into the
crash-recovery session record, handed over with the finished audio, and drawn as markers on the player.

## Evidence-linked notes

The server prompt shows the model the transcript as `[123s] text` lines and asks it to cite the marker that supports each
takeaway, decision, task and chapter. `normalizeNotes` then **verifies** every claimed time with `snapEvidence`: it must fall
inside (or within 15 s of) a real segment and inside the recording, and is snapped to that segment's start. Anything else
becomes `null` and the UI simply shows no chip. Chapters are ordered by verified time. Without segment timestamps no evidence is
produced at all.

## Ask

`ask-recordings` loads the caller's most recent completed recordings (RLS-equivalent `user_id` filter), builds passages from
transcript segments (two-segment windows) or sentence chunks, scores them by distinct question-term overlap and passes the top
10 to the model with ids `S1…`. Rules enforced in code: no matching passage ⇒ **no model call**; the model must return
`found` plus citation ids; unknown ids are dropped; an answer with no valid citation is "not found"; quotes shown to the user
come from our stored text, not from the model.

## Share links

`share-notes` (authenticated) snapshots title/summary/takeaways/decisions/chapters/tasks into `shared_notes` with a 256-bit
random token whose SHA-256 is stored. `shared-notes` (public GET) hashes the presented token and returns the snapshot only
if it exists, is not revoked and has not expired — otherwise one generic 404. Audio, transcript, storage paths and user ids are
never part of the snapshot (see `_shared/share.ts` and its tests).

## Local data (IndexedDB, `src/data`)

`recordings`, `audio` (blobs), `transcripts`, `notes`, `actionItems`, `settings`, `sessions` + `chunks`
(in-progress recordings). The library UI reads from here, so it works offline and without a backend.

## On-device transcription (`src/ondevice`, `src/services/onDeviceProcessing.ts`)

The default way to get a transcript needs no account, server or API key.

```
Recording blob (IndexedDB) ──▶ decodeToMono16k (Web Audio) ──▶ planWindows (≤30 s, cut at the quietest 100 ms)
      ──▶ whisper.worker.ts (module Web Worker) ──▶ @huggingface/transformers + ONNX Runtime WASM, Whisper tiny/base (int8)
      ──▶ segments with timestamps ──▶ cleanSegments ──▶ Transcript (provider "on-device")
      ──▶ buildExtractiveNotes ──▶ Notes + action items (provider "on-device", model "extractive")
```

- **Everything is served by the site itself.** `scripts/fetch-ondevice-assets.mjs` puts the model files under
  `public/models/<name>/` and the ONNX Runtime WebAssembly build under `public/ort/`; the worker sets the library's
  "remote host" to the site origin (its existence probe only works for remote hosts), disables local-file lookup and
  the blob-URL wasm cache, and points `wasmPaths` at `/ort/`. CSP therefore needs only `'self'` plus
  `'wasm-unsafe-eval'` and `worker-src 'self'`.
- **Cancelling terminates the worker** (the only way to stop a running ONNX session); the recording returns to
  "on this device" with no error. A tab closed mid-job leaves a transient status, which `recoverInterrupted` turns
  into a retryable failure on the next load.
- **Honesty rules:** silent audio (peak below 0.004, or a window below 0.0015 RMS) is not fed to the model; empty
  results fail with "no speech recognised" rather than producing text; notes are selected sentences, never generated.
- The cloud pipeline (`pipeline.ts`) is unchanged and optional; the recording screen offers it as a second button when a
  backend is configured.

## Cloud pipeline (`src/services/pipeline.ts`)

`local → uploading → uploaded → transcribing → summarizing → completed`, or `failed` with
`failedStage ∈ {upload, transcribe, summarize}`.

- Preconditions: backend configured, signed in, upload consent given.
- Upload: row insert-if-absent (client UUID), storage object at `<user>/<recording>.<ext>` with
  `upsert:false` (policies have no UPDATE, so objects are immutable), 3 attempts with backoff.
- Processing: `process-recording` returns 202; the client polls `recordings.status` until a terminal state.
- Retry resumes from the failed stage and never re-uploads when the object exists.
- One run per recording in a tab (in-flight map) and one *running* job per recording server-side
  (partial unique index on `processing_jobs`).
- `resume()` repairs recordings left in a transient status by a closed tab.

## Server (`supabase/`)

| Piece | Purpose |
|---|---|
| `migrations/…_init.sql` | tables, constraints, RLS, guard trigger (clients may only drive the upload part of `status`) |
| `migrations/…_storage.sql` | private bucket, per-user folder policies, no UPDATE policy |
| `functions/process-recording` | auth → ownership check → dedupe job → background transcribe + summarize → persist |
| `functions/delete-account` | remove audio objects, then the auth user (cascades all rows) |
| `functions/_shared` | pure modules (request validation, transcript parsing, prompt, output normalization, provider adapters) tested under Node |

Model output is untrusted: `normalizeNotes` bounds sizes, validates dates, drops malformed items and
enforces the user's "extract action items / decisions" preferences even if the model ignored them. The
transcript is passed to the model as delimited, explicitly untrusted data.

## Security notes

- Browser bundle contains only the Supabase URL and anon key (public by design; RLS enforces access).
- Provider API keys exist only as Edge Function secrets.
- Edge Functions use the service role, so they re-check `user_id` ownership and storage path ownership.
- Provider errors are mapped to short messages; raw provider bodies are never returned to the client.
- Static-host headers (`vercel.json`): CSP, `Permissions-Policy: microphone=(self)`, `X-Frame-Options`.
