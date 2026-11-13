-- =====================================================================
-- Helm Portal: 0007 sign-up form — more required fields + attendance mode
-- Run after 0006. Safe to run again.
--
-- Now required on the public sign-up form (checked here, not only in the page):
--   name, gender, phone (as before) + birth date, governorate, area,
--   how she heard about us (source), and attendance mode:
--   offline (حضوري) / online (أونلاين) / hybrid (هايبرد)
-- =====================================================================

create or replace function public.attendance_signup_submit(p_token text, p_form jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text;
  v_name   text := left(regexp_replace(trim(coalesce(p_form->>'name', '')), '\s+', ' ', 'g'), 80);
  v_phone  text := regexp_replace(coalesce(p_form->>'phone', ''), '[\s().-]', '', 'g');
  v_gender text := coalesce(p_form->>'gender', '');
  v_email  text := left(lower(trim(coalesce(p_form->>'email', ''))), 120);
  v_birth  text := coalesce(p_form->>'birthDate', '');
  v_gov    text := left(trim(coalesce(p_form->>'governorate', '')), 80);
  v_area   text := left(trim(coalesce(p_form->>'area', '')), 80);
  v_source text := left(trim(coalesce(p_form->>'source', '')), 80);
  v_mode   text := coalesce(p_form->>'mode', '');
  v_data   jsonb;
  k        text;
begin
  select l.data->>'courseId' into v_course
  from public.attendance_signup_links l
  join public.attendance_courses c on c.id = l.data->>'courseId'
  where l.id = p_token and coalesce((l.data->>'active')::boolean, false);
  if v_course is null then return jsonb_build_object('ok', false, 'error', 'link'); end if;

  if length(v_name) < 3 then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if v_gender not in ('f', 'm') then return jsonb_build_object('ok', false, 'error', 'gender'); end if;
  if v_phone !~ '^\+?[0-9]{8,15}$' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'error', 'email'); end if;
  -- birth date: real date between 1930 and today
  if v_birth !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then return jsonb_build_object('ok', false, 'error', 'birth'); end if;
  begin
    if v_birth::date < date '1930-01-01' or v_birth::date > current_date then
      return jsonb_build_object('ok', false, 'error', 'birth');
    end if;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'birth');
  end;
  if v_gov = '' then return jsonb_build_object('ok', false, 'error', 'governorate'); end if;
  if v_area = '' then return jsonb_build_object('ok', false, 'error', 'area'); end if;
  if v_source = '' then return jsonb_build_object('ok', false, 'error', 'source'); end if;
  if v_mode not in ('offline', 'online', 'hybrid') then return jsonb_build_object('ok', false, 'error', 'mode'); end if;

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
    'governorate', v_gov, 'area', v_area, 'source', v_source, 'mode', v_mode,
    'submittedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  -- optional short text fields (whitelist only)
  foreach k in array array['job', 'education', 'notes'] loop
    v_data := v_data || jsonb_build_object(k, left(trim(coalesce(p_form->>k, '')), case when k = 'notes' then 300 else 80 end));
  end loop;

  insert into public.attendance_signups (id, data, updated_by)
  values ('su' || replace(gen_random_uuid()::text, '-', ''), v_data, null);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.attendance_signup_submit(text, jsonb) from public;
grant execute on function public.attendance_signup_submit(text, jsonb) to anon, authenticated;
