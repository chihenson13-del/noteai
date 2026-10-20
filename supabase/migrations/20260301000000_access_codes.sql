-- Access codes: sign in without creating an account.
--
-- Plain codes are NEVER stored: only a SHA-256 hash. The tables are readable/writable by the
-- service role (Edge Function `redeem-code` and your admin SQL) only — row level security is
-- enabled with no policies, and every privilege is revoked from the API roles.

create table public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  -- free text for you: who the code was given to, e.g. "Code 017 - Alex"
  label text check (label is null or char_length(label) <= 120),
  -- the auth user created on first use (null until then, or after the account was deleted)
  user_id uuid references auth.users (id) on delete set null,
  -- how many distinct devices may use this code (1 = one device per code)
  max_devices integer not null default 1 check (max_devices between 1 and 20),
  -- who first activated the code (collected at the first login of its first device)
  owner_name text check (owner_name is null or char_length(owner_name) <= 100),
  owner_email text check (owner_email is null or char_length(owner_email) <= 254),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table public.access_code_devices (
  code_id uuid not null references public.access_codes (id) on delete cascade,
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  label text check (label is null or char_length(label) <= 80),
  -- collected once, at this device's first login
  full_name text check (full_name is null or char_length(full_name) <= 100),
  contact_email text check (contact_email is null or char_length(contact_email) <= 254),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (code_id, device_hash)
);

-- The device limit is enforced HERE, atomically, not just in the Edge Function: two different
-- devices submitting the same code at the same instant cannot both claim the last slot.
-- Locking the code's row serialises concurrent claims for that code.
create or replace function public.enforce_access_code_device_limit()
returns trigger
language plpgsql
as $$
declare
  allowed integer;
  used integer;
begin
  select max_devices into allowed from public.access_codes where id = new.code_id for update;
  if allowed is null then
    raise exception 'unknown access code';
  end if;
  select count(*) into used from public.access_code_devices where code_id = new.code_id;
  if used >= allowed then
    raise exception 'device limit reached for this access code' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger access_code_devices_limit
  before insert on public.access_code_devices
  for each row execute function public.enforce_access_code_device_limit();

-- Failed/successful attempts per (hashed) client address, for rate limiting.
create table public.code_login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  success boolean not null,
  created_at timestamptz not null default now()
);

create index code_login_attempts_ip_idx on public.code_login_attempts (ip_hash, created_at desc);

alter table public.access_codes enable row level security;
alter table public.access_code_devices enable row level security;
alter table public.code_login_attempts enable row level security;

revoke all on public.access_codes from anon, authenticated;
revoke all on public.access_code_devices from anon, authenticated;
revoke all on public.code_login_attempts from anon, authenticated;
