-- =====================================================================
-- Helm Portal: 0004 shared helpers + live updates + storage lock
-- Run after 0001, 0002, 0003. Safe to run again.
-- =====================================================================

-- ---------- merge fields into an existing record ----------
-- Runs with the caller's own permissions (security invoker), so every RLS rule
-- above still applies. Only the listed tables are allowed.
create or replace function public.helm_patch_doc(p_table text, p_id text, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r jsonb;
begin
  if p_table not in (
    'cases_cases', 'cases_status', 'cases_deliveries', 'cases_donors', 'cases_settings',
    'attendance_students', 'attendance_courses', 'attendance_sessions', 'attendance_payments',
    'attendance_expenses', 'attendance_groups', 'attendance_messages', 'attendance_settings'
  ) then
    raise exception 'table not allowed' using errcode = '42501';
  end if;
  execute format('update public.%I set data = data || $1 where id = $2 returning data', p_table)
    using p_patch, p_id into r;
  if r is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return r;
end $$;
revoke all on function public.helm_patch_doc(text, text, jsonb) from anon, public;
grant execute on function public.helm_patch_doc(text, text, jsonb) to authenticated;

-- ---------- live updates (Realtime respects RLS) ----------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array[
    'cases_cases', 'cases_private', 'cases_status', 'cases_deliveries', 'cases_donors', 'cases_settings',
    'attendance_students', 'attendance_courses', 'attendance_sessions', 'attendance_payments',
    'attendance_expenses', 'attendance_groups', 'attendance_messages', 'attendance_settings'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- Storage ----------
-- ID card images live in a private Google Drive folder (through the "id-card"
-- Edge Function), NOT in Supabase Storage. We create no buckets and no Storage
-- policies, so with RLS on storage.objects nobody can read or upload anything.
-- (Supabase enables RLS on storage.objects by default; the test checks this.)
