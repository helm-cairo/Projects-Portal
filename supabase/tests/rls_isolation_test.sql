-- =====================================================================
-- Helm Portal: security test (RLS isolation)
--
-- Paste the whole file into Supabase -> SQL Editor and press Run.
-- It creates temporary test users and test rows, checks what each user can
-- see, then UNDOES EVERYTHING (nothing is saved). You get one table:
-- every row should say pass = true.
--
-- بالعربي: الاختبار ده بيعمل مستخدمين تجريبيين وبيانات تجريبية، ويتأكد إن
-- كل واحد بيشوف المسموح له بس، وبعدين بيمسح كل حاجة لوحده.
-- لازم كل الصفوف تبقى pass = true.
-- =====================================================================

create or replace function pg_temp.helm_rls_test()
returns table (test text, expected text, actual text, pass boolean)
language plpgsql as $$
declare
  res      jsonb := '[]'::jsonb;
  me_role  text  := current_user;
  u_att    uuid  := gen_random_uuid();   -- attendance only
  u_res    uuid  := gen_random_uuid();   -- cases researcher
  u_res2   uuid  := gen_random_uuid();   -- another cases researcher
  u_view   uuid  := gen_random_uuid();   -- cases viewer
  u_appr   uuid  := gen_random_uuid();   -- cases approver
  u_temp   uuid  := gen_random_uuid();   -- cases admin, but still on a temporary password
  t        text;
  n        bigint;
  b        boolean;
  ok       boolean;
  cases_tables text[] := array['cases_cases','cases_private','cases_status','cases_deliveries','cases_donors','cases_settings'];
  att_tables   text[] := array['attendance_students','attendance_courses','attendance_sessions','attendance_payments',
                               'attendance_expenses','attendance_groups','attendance_messages','attendance_settings'];
