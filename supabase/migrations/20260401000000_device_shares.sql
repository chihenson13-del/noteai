-- Share links for notes that were made ON THE DEVICE (on-device transcription). Those recordings never have a row in
-- public.recordings, so a link can point at the id the browser generated instead of a cloud recording.

alter table public.shared_notes alter column recording_id drop not null;
alter table public.shared_notes add column local_recording_id uuid;
alter table public.shared_notes add constraint shared_notes_has_target check (recording_id is not null or local_recording_id is not null);

create index shared_notes_local_recording_idx on public.shared_notes (user_id, local_recording_id, created_at desc)
  where local_recording_id is not null;

grant select (local_recording_id) on public.shared_notes to authenticated;
