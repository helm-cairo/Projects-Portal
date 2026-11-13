-- =====================================================================
-- Helm Portal: 0006 attendance self sign-up (طلبات التسجيل)
-- Run after 0001-0005. Safe to run again.
--
-- How it works:
--  * A team member creates a sign-up link for a course. The link carries a
--    long random code (attendance_signup_links.id).
--  * A new student opens register/?t=CODE (no account needed) and fills the form.
--  * Her request is saved as "pending" in attendance_signups. The team accepts
--    it (student is added to the students list and the course) or rejects it.
--
-- Security:
--  * Anonymous visitors still have NO access to any table.
--  * They may only call two functions below, which check the link code,
--    validate and trim every field, and limit how many sign-ups a link accepts.
--  * Only attendance members can see links and requests (RLS).
-- =====================================================================

-- ---------- tables (same JSON style as the other attendance tables) ----------
do $$
declare t text;
begin
  foreach t in array array['attendance_signup_links', 'attendance_signups'] loop
    execute format($f$
      create table if not exists public.%1$I (
        id          text primary key,
        data        jsonb not null default '{}'::jsonb,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),
        updated_by  uuid default auth.uid()
      )$f$, t);
    execute format('drop trigger if exists %1$I on public.%2$I', t || '_touch', t);
    execute format('create trigger %1$I before update on public.%2$I for each row execute function public.helm_touch_row()', t || '_touch', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %1$I on public.%2$I', t || '_rw', t);
    execute format($f$
      create policy %1$I on public.%2$I for all to authenticated
        using (public.has_system_access('attendance'))
        with check (public.has_system_access('attendance'))$f$, t || '_rw', t);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

create index if not exists attendance_signups_course_idx on public.attendance_signups ((data->>'courseId'));
create index if not exists attendance_signups_link_idx on public.attendance_signups ((data->>'linkId'), created_at);

-- Link codes must be long random strings (created by the app).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attendance_signup_links_id_len') then
    alter table public.attendance_signup_links
      add constraint attendance_signup_links_id_len check (length(id) between 20 and 64 and id ~ '^[A-Za-z0-9_-]+$');
  end if;
end $$;

-- ---------- public: what course is this link for? ----------
create or replace function public.attendance_signup_info(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object(
      'ok', true,
      'course', coalesce(c.data->>'name', ''),
      'teacher', coalesce(c.data->>'teacher', ''))
    from public.attendance_signup_links l
    join public.attendance_courses c on c.id = l.data->>'courseId'
    where l.id = p_token and coalesce((l.data->>'active')::boolean, false)
  ), jsonb_build_object('ok', false))
$$;

-- ---------- public: submit a sign-up request ----------
create or replace function public.attendance_signup_submit(p_token text, p_form jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text;
  v_name   text := left(regexp_replace(trim(coalesce(p_form->>'name', '')), '\s+', ' ', 'g'), 80);
  v_phone  text := regexp_replace(coalesce(p_form->>'phone', ''), '[\s().-]', '', 'g');
  v_gender text := coalesce(p_form->>'gender', '');
  v_email  text := left(lower(trim(coalesce(p_form->>'email', ''))), 120);
  v_birth  text := coalesce(p_form->>'birthDate', '');
  v_data   jsonb;
  k        text;
begin
  select l.data->>'courseId' into v_course
  from public.attendance_signup_links l
  join public.attendance_courses c on c.id = l.data->>'courseId'
  where l.id = p_token and coalesce((l.data->>'active')::boolean, false);
  if v_course is null then return jsonb_build_object('ok', false, 'error', 'link'); end if;

  if length(v_name) < 3 then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if v_phone !~ '^\+?[0-9]{8,15}$' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if v_gender not in ('f', 'm') then return jsonb_build_object('ok', false, 'error', 'gender'); end if;
  if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_birth <> '' and v_birth !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then v_birth := ''; end if;

  -- limits: at most 40 sign-ups per link every 10 minutes, 400 waiting per course
  if (select count(*) from public.attendance_signups s
      where s.data->>'linkId' = p_token and s.created_at > now() - interval '10 minutes') >= 40
     or (select count(*) from public.attendance_signups s
         where s.data->>'courseId' = v_course and s.data->>'status' = 'pending') >= 400 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;

  -- the same phone already waiting for this course: accept quietly, no duplicate
  if exists (select 1 from public.attendance_signups s
             where s.data->>'courseId' = v_course and s.data->>'status' = 'pending' and s.data->>'phone' = v_phone) then
    return jsonb_build_object('ok', true);
  end if;

  v_data := jsonb_build_object(
    'courseId', v_course, 'linkId', p_token, 'status', 'pending',
    'name', v_name, 'phone', v_phone, 'gender', v_gender, 'email', v_email, 'birthDate', v_birth,
    'submittedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  -- optional short text fields (whitelist only)
  foreach k in array array['governorate', 'area', 'source', 'job', 'education', 'notes'] loop
    v_data := v_data || jsonb_build_object(k, left(trim(coalesce(p_form->>k, '')), case when k = 'notes' then 300 else 80 end));
  end loop;

  insert into public.attendance_signups (id, data, updated_by)
  values ('su' || replace(gen_random_uuid()::text, '-', ''), v_data, null);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.attendance_signup_info(text) from public;
revoke all on function public.attendance_signup_submit(text, jsonb) from public;
grant execute on function public.attendance_signup_info(text) to anon, authenticated;
grant execute on function public.attendance_signup_submit(text, jsonb) to anon, authenticated;

-- ---------- allow the app's "update" on the new tables ----------
create or replace function public.helm_patch_doc(p_table text, p_id text, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r jsonb;
begin
  if p_table not in (
    'cases_cases', 'cases_status', 'cases_deliveries', 'cases_donors', 'cases_settings',
    'attendance_students', 'attendance_courses', 'attendance_sessions', 'attendance_payments',
    'attendance_expenses', 'attendance_groups', 'attendance_messages', 'attendance_settings',
    'attendance_signup_links', 'attendance_signups'
  ) then
    raise exception 'table not allowed' using errcode = '42501';
  end if;
  execute format('update public.%I set data = public.helm_jsonb_merge(data, $1) where id = $2 returning data', p_table)
    using p_patch, p_id into r;
  if r is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return r;
end $$;
revoke all on function public.helm_patch_doc(text, text, jsonb) from anon, public;
grant execute on function public.helm_patch_doc(text, text, jsonb) to authenticated;

-- ---------- live updates ----------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['attendance_signup_links', 'attendance_signups'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
