-- =====================================================================
-- Helm Portal: 0005 support for the apps
-- Run after 0001-0004. Safe to run again.
--
--  * helm_jsonb_merge + helm_patch_doc now merge nested objects (the attendance
--    app updates one student inside a lesson's "present" list and expects the
--    other students to be kept).
--  * cases_cases_full: a read-only view of cases joined with the sensitive data
--    the CURRENT user may see. It runs with the caller's permissions
--    (security_invoker), so RLS on cases_private still decides: viewers get only
--    the last 4 digits ("nidMasked"), never the full national ID.
-- =====================================================================

-- Deep merge of two JSON values: objects are merged key by key, anything else is replaced.
create or replace function public.helm_jsonb_merge(a jsonb, b jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      coalesce((
        select jsonb_object_agg(k,
                 case when a ? k and b ? k then public.helm_jsonb_merge(a -> k, b -> k)
                      when b ? k then b -> k
                      else a -> k end)
        from (select jsonb_object_keys(a) as k union select jsonb_object_keys(b)) keys
      ), '{}'::jsonb)
    else b
  end
$$;
revoke all on function public.helm_jsonb_merge(jsonb, jsonb) from anon, public;
grant execute on function public.helm_jsonb_merge(jsonb, jsonb) to authenticated;

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
  execute format('update public.%I set data = public.helm_jsonb_merge(data, $1) where id = $2 returning data', p_table)
    using p_patch, p_id into r;
  if r is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return r;
end $$;
revoke all on function public.helm_patch_doc(text, text, jsonb) from anon, public;
grant execute on function public.helm_patch_doc(text, text, jsonb) to authenticated;

-- Cases + the sensitive fields this user is allowed to see.
create or replace view public.cases_cases_full with (security_invoker = true) as
select
  c.id,
  c.data
    || jsonb_strip_nulls(jsonb_build_object(
         'nationalId',    p.national_id,
         'idFrontFileId', p.id_front_file_id,
         'idBackFileId',  p.id_back_file_id))
    || case when p.case_id is null and c.nid_last4 is not null
            then jsonb_build_object('nidMasked', c.nid_last4)
            else '{}'::jsonb end
    as data,
  c.updated_at
from public.cases_cases c
left join public.cases_private p on p.case_id = c.id;

revoke all on public.cases_cases_full from anon, public;
grant select on public.cases_cases_full to authenticated;
