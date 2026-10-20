-- Private bucket for original audio. Objects live at "<user id>/<recording id>.<ext>".
-- The bucket is NOT public: audio is only reachable through short-lived signed URLs or
-- authenticated downloads that pass the policies below.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recordings',
  'recordings',
  false,
  26214400, -- 25 MB, the transcription provider's upload limit
  array['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/aac', 'video/webm']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- A user can only touch objects inside their own folder.
create policy "recordings audio: read own"
  on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "recordings audio: upload own"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "recordings audio: delete own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

-- Deliberately NO update policy: objects are immutable once uploaded, so an existing
-- recording can never be silently overwritten (uploads use upsert: false).
