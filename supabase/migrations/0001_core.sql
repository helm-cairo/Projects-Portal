-- =====================================================================
-- Helm Portal: 0001 core (users, system access, helper functions)
-- Run once in Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Safe to run again (idempotent).
--
-- بالعربي: الملف ده بيعمل جدول الأشخاص (profiles) وجدول "مين يدخل أنهي نظام"
-- (system_access)، والدوال اللي قواعد الأمان بتستخدمها.
-- =====================================================================

-- ---------- 1) profiles: one row per account ----------
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  full_name         text not null default '',
  is_admin          boolean not null default false,   -- portal admin: manages all users and all systems
  must_set_password boolean not null default true,    -- true until the user picks their own password
  created_at        timestamptz not null default now()
);

-- ---------- 2) system_access: which system(s) each account may open ----------
create table if not exists public.system_access (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  system     text not null check (system in ('attendance', 'cases')),
  role       text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, system),
  constraint system_access_role_ck check (
       (system = 'attendance' and role = 'member')
    or (system = 'cases' and role in ('admin', 'approver', 'researcher', 'viewer'))
  )
);

-- ---------- 3) new account -> empty profile (no access to anything) ----------
-- Sign-ups are disabled in Auth settings; accounts are created only by an admin
-- (Edge Function "admin-users" or the dashboard). Access is never taken from
-- user-supplied metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, is_admin, must_set_password)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1)),
          false,
          true)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 4) helper functions used by every security rule ----------
-- A user who still has a temporary password gets NO data until they choose their own.

-- Is the current user ready (signed in, profile exists, own password chosen)?
create or replace function public.helm_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and not p.must_set_password
  )
$$;

-- Portal admin?
create or replace function public.is_portal_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_admin and not p.must_set_password
  )
$$;

-- Does the current user have access to this system ('attendance' or 'cases')?
create or replace function public.has_system_access(p_system text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.system_access a
    join public.profiles p on p.id = a.user_id
    where a.user_id = auth.uid() and a.system = p_system and not p.must_set_password
  )
$$;

-- Role inside the cases system, or NULL when the user has no cases access.
create or replace function public.cases_role()
returns text language sql stable security definer set search_path = '' as $$
  select a.role
  from public.system_access a
  join public.profiles p on p.id = a.user_id
  where a.user_id = auth.uid() and a.system = 'cases' and not p.must_set_password
$$;

-- What the signed-in user may do (used by the login pages). Works even with a
-- temporary password, so the page knows to show "choose your password".
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object(
    'id', p.id,
    'full_name', p.full_name,
    'is_admin', p.is_admin,
    'must_set_password', p.must_set_password,
    'systems', coalesce((select jsonb_object_agg(a.system, a.role)
                         from public.system_access a where a.user_id = p.id), '{}'::jsonb)
  ) end
  from (select auth.uid() as uid) me
  left join public.profiles p on p.id = me.uid
$$;

-- Names of the people in a system (for "added by" / "approved by" labels).
-- Only members of that same system can call it; returns no emails.
create or replace function public.system_members(p_system text)
returns table (id uuid, full_name text, role text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, a.role
  from public.system_access a
  join public.profiles p on p.id = a.user_id
  where a.system = p_system
    and public.has_system_access(p_system)
$$;

-- ---------- 5) Row Level Security ----------
alter table public.profiles      enable row level security;
alter table public.system_access enable row level security;

-- Read: your own row, or everything if you are a portal admin.
-- Write: nobody from the browser. Changes go through the "admin-users"
-- Edge Function, which checks permissions on the server.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_portal_admin());

drop policy if exists system_access_read on public.system_access;
create policy system_access_read on public.system_access for select to authenticated
  using (user_id = auth.uid() or public.is_portal_admin());

-- ---------- 6) Privileges: anonymous visitors get nothing ----------
revoke all on public.profiles, public.system_access from anon, public;
grant select on public.profiles, public.system_access to authenticated;

revoke all on function public.helm_ready()              from anon, public;
revoke all on function public.is_portal_admin()         from anon, public;
revoke all on function public.has_system_access(text)   from anon, public;
revoke all on function public.cases_role()              from anon, public;
revoke all on function public.my_access()               from anon, public;
revoke all on function public.system_members(text)      from anon, public;
revoke all on function public.handle_new_user()         from anon, public, authenticated;
grant execute on function public.helm_ready()            to authenticated;
grant execute on function public.is_portal_admin()       to authenticated;
grant execute on function public.has_system_access(text) to authenticated;
grant execute on function public.cases_role()            to authenticated;
grant execute on function public.my_access()             to authenticated;
grant execute on function public.system_members(text)    to authenticated;

-- ---------- 7) First admin (run by hand, once) ----------
-- 1. Dashboard -> Authentication -> Users -> Add user -> Create new user
--    (type the admin email + a temporary password, tick "Auto Confirm User").
-- 2. In the SQL Editor run:   select public.helm_bootstrap_admin('the-admin-email');
-- The admin is then asked to choose their own password at first sign-in.
-- Only the SQL Editor (database owner) can run this; the website cannot.
create or replace function public.helm_bootstrap_admin(p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then
    return 'No account with that email. Create it first in Authentication -> Users.';
  end if;
  insert into public.profiles (id, full_name, is_admin, must_set_password)
  values (uid, split_part(p_email, '@', 1), true, true)
  on conflict (id) do update set is_admin = true;
  insert into public.system_access (user_id, system, role) values (uid, 'cases', 'admin')
  on conflict (user_id, system) do update set role = 'admin';
  insert into public.system_access (user_id, system, role) values (uid, 'attendance', 'member')
  on conflict (user_id, system) do nothing;
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"must_set_password": true}'::jsonb
   where id = uid and last_sign_in_at is null;
  return 'Done: this account is now portal admin with access to both systems.';
end $$;
revoke all on function public.helm_bootstrap_admin(text) from anon, public, authenticated;
