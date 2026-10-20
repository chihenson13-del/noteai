# NoteAI

An AI note taker that runs **entirely in the browser** — no app install. Record meetings, classes,
interviews and voice notes, keep the original audio, then get a transcript, summary, key takeaways,
decisions and action items — **transcribed on your own device**, with no account, server or API key.

- **Frontend:** React 19 + TypeScript (strict) + Vite, `MediaRecorder` / `getUserMedia`, IndexedDB.
- **Transcription (default, on the device):** OpenAI Whisper (MIT licence) running in a Web Worker through
  `@huggingface/transformers` + ONNX Runtime WebAssembly. The model files and the runtime are served from the
  site itself; audio never leaves the browser.
- **Backend (optional):** Supabase — Auth, Postgres (RLS), private Storage, Edge Functions.
- **Cloud AI (optional, server-side only):** OpenAI speech-to-text; Anthropic *or* OpenAI for notes. API keys
  live in Edge Function secrets and never reach the browser.

## What you get

| Area | Features |
|---|---|
| **Transcribe** | **On this device**: Whisper *Fast* (tiny, ~44 MB) or *More accurate* (base, ~80 MB) with timestamps, live progress and Cancel; **Import audio** for existing voice memos; works offline once the model is stored |
| **Capture** | Browser recording with pause/resume, live level meter, a **capture-health** card (mic state, last chunk *confirmed saved*, free space, screen wake lock), one-tap **Moments** (key point / action / question / note) |
| **Library** | Search titles *and* transcripts, sort, status filter, **pins**, **collections**, and a **Needs attention** queue (failed uploads, interrupted captures) |
| **Notes** | Summary, **chapters**, takeaways, decisions and tasks where each statement links to the **audio second** it came from; fully editable; copy, Markdown, **PDF** (print dialog), **Word (.doc)** |
| **Ask** | Without an account: finds the passages of your transcripts that match your words, with the time they were said (no AI, nothing sent anywhere). With an account: AI answers that cite passages and say *"I couldn't find that"* when evidence is missing |
| **Sharing** | Expiring (1/7/30 days), revocable, read-only **links to a notes snapshot** (never audio or transcript); works for notes made on the device |
| **Trust center** | Where recordings live, consent switches, a log of what was sent to which provider, retention, one-click deletion |
| **Sign-in** | **Access codes** (no sign-up, one device per code, name + email collected on a device's first login) or email + password |

Not included: an installable/offline **PWA** (deferred on purpose). The app is a normal website.

## Screen-off / background recording is NOT guaranteed

NoteAI is a **browser-only web app**. A web page cannot promise to keep recording when:

- a phone or tablet is locked or its screen is off,
- the browser or tab goes to the background (switching apps, opening another tab),
- the operating system suspends or kills the browser to save battery or memory,
- another app or a phone call takes the microphone.

Mobile browsers (especially iOS Safari) routinely do these things, and there is no web API that
overrides them. **Do not rely on NoteAI for a mobile recording you cannot afford to lose with the
screen off.** Keep the screen on and the NoteAI tab in front; on a desktop browser that stays open
it is much more dependable.

What NoteAI does about it (mitigation, not a guarantee):

- requests a Screen Wake Lock so the screen stays on while recording (not supported by every browser,
  and released whenever the page is hidden),
- writes audio to the device every second, so a reload, crash or closed tab loses at most the last
  moments and the rest is recovered on the next visit,
- never shows "Recording" unless capture is verifiably running: a muted microphone, stalled audio, ended
  microphone track or unexpected recorder stop immediately shows **Interrupted** / **Stopped** and
  saves what was captured,
- shows this warning on the Record screen and in Settings.

A guaranteed screen-off recorder needs a native iOS/Android app with OS background-audio support.
That is deliberately out of scope for this project.

---

## Current beta setup

- **Repository:** this repo (`main` = source). The GitHub Pages site is published from its `gh-pages` branch at
  <https://chihenson13-del.github.io/noteai/>. A second copy runs on its own Vercel project, `noteai-chihenson13`.
- **Access:** `VITE_REQUIRE_LOGIN=true` shows only the access-code screen until a code was used on the device; the privacy notice
  (`/privacy`) is public. Each of the 100 codes works on one device and asks for a name and email the first time.
- **Backend (Supabase):** access-code sign-in (`redeem-code`), share links for notes made on the device (`share-notes`,
  `shared-notes`) and `delete-account`. Cloud transcription / cloud Ask need `process-recording` and `ask-recordings` plus provider
  keys, and stay hidden until `VITE_CLOUD_AI=true`.
- **Edge Functions without the CLI:** `node scripts/bundle-functions.mjs` writes one self-contained file per function to `edge-bundles/`
  (paste into Supabase → Edge Functions → editor; turn "Verify JWT" off for each).
- **Publishing:** `npm run build` (Vercel, base `/`) and `npm run build:pages` (GitHub Pages, base `/noteai/`), then copy the output to
  the host. Both need the `VITE_*` values from `.env.example` in `.env.local`.

## Run it locally

Requirements: Node.js 20+ (developed on Node 24) and npm.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. `localhost` counts as a secure context, so the microphone works.

In this **local-only mode** (no environment variables) recording, import, pause/resume, playback, download,
rename/delete, **on-device transcription and notes**, the local library, search and Ask all work, and everything stays
in your browser. Sign-in, sync and cloud AI are disabled and clearly say so — there is **no mock or fake
transcript** anywhere in the app.

### On-device transcription: what it is and is not

- `npm run build` first runs `scripts/fetch-ondevice-assets.mjs`, which downloads the Whisper ONNX files
  (8-bit weights, ~125 MB for both models) into `public/models/` and copies the ONNX Runtime WebAssembly build into
  `public/ort/`. They are git-ignored and shipped with the site. Run `npm run models:fetch` to do just that step.
- The **first** transcription copies the chosen model to the browser's cache (~44 MB or ~80 MB); after that it works
  offline. *Settings → Language & transcription* can remove the stored models.
- It runs single-threaded WebAssembly, so expect roughly real-time speed or slightly faster on a recent phone with the
  Fast model, and 2–3× slower with the accurate one. Keep the page open and in front; it is stopped if the tab is closed
  and the recording then shows a **Retry** button.
- Very long recordings (over ~45 minutes) may run a phone out of memory while the browser decodes the audio; the app says so
  and surfaces the failure rather than hanging.
- **Notes are an extract, not an AI rewrite.** The summary, takeaways, decisions and action items are *selected from the
  transcript* (frequent-word ranking and phrase matching), each with the time it was said. Nothing is generated, so nothing
  can be invented, but the phrase matching only understands English. For fluent AI-written notes, use the optional cloud
  path below.
- Silence is reported as "no sound detected" instead of producing text; Whisper's habit of inventing words for silence is
  filtered (`src/ondevice/whisper.worker.ts`, `src/domain/extractiveNotes.ts#cleanSegments`).

Other commands:

```bash
npm test            # 150+ unit/UI tests (Vitest)
npm run typecheck   # strict TypeScript
npm run build       # fetch on-device assets, typecheck, production build into dist/
npm run build:pages # GitHub Pages build (base /noteai/, 404.html, CSP meta) into pages-build/
npm run preview     # serve the production build locally
```

### Try it on a phone

Browsers only allow the microphone on **HTTPS** (or localhost), so `http://<your-LAN-ip>:5173` will not
record on a phone. Either deploy (below) or open a temporary HTTPS tunnel to the dev server, e.g. with
Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:5173`).

---

## Turn on accounts, sync, transcription and AI notes

### 1. Create a Supabase project and apply the schema

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies supabase/migrations/*
```

The migrations create the tables (`profiles`, `recordings`, `transcripts`, `summaries`, `action_items`,
`processing_jobs`, `data_transfers`, `shared_notes`), Row Level Security policies, and a **private** `recordings`
storage bucket. `moments`, `pinned`, `collection`, `chapters` and evidence columns were added by the *premium* migration.

### 2. Configure auth URLs

In the Supabase dashboard → *Authentication → URL Configuration* set **Site URL** to your deployed
URL and add `http://localhost:5173` to **Redirect URLs**.

### 3. Set server secrets and deploy the functions

```bash
cp supabase/functions/.env.example supabase/functions/.env.secrets
# edit .env.secrets: OPENAI_API_KEY, ANTHROPIC_API_KEY, ALLOWED_ORIGIN, ...
npx supabase secrets set --env-file supabase/functions/.env.secrets
npx supabase functions deploy process-recording
npx supabase functions deploy redeem-code      # access-code sign-in (public)
npx supabase functions deploy ask-recordings
npx supabase functions deploy share-notes
npx supabase functions deploy shared-notes   # public, read-only share links
npx supabase functions deploy delete-account
```

`shared-notes` is intentionally public (no login): the unguessable share token is the credential, and unknown, revoked and
expired tokens return the same 404.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions automatically. Provider usage is
billed by OpenAI/Anthropic to your account. `SUMMARY_MODEL` defaults to `claude-sonnet-5-5`; set it to
any model your provider account supports (or `SUMMARY_PROVIDER=openai` with e.g. `gpt-4o-mini`).

### 4. Point the frontend at the project

```bash
cp .env.example .env.local
# VITE_SUPABASE_URL=https://<ref>.supabase.co
# VITE_SUPABASE_ANON_KEY=<anon / publishable key>      (safe to expose; protected by RLS)
# optional: VITE_PRIVACY_POLICY_URL, VITE_TERMS_URL
npm run dev
```

Create an account in the app, record something, open it and press **Transcribe & summarize**
(you will be asked for upload consent the first time).

---

## Access codes: sign in without an account

People don't create accounts. You hand out **access codes**; the app signs them in with one.

```bash
npm run codes:generate        # makes 100 codes: codes/access-codes.csv + .txt, and supabase/seed/access_codes.sql
```

1. **Load the hashes:** open `supabase/seed/access_codes.sql` and run it in the Supabase SQL editor (after
   `npx supabase db push`). It contains only SHA-256 hashes, never usable codes.
2. **Give people their codes** from `codes/access-codes.csv` (git-ignored; keep it private — it is the only place
   the plain codes exist). Re-running the generator refuses to overwrite it, so you can't accidentally invalidate
   codes you already handed out (`--force` creates a brand-new set).
3. Deploy the function: `npx supabase functions deploy redeem-code`.
4. Optional, to hide email sign-up entirely: set `VITE_AUTH_METHODS=code` and rebuild.

**How a person signs in**

| Situation | What they do |
|---|---|
| First time on a device | Enter the code → the code is checked → they are asked for **full name and email** once → signed in |
| Same device later | Enter the code only |
| A different device | Refused: "already in use on another device" (no personal data is requested) |

Rules enforced on the server (and covered by tests): codes are 16 characters / 80 bits and only hashed values are stored;
**one device per code** by default (`--devices 2` or `update access_codes set max_devices = 2 …` for more), enforced
atomically by a database trigger; 10 failed attempts per 15 minutes per address are rate limited; unknown and revoked
codes give the same answer; every code gets its own private account, so recordings and notes are separated per code.

**Run these in the Supabase SQL editor to manage codes**

```sql
-- who has activated what
select c.label, c.owner_name, c.owner_email, c.activated_at, c.last_used_at, c.revoked_at,
       (select count(*) from access_code_devices d where d.code_id = c.id) as devices, c.max_devices
from access_codes c order by c.label;

-- let "Code 017" be used on a new device (e.g. after the person got a new phone)
delete from access_code_devices where code_id = (select id from access_codes where label = 'Code 017');

-- revoke a code (also delete its user in Authentication → Users to end open sessions at once)
update access_codes set revoked_at = now() where label = 'Code 017';
```

Or from your terminal (needs the **service role** key; run it only on your own machine):
`SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run codes:report -- --csv`.

**Honest limits**

- A "device" is a **browser profile**: clearing site data, a private window, or a second browser on the same computer
  looks like a new device and will need a release (SQL above). It cannot detect the physical device.
- Whoever uses an unused code first claims it. Hand codes out privately.
- Name and email are **self-reported and not verified**; they are for your records, not for signing in.
- This is gate-keeping for a small, known group, not strong identity verification.

---

## Deploy the website

It is a static site (`npm run build` → `dist/`). Set the same `VITE_*` variables in your host's
environment settings **before** building — Vite bakes them in at build time.

### Vercel

```bash
npm i -g vercel
vercel                 # first time: link/create the project, accept the Vite defaults
vercel env add VITE_SUPABASE_URL
vercel env add VITE_SUPABASE_ANON_KEY
vercel --prod
```

[`vercel.json`](vercel.json) already provides the SPA fallback and security headers (including
`Permissions-Policy: microphone=(self)` and a Content-Security-Policy that allows `*.supabase.co`;
adjust it if you use a custom Supabase domain).

### Netlify

Build command `npm run build`, publish directory `dist`. The SPA fallback is in
[`public/_redirects`](public/_redirects). Add the `VITE_*` variables in *Site settings → Environment*.
Add a `Permissions-Policy: microphone=(self)` header if you set strict headers.

### GitHub Pages (free, no "vercel" in the address)

The app can be served from a sub-path such as `https://<user>.github.io/<repo>/`. Build with the base path set:

```bash
node scripts/build-pages.mjs --base /<repo>/ --out pages-build
```

It builds with the base path and adds what GitHub Pages needs, then publish the folder to the repository's Pages branch:

- **`404.html`** (a copy of `index.html`; GitHub serves it for deep links such as `/<repo>/library`, so the router can take
  over; the HTTP status for those URLs is 404 but the app renders normally),
- an empty **`.nojekyll`** file,
- a `<meta http-equiv="Content-Security-Policy">` tag in both pages, because Pages cannot send response headers
  (`vercel.json` shows the same policy; `frame-ancestors`/`X-Frame-Options` cannot be set from a meta tag).

The folder is ~135 MB because it carries the speech models (the largest file is ~51 MB, which GitHub accepts with a warning).

Share links, redirect URLs for email sign-in and the router all honour the base path (`src/config/base.ts`). If you use Supabase,
add the Pages URL to its auth redirect URLs. Pages is a public repository on the free plan, so publish **build output only**.

### Cloudflare Pages / any static host

Build command `npm run build`, output directory `dist`, and make unknown paths serve `/index.html`.
Serve over HTTPS (required for the microphone).

After deploying, set `ALLOWED_ORIGIN` (function secret) to your site's origin and add the site URL
to Supabase auth redirect URLs.

---

## How it works

```
 Browser ── getUserMedia ──▶ MediaRecorder (1 s chunks) ──▶ IndexedDB  (crash/reload safe)
    │                                  │ stop
    │                                  ▼
    │                           audio blob + library entry (on this device)
    │        user consents + signs in
    ▼                                  ▼
 Supabase Storage (private)  ◀── upload (idempotent, retried) ── pipeline
    │
    ▼
 Edge Function process-recording ──▶ OpenAI transcription ──▶ AI notes + evidence (Anthropic/OpenAI)
    │   (keys in secrets; one running job per recording; evidence times verified against the transcript)
    ▼
 Postgres: recordings · transcripts · summaries · action_items   ◀── client polls status
    │
    ├─ ask-recordings : keyword retrieval ──▶ AI answer with validated citations
    └─ share-notes / shared-notes : notes snapshot behind a hashed, expiring token
```

Key guarantees (all covered by tests):

| Guarantee | Where |
|---|---|
| "Recording" is shown only while capture is verifiably running; muted mic, stalled audio, ended track or an unexpected recorder stop flips the UI immediately and saves what exists | `src/domain/recordingMachine.ts`, `src/recording/recorder.ts` |
| Every second of audio is persisted; abandoned sessions are recovered after reload/crash | `src/data/localStore.ts`, `src/services/recordingService.ts`, `src/recording/sessionLock.ts` |
| The original audio is never deleted or altered by upload/transcribe/summarize failures; retries resume at the failed stage | `src/services/pipeline.ts` |
| No duplicate uploads/jobs: client-generated ids, insert-if-absent rows, immutable storage objects, in-flight de-dupe, one running job per recording (unique index) | `pipeline.ts`, `supabase/migrations` |
| Provider keys, prompts and model choices stay on the server; AI output is validated before it is stored | `supabase/functions/*`, `_shared/notes.ts` |
| Users can only read/modify their own rows and files | RLS + storage policies in `supabase/migrations` |
| Audio retention never deletes unprocessed or failed recordings | `src/services/retention.ts` |
| Evidence links can't be hallucinated: every time the model cites is snapped to a real transcript segment or dropped | `_shared/notes.ts#snapEvidence` |
| Ask never answers without a valid citation and doesn't call the AI at all when no passage matches | `_shared/ask.ts`, `ask-recordings` |
| Share links hold a notes snapshot only, store just a hash of the token, expire and can be revoked | `_shared/share.ts`, `share-notes`, `shared-notes` |
| "All good" capture health requires an actively capturing recorder *and* a recently confirmed disk write | `src/domain/captureHealth.ts` |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Limits to know about

- **Transcription size:** providers cap uploads (25 MB). At *Standard* quality (32 kbps) that is ~109 minutes;
  *Economy* ~145 min; *High* ~54 min. Larger recordings are kept and downloadable, but the server
  refuses to transcribe them with a clear message (no silent truncation).
- **WebM duration:** MediaRecorder files lack a duration header; NoteAI shows the tracked recording time
  and lets the browser compute the real length for seeking.
- **Browser support:** current Chrome, Edge, Firefox and Safari support the APIs used. Safari records
  MP4/AAC instead of WebM/Opus. Wake Lock is not available everywhere (the setting says so).
- **Storage:** audio lives in IndexedDB. Browsers may evict it under storage pressure; NoteAI requests
  persistent storage, shows usage in Settings, and offers one-click audio download.
- **Retention** runs when the app is opened while signed in (there is no server cron job).
- **Ask is keyword-based**, not semantic: it finds passages that share words with your question, so use words that were
  actually said. It searches your 40 most recent processed recordings per question.
- **Evidence needs timestamps.** With `whisper-1` (segment timestamps) every point can link to the audio. Text-only models
  (e.g. `gpt-4o-transcribe`) produce notes without evidence links, and the UI says so by omission rather than inventing times.
- **Exports:** PDF uses your browser's print dialog (choose *Save as PDF*). Word export is an HTML-based `.doc` that Word,
  LibreOffice and Google Docs open, not a native `.docx`.
- **Share links** show a snapshot taken at creation; later edits aren't reflected. There is no rate limiting on the public
  endpoint beyond token entropy (256 bits).
- **Not installable / offline:** the PWA layer was deliberately left out.

## Privacy & consent

- Audio stays on the device until the user turns on cloud processing and agrees to the upload prompt.
- A recording-consent reminder is shown before **each** recording (switchable in the Trust center) and the privacy notice stays
  on the Record screen.
- **Trust center** (`/trust`): see where recordings live, the log of what was sent to which provider, revoke upload consent,
  set audio retention, delete all cloud audio, wipe this device, delete the account (removes cloud audio, rows, share links and
  the auth user).
- Access-code sign-in stores the **full name and email** given at a device's first login with that code and device
  (tables `access_codes`, `access_code_devices`, visible to the app operator only; deleted with the code). Say so in your
  privacy policy.
- Add your own privacy policy / terms URLs with `VITE_PRIVACY_POLICY_URL` / `VITE_TERMS_URL`.
  Third-party providers (OpenAI, Anthropic) process the audio/transcript — disclose that in your policy.

## Project layout

```
src/
  domain/      pure logic: recorder state machine, capture health, library query, attention queue, exporters, migrations
  recording/   BrowserRecorder (MediaRecorder), level meter, wake lock, session lock, capability checks
  data/        IndexedDB store, CloudBackend interface, Supabase implementation
  ondevice/    Whisper worker, audio decoding / windowing, model settings (on-device transcription)
  services/    cloud pipeline, on-device processing, import, local Ask, recovery, sync, retention
  state/       Zustand stores (auth, library, settings, toasts)
  ui/          screens + components, styles in src/styles/app.css
supabase/
  migrations/  schema, RLS, private storage bucket
  functions/   process-recording, redeem-code, ask-recordings, share-notes, shared-notes, delete-account, _shared (pure, unit-tested)
scripts/       generate-codes.mjs (100 access codes + seed SQL), codes-report.mjs, fetch-ondevice-assets.mjs, build-pages.mjs
```

## Verification status

Verified in this repository: strict typecheck, production build, 210+ automated tests, **on-device transcription of a real
speech recording in a Chromium-based browser with both models** (correct words, per-sentence timestamps, notes, local Ask,
cancel, retry), and manual browser sessions (record → pause → resume → stop, capture-health and moments, playback, evidence-chip seeking, mic-loss
handling, reload recovery, Word export, legacy-data migration, responsive layout) using a synthetic microphone in a
Chromium-based browser.

**Not verified here** (needs your credentials/environment): the live Supabase project (migrations,
RLS, storage, Edge Functions on Deno), real OpenAI/Anthropic calls — including whether a given model
returns good evidence timestamps and chapters — a physical microphone, and Safari / Firefox / mobile-browser
behaviour. The pure server logic (evidence validation, Ask retrieval and citation checks, share snapshots) is
unit-tested; the Edge Function wiring around it is not. Test the cloud features before relying on them.
