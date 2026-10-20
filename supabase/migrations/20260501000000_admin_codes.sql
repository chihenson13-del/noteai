-- Admin codes: an access code can be flagged as an admin code. Signing in with it works like any other code, and the
-- `admin-codes` Edge Function (service role) then lets that user list codes, revoke / restore them, free a device
-- and create new codes. The flag is only ever read by the server: the API roles have no privilege on this table.

alter table public.access_codes add column is_admin boolean not null default false;

create index access_codes_admin_idx on public.access_codes (user_id) where is_admin;
