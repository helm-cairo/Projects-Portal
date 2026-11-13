-- =====================================================================
-- Helm Portal: 0002 cases system (سجل الحالات)
-- Run after 0001_core.sql. Safe to run again.
--
-- Roles (system_access.role where system = 'cases'):
--   admin      مسؤول    everything, incl. delete and settings
--   approver   معتمد    all cases: edit + decide eligibility (status)
--   researcher باحثة    only HER OWN cases: register, edit (until a decision), record deliveries
--   viewer     عرض فقط  read cases, never the full national ID or ID card images
--
-- Each record is stored as JSON in "data" (same shape the app already uses).
-- Sensitive fields (national ID, ID-card file ids) are moved by a trigger into
-- cases_private, which viewers can never read.
-- =====================================================================

-- ---------- shared trigger: who/when updated ----------
create or replace function public.helm_touch_row()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

-- ---------- tables ----------
create table if not exists public.cases_cases (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_by  uuid default auth.uid(),
  nid_last4   text,                                                   -- for the masked display: ••••1234
  area        text generated always as (nullif(data->>'area', '')) stored,
  org         text generated always as (nullif(data->>'org', '')) stored,
  seq         integer generated always as ((nullif(data->>'seq', ''))::integer) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create index if not exists cases_cases_created_by_idx on public.cases_cases (created_by);
create index if not exists cases_cases_area_idx on public.cases_cases (area);

-- Sensitive data, one row per case. No browser can write it directly.
create table if not exists public.cases_private (
  case_id           text primary key,
  national_id       text,
  id_front_file_id  text,     -- Google Drive file id (image stays in the private Drive folder)
  id_back_file_id   text,
  updated_at        timestamptz not null default now()
);
create unique index if not exists cases_private_nid_key on public.cases_private (national_id) where national_id is not null;
create index if not exists cases_private_front_idx on public.cases_private (id_front_file_id);
create index if not exists cases_private_back_idx on public.cases_private (id_back_file_id);

-- Eligibility decision per case (id = case id). Only approver/admin write it.
create table if not exists public.cases_status (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  category    text generated always as (data->>'category') stored,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

create table if not exists public.cases_deliveries (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  case_id     text generated always as (data->>'caseId') stored,
  activity_id text generated always as (data->>'activityId') stored,
  period      text generated always as (data->>'period') stored,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create index if not exists cases_deliveries_case_idx on public.cases_deliveries (case_id);
create index if not exists cases_deliveries_period_idx on public.cases_deliveries (period);

create table if not exists public.cases_donors (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

create table if not exists public.cases_settings (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- ---------- touch triggers ----------
drop trigger if exists cases_cases_touch on public.cases_cases;
create trigger cases_cases_touch before update on public.cases_cases for each row execute function public.helm_touch_row();
drop trigger if exists cases_status_touch on public.cases_status;
create trigger cases_status_touch before update on public.cases_status for each row execute function public.helm_touch_row();
drop trigger if exists cases_deliveries_touch on public.cases_deliveries;
create trigger cases_deliveries_touch before update on public.cases_deliveries for each row execute function public.helm_touch_row();
drop trigger if exists cases_donors_touch on public.cases_donors;
create trigger cases_donors_touch before update on public.cases_donors for each row execute function public.helm_touch_row();
drop trigger if exists cases_settings_touch on public.cases_settings;
create trigger cases_settings_touch before update on public.cases_settings for each row execute function public.helm_touch_row();

-- ---------- guard: rules the browser cannot bypass ----------
--  * viewers and people without cases access cannot write
--  * "createdBy" is always the real author and can never be changed
--  * eligibility fields live only in cases_status
--  * a researcher cannot edit a case after a decision was made
--  * national ID + ID-card file ids are moved out of "data" into cases_private
create or replace function public.cases_guard_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r          text;
  has_nid    boolean := new.data ? 'nationalId';
  has_front  boolean := new.data ? 'idFrontFileId';
  has_back   boolean := new.data ? 'idBackFileId';
  v_nid      text    := nullif(regexp_replace(coalesce(new.data->>'nationalId', ''), '\s', '', 'g'), '');
  v_front    text    := nullif(new.data->>'idFrontFileId', '');
  v_back     text    := nullif(new.data->>'idBackFileId', '');
begin
  if auth.uid() is not null then          -- requests from the website (SQL Editor has no auth.uid())
    r := public.cases_role();
    if r is null or r = 'viewer' then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and r = 'researcher' and exists (
         select 1 from public.cases_status st
         where st.id = new.id and coalesce(st.data->>'category', 'pending') <> 'pending') then
      raise exception 'case is locked after a decision' using errcode = '42501';
    end if;
  end if;

  -- eligibility is stored only in cases_status
  new.data := new.data - 'category' - 'statusHistory' - 'statusBy' - 'statusAt' - 'statusCode';
  -- sensitive fields never stay in "data"
  new.data := new.data - 'nationalId' - 'idFrontFileId' - 'idBackFileId';

  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
    new.nid_last4  := old.nid_last4;
  end if;
  new.data := jsonb_set(new.data, '{createdBy}', coalesce(to_jsonb(new.created_by::text), 'null'::jsonb));

  if has_nid then
    if v_nid is not null and v_nid !~ '^[0-9]{14}$' then
      raise exception 'national id must be 14 digits' using errcode = '22023';
    end if;
    new.nid_last4 := right(v_nid, 4);
  end if;

  if has_nid or has_front or has_back then
    insert into public.cases_private as p (case_id, national_id, id_front_file_id, id_back_file_id, updated_at)
    values (new.id, v_nid, v_front, v_back, now())
    on conflict (case_id) do update set
      national_id      = case when has_nid   then excluded.national_id      else p.national_id end,
      id_front_file_id = case when has_front then excluded.id_front_file_id else p.id_front_file_id end,
      id_back_file_id  = case when has_back  then excluded.id_back_file_id  else p.id_back_file_id end,
      updated_at       = now();
  end if;
  return new;
end $$;

drop trigger if exists cases_cases_guard on public.cases_cases;
create trigger cases_cases_guard before insert or update on public.cases_cases
  for each row execute function public.cases_guard_write();

-- Deleting a case also deletes its private row, status and deliveries.
create or replace function public.cases_after_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.cases_private    where case_id = old.id;
  delete from public.cases_status     where id = old.id;
  delete from public.cases_deliveries where case_id = old.id;
  return old;
end $$;
drop trigger if exists cases_cases_after_delete on public.cases_cases;
create trigger cases_cases_after_delete after delete on public.cases_cases
  for each row execute function public.cases_after_delete();

-- Can the current user see this case? (researcher: own only)
create or replace function public.cases_can_see(p_case_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case public.cases_role()
    when 'admin' then true when 'approver' then true when 'viewer' then true
    when 'researcher' then exists (select 1 from public.cases_cases c where c.id = p_case_id and c.created_by = auth.uid())
    else false end
$$;

-- Is this national ID already used by another case? Lets a researcher check for
-- duplicates without seeing other people's cases.
create or replace function public.cases_nid_taken(p_nid text, p_id text default '')
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.cases_role() in ('admin', 'approver', 'researcher'), false)
     and exists (select 1 from public.cases_private where national_id = p_nid and case_id <> coalesce(p_id, ''))
$$;

-- ---------- Row Level Security ----------
alter table public.cases_cases      enable row level security;
alter table public.cases_private    enable row level security;
alter table public.cases_status     enable row level security;
alter table public.cases_deliveries enable row level security;
alter table public.cases_donors     enable row level security;
alter table public.cases_settings   enable row level security;

-- cases
drop policy if exists cases_cases_read on public.cases_cases;
create policy cases_cases_read on public.cases_cases for select to authenticated
  using (public.cases_role() in ('admin', 'approver', 'viewer')
         or (public.cases_role() = 'researcher' and created_by = auth.uid()));
drop policy if exists cases_cases_insert on public.cases_cases;
create policy cases_cases_insert on public.cases_cases for insert to authenticated
  with check (public.cases_role() in ('admin', 'approver', 'researcher'));
drop policy if exists cases_cases_update on public.cases_cases;
create policy cases_cases_update on public.cases_cases for update to authenticated
  using (public.cases_role() in ('admin', 'approver')
         or (public.cases_role() = 'researcher' and created_by = auth.uid()))
  with check (public.cases_role() in ('admin', 'approver')
         or (public.cases_role() = 'researcher' and created_by = auth.uid()));
drop policy if exists cases_cases_delete on public.cases_cases;
create policy cases_cases_delete on public.cases_cases for delete to authenticated
  using (public.cases_role() = 'admin');

-- private (read only; written by the guard trigger)
drop policy if exists cases_private_read on public.cases_private;
create policy cases_private_read on public.cases_private for select to authenticated
  using (public.cases_role() in ('admin', 'approver')
         or (public.cases_role() = 'researcher'
             and exists (select 1 from public.cases_cases c where c.id = case_id and c.created_by = auth.uid())));

-- status
drop policy if exists cases_status_read on public.cases_status;
create policy cases_status_read on public.cases_status for select to authenticated
  using (public.cases_can_see(id));
drop policy if exists cases_status_write on public.cases_status;
create policy cases_status_write on public.cases_status for all to authenticated
  using (public.cases_role() in ('admin', 'approver'))
  with check (public.cases_role() in ('admin', 'approver'));

-- deliveries
drop policy if exists cases_deliveries_read on public.cases_deliveries;
create policy cases_deliveries_read on public.cases_deliveries for select to authenticated
  using (public.cases_can_see(case_id));
drop policy if exists cases_deliveries_write on public.cases_deliveries;
create policy cases_deliveries_write on public.cases_deliveries for all to authenticated
  using (public.cases_role() in ('admin', 'approver')
         or (public.cases_role() = 'researcher' and public.cases_can_see(case_id)))
  with check (public.cases_role() in ('admin', 'approver')
         or (public.cases_role() = 'researcher' and public.cases_can_see(case_id)));

-- donors
drop policy if exists cases_donors_read on public.cases_donors;
create policy cases_donors_read on public.cases_donors for select to authenticated
  using (public.cases_role() is not null);
drop policy if exists cases_donors_write on public.cases_donors;
create policy cases_donors_write on public.cases_donors for all to authenticated
  using (public.cases_role() in ('admin', 'approver'))
  with check (public.cases_role() in ('admin', 'approver'));

-- settings (areas, activities)
drop policy if exists cases_settings_read on public.cases_settings;
create policy cases_settings_read on public.cases_settings for select to authenticated
  using (public.cases_role() is not null);
drop policy if exists cases_settings_write on public.cases_settings;
create policy cases_settings_write on public.cases_settings for all to authenticated
  using (public.cases_role() = 'admin')
  with check (public.cases_role() = 'admin');

-- ---------- privileges ----------
revoke all on public.cases_cases, public.cases_private, public.cases_status,
              public.cases_deliveries, public.cases_donors, public.cases_settings
  from anon, public;
grant select, insert, update, delete on public.cases_cases, public.cases_status,
              public.cases_deliveries, public.cases_donors, public.cases_settings
  to authenticated;
grant select on public.cases_private to authenticated;

revoke all on function public.cases_guard_write()          from anon, public, authenticated;
revoke all on function public.cases_after_delete()         from anon, public, authenticated;
revoke all on function public.cases_can_see(text)          from anon, public;
revoke all on function public.cases_nid_taken(text, text)  from anon, public;
grant execute on function public.cases_can_see(text)         to authenticated;
grant execute on function public.cases_nid_taken(text, text) to authenticated;
