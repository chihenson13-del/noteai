-- Premium features: moments, pins & collections, chaptered notes with evidence,
-- the data-transfer log (Trust center) and expiring read-only share links.

-- ---------------------------------------------------------------------------
-- recordings: user-dropped moments, pinning, collection name
-- ---------------------------------------------------------------------------
alter table public.recordings
  add column moments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(moments) = 'array' and jsonb_array_length(moments) <= 500),
  add column pinned boolean not null default false,
  add column collection text
    check (collection is null or char_length(collection) between 1 and 40);

create index recordings_user_collection_idx on public.recordings (user_id, collection) where collection is not null;

-- ---------------------------------------------------------------------------
-- notes: chapters (each point may carry a verified evidence timestamp)
-- ---------------------------------------------------------------------------
alter table public.summaries
  add column chapters jsonb not null default '[]'::jsonb
    check (jsonb_typeof(chapters) = 'array' and jsonb_array_length(chapters) <= 40);

-- Owners may edit chapters like the other note content (column grants were restricted in init).
grant update (chapters) on public.summaries to authenticated;

alter table public.action_items
  add column evidence_ms integer check (evidence_ms is null or evidence_ms >= 0);

-- ---------------------------------------------------------------------------
-- data_transfers: what was sent to which third party (shown in the Trust center)
-- Written by Edge Functions (service role). Clients may only log their own audio uploads.
-- ---------------------------------------------------------------------------
create table public.data_transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid references public.recordings (id) on delete set null,
  kind text not null check (kind in ('audio_upload', 'transcription', 'notes', 'ask')),
  provider text,
  created_at timestamptz not null default now()
);

create index data_transfers_user_idx on public.data_transfers (user_id, created_at desc);

alter table public.data_transfers enable row level security;

create policy "data_transfers: read own" on public.data_transfers for select to authenticated
  using (user_id = auth.uid());

create policy "data_transfers: log own upload" on public.data_transfers for insert to authenticated
  with check (user_id = auth.uid() and kind = 'audio_upload');

-- ---------------------------------------------------------------------------
-- shared_notes: expiring, revocable, read-only snapshots of notes.
-- Only the SHA-256 of the token is stored. Created/read/revoked through Edge Functions.
-- ---------------------------------------------------------------------------
create table public.shared_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recording_id uuid not null references public.recordings (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index shared_notes_recording_idx on public.shared_notes (user_id, recording_id, created_at desc);

alter table public.shared_notes enable row level security;

-- Owners can see that links exist; creation, revocation and public reads go through the service role.
create policy "shared_notes: read own" on public.shared_notes for select to authenticated
  using (user_id = auth.uid());

-- The snapshot itself is not needed by the app UI.
revoke select on public.shared_notes from authenticated;
grant select (id, user_id, recording_id, created_at, expires_at, revoked_at) on public.shared_notes to authenticated;