begin
  begin  -- everything inside this block is rolled back at the end
    -- ---------- setup (as database owner) ----------
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select x.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           x.email, '{}'::jsonb, jsonb_build_object('full_name', x.name), now(), now()
    from (values (u_att,  'rls-att@example.invalid',   'Test Attendance'),
                 (u_res,  'rls-res@example.invalid',   'Test Researcher'),
                 (u_res2, 'rls-res2@example.invalid',  'Test Researcher 2'),
                 (u_view, 'rls-view@example.invalid',  'Test Viewer'),
                 (u_appr, 'rls-appr@example.invalid',  'Test Approver'),
                 (u_temp, 'rls-temp@example.invalid',  'Test Temp')) as x(id, email, name);

    update public.profiles set must_set_password = false where id in (u_att, u_res, u_res2, u_view, u_appr);
    insert into public.system_access (user_id, system, role) values
      (u_att, 'attendance', 'member'),
      (u_res, 'cases', 'researcher'), (u_res2, 'cases', 'researcher'),
      (u_view, 'cases', 'viewer'), (u_appr, 'cases', 'approver'),
      (u_temp, 'cases', 'admin');

    insert into public.cases_cases (id, created_by, data) values
      ('rls_c1', u_res,  '{"idName":"Test Case 1","nationalId":"29001010000001","idFrontFileId":"rlsFileFront0001","area":"x"}'),
      ('rls_c2', u_res2, '{"idName":"Test Case 2","nationalId":"29001010000002","area":"x"}');
    insert into public.cases_status (id, data) values ('rls_c1', '{"category":"pending"}');
    insert into public.cases_deliveries (id, data) values ('rls_d1', '{"caseId":"rls_c1","period":"2026-11"}'),
                                                          ('rls_d2', '{"caseId":"rls_c2","period":"2026-11"}');
    insert into public.cases_donors (id, data) values ('rls_dn1', '{"name":"Test Donor"}');
    insert into public.cases_settings (id, data) values ('rls_set', '{"areas":["x"]}');
    foreach t in array att_tables loop
      execute format('insert into public.%I (id, data) values (%L, %L)', t, 'rls_' || t, '{"name":"test"}');
    end loop;

    -- ======================= user with ATTENDANCE only =======================
    perform set_config('request.jwt.claims', json_build_object('sub', u_att, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    foreach t in array cases_tables loop
      execute format('select count(*) from public.%I', t) into n;
      res := res || jsonb_build_object('test', 'attendance-only user reads ' || t, 'expected', '0', 'actual', n::text, 'pass', n = 0);
    end loop;
    foreach t in array att_tables loop
      execute format('select count(*) from public.%I', t) into n;
      res := res || jsonb_build_object('test', 'attendance-only user reads ' || t, 'expected', '>= 1', 'actual', n::text, 'pass', n >= 1);
    end loop;
    begin
      insert into public.cases_cases (id, data) values ('rls_hack', '{"idName":"x"}');
      ok := false;
    exception when others then ok := true;
    end;
    res := res || jsonb_build_object('test', 'attendance-only user cannot add a case', 'expected', 'blocked', 'actual', case when ok then 'blocked' else 'ALLOWED' end, 'pass', ok);
    select count(*) into n from public.system_members('cases');
    res := res || jsonb_build_object('test', 'attendance-only user lists cases members', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    select public.cases_nid_taken('29001010000001') into b;
    res := res || jsonb_build_object('test', 'attendance-only user probes a national ID', 'expected', 'false', 'actual', b::text, 'pass', not b);
    begin
      execute 'select count(*) from storage.objects' into n;
      res := res || jsonb_build_object('test', 'attendance-only user reads storage.objects', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    exception when undefined_table then null;
              when insufficient_privilege then
      res := res || jsonb_build_object('test', 'attendance-only user reads storage.objects', 'expected', '0', 'actual', 'denied', 'pass', true);
    end;
    begin
      execute 'select count(*) from storage.buckets' into n;
      res := res || jsonb_build_object('test', 'attendance-only user lists storage buckets', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    exception when undefined_table then null;
              when insufficient_privilege then
      res := res || jsonb_build_object('test', 'attendance-only user lists storage buckets', 'expected', '0', 'actual', 'denied', 'pass', true);
    end;
    perform set_config('role', me_role, true);

    -- ======================= cases RESEARCHER =======================
    perform set_config('request.jwt.claims', json_build_object('sub', u_res, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    foreach t in array att_tables loop
      execute format('select count(*) from public.%I', t) into n;
      res := res || jsonb_build_object('test', 'cases-only user reads ' || t, 'expected', '0', 'actual', n::text, 'pass', n = 0);
    end loop;
    begin
      insert into public.attendance_students (id, data) values ('rls_hack', '{"name":"x"}');
      ok := false;
    exception when others then ok := true;
    end;
    res := res || jsonb_build_object('test', 'cases-only user cannot add a student', 'expected', 'blocked', 'actual', case when ok then 'blocked' else 'ALLOWED' end, 'pass', ok);
    select count(*) into n from public.cases_cases;
    res := res || jsonb_build_object('test', 'researcher sees only her own cases', 'expected', '1', 'actual', n::text, 'pass', n = 1);
    select count(*) into n from public.cases_private;
    res := res || jsonb_build_object('test', 'researcher sees national ID of her own case only', 'expected', '1', 'actual', n::text, 'pass', n = 1);
    select count(*) into n from public.cases_deliveries;
    res := res || jsonb_build_object('test', 'researcher sees deliveries of her own cases only', 'expected', '1', 'actual', n::text, 'pass', n = 1);
    update public.cases_cases set data = data || '{"idName":"changed"}' where id = 'rls_c2';
    get diagnostics n = row_count;
    res := res || jsonb_build_object('test', 'researcher cannot edit another researcher''s case', 'expected', '0 rows', 'actual', n || ' rows', 'pass', n = 0);
    begin
      insert into public.cases_status (id, data) values ('rls_c1x', '{"category":"deserve"}');
      ok := false;
    exception when others then ok := true;
    end;
    res := res || jsonb_build_object('test', 'researcher cannot decide eligibility', 'expected', 'blocked', 'actual', case when ok then 'blocked' else 'ALLOWED' end, 'pass', ok);
    perform set_config('role', me_role, true);

    -- ======================= cases VIEWER =======================
    perform set_config('request.jwt.claims', json_build_object('sub', u_view, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from public.cases_cases;
    res := res || jsonb_build_object('test', 'viewer sees all cases', 'expected', '2', 'actual', n::text, 'pass', n = 2);
    select count(*) into n from public.cases_private;
    res := res || jsonb_build_object('test', 'viewer cannot read full national IDs / ID images', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    select count(*) into n from public.cases_cases where data ? 'nationalId' or data ? 'idFrontFileId';
    res := res || jsonb_build_object('test', 'national ID is not stored inside case data', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    select count(*) into n from public.cases_cases where nid_last4 is not null;
    res := res || jsonb_build_object('test', 'viewer gets only the last 4 digits (for masking)', 'expected', '2', 'actual', n::text, 'pass', n = 2);
    begin
      update public.cases_cases set data = data || '{"idName":"changed"}' where id = 'rls_c1';
      get diagnostics n = row_count;
      ok := n = 0;
    exception when others then ok := true;
    end;
    res := res || jsonb_build_object('test', 'viewer cannot edit cases', 'expected', 'blocked', 'actual', case when ok then 'blocked' else 'ALLOWED' end, 'pass', ok);
    perform set_config('role', me_role, true);

    -- ======================= cases APPROVER =======================
    perform set_config('request.jwt.claims', json_build_object('sub', u_appr, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from public.cases_private;
    res := res || jsonb_build_object('test', 'approver sees full national IDs', 'expected', '2', 'actual', n::text, 'pass', n = 2);
    begin
      delete from public.cases_cases where id = 'rls_c1';
      get diagnostics n = row_count;
      ok := n = 0;
    exception when others then ok := true;
    end;
    res := res || jsonb_build_object('test', 'approver cannot delete cases', 'expected', 'blocked', 'actual', case when ok then 'blocked' else 'ALLOWED' end, 'pass', ok);
    perform set_config('role', me_role, true);

    -- ======================= user still on TEMPORARY password =======================
    perform set_config('request.jwt.claims', json_build_object('sub', u_temp, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from public.cases_cases;
    res := res || jsonb_build_object('test', 'user with temporary password sees no data', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    perform set_config('role', me_role, true);

    -- ======================= anonymous visitor (not signed in) =======================
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    perform set_config('role', 'anon', true);
    foreach t in array array['profiles', 'system_access', 'cases_cases', 'attendance_students'] loop
      begin
        execute format('select count(*) from public.%I', t) into n;
        ok := n = 0;
      exception when insufficient_privilege then ok := true; n := -1;
      end;
      res := res || jsonb_build_object('test', 'anonymous visitor reads ' || t, 'expected', 'denied', 'actual', case when n = -1 then 'denied' else n::text end, 'pass', ok);
    end loop;
    perform set_config('role', me_role, true);

    raise exception 'helm_rls_test_rollback';
  exception when others then
    perform set_config('role', me_role, true);
    if sqlerrm <> 'helm_rls_test_rollback' then
      raise;
    end if;
  end;

  return query
    select e->>'test', e->>'expected', e->>'actual', (e->>'pass')::boolean
    from jsonb_array_elements(res) e;
end $$;

select * from pg_temp.helm_rls_test();
