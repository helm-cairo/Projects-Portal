-- =====================================================================
-- Helm Portal: self sign-up security test
-- Paste into Supabase -> SQL Editor and Run. Creates test rows, checks what an
-- anonymous visitor / members / non-members can do, then UNDOES EVERYTHING.
-- Every row should say pass = true.
-- =====================================================================

create or replace function pg_temp.helm_signup_test()
returns table (test text, expected text, actual text, pass boolean)
language plpgsql as $$
declare
  res     jsonb := '[]'::jsonb;
  me_role text  := current_user;
  u_att   uuid  := gen_random_uuid();
  u_case  uuid  := gen_random_uuid();
  tok     text  := 'tst' || replace(gen_random_uuid()::text, '-', '');
  tok_off text  := 'tstoff' || replace(gen_random_uuid()::text, '-', '');
  r       jsonb;
  n       bigint;
  ok      boolean;
  i       int;
begin
  begin
    -- setup
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (u_att,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'su-att@example.invalid',  '{}', '{}', now(), now()),
           (u_case, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'su-case@example.invalid', '{}', '{}', now(), now());
    update public.profiles set must_set_password = false where id in (u_att, u_case);
    insert into public.system_access (user_id, system, role) values (u_att, 'attendance', 'member'), (u_case, 'cases', 'viewer');
    insert into public.attendance_courses (id, data) values ('su_c1', '{"name":"Test course","teacher":"Test teacher","studentIds":["x"]}');
    insert into public.attendance_signup_links (id, data) values (tok, '{"courseId":"su_c1","active":true}'), (tok_off, '{"courseId":"su_c1","active":false}');

    -- ======== anonymous visitor ========
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    perform set_config('role', 'anon', true);

    r := public.attendance_signup_info(tok);
    res := res || jsonb_build_object('test', 'anon: valid link shows course name only', 'expected', 'ok + name, no ids',
      'actual', r::text, 'pass', (r->>'ok')::boolean and r->>'course' = 'Test course' and not (r ? 'studentIds') and not (r ? 'courseId'));
    r := public.attendance_signup_info(tok_off);
    res := res || jsonb_build_object('test', 'anon: switched-off link is refused', 'expected', 'ok=false', 'actual', r::text, 'pass', not (r->>'ok')::boolean);
    r := public.attendance_signup_info('nonexistent-token-1234567890');
    res := res || jsonb_build_object('test', 'anon: unknown link is refused', 'expected', 'ok=false', 'actual', r::text, 'pass', not (r->>'ok')::boolean);

    r := public.attendance_signup_submit(tok, '{"name":"Test Student","phone":"01000000001","gender":"f","job":"x","studentIds":["hack"],"status":"accepted"}');
    res := res || jsonb_build_object('test', 'anon: valid sign-up accepted', 'expected', 'ok=true', 'actual', r::text, 'pass', (r->>'ok')::boolean);
    r := public.attendance_signup_submit(tok, '{"name":"Test Student","phone":"01000000001","gender":"f"}');
    res := res || jsonb_build_object('test', 'anon: same phone twice is not duplicated', 'expected', 'ok=true (no new row)', 'actual', r::text, 'pass', (r->>'ok')::boolean);
    r := public.attendance_signup_submit(tok_off, '{"name":"Test Student","phone":"01000000002","gender":"f"}');
    res := res || jsonb_build_object('test', 'anon: cannot sign up through a switched-off link', 'expected', 'error=link', 'actual', r::text, 'pass', r->>'error' = 'link');
    r := public.attendance_signup_submit(tok, '{"name":"Te","phone":"abc","gender":"f"}');
    res := res || jsonb_build_object('test', 'anon: bad data refused', 'expected', 'ok=false', 'actual', r::text, 'pass', not (r->>'ok')::boolean);

    begin
      execute 'select count(*) from public.attendance_signups' into n; ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || jsonb_build_object('test', 'anon: cannot read sign-up requests', 'expected', 'denied', 'actual', case when ok then 'denied' else 'READ' end, 'pass', ok);
    begin
      execute 'select count(*) from public.attendance_courses' into n; ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || jsonb_build_object('test', 'anon: cannot read courses', 'expected', 'denied', 'actual', case when ok then 'denied' else 'READ' end, 'pass', ok);
    begin
      execute $q$insert into public.attendance_signups (id, data) values ('suhack', '{}')$q$; ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || jsonb_build_object('test', 'anon: cannot write tables directly', 'expected', 'denied', 'actual', case when ok then 'denied' else 'WROTE' end, 'pass', ok);
    begin
      execute 'select public.helm_patch_doc(''attendance_signups'', ''x'', ''{}'')'; ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || jsonb_build_object('test', 'anon: cannot use the update helper', 'expected', 'denied', 'actual', case when ok then 'denied' else 'ALLOWED' end, 'pass', ok);
    perform set_config('role', me_role, true);

    -- what was stored (as owner)
    select count(*) into n from public.attendance_signups where data->>'courseId' = 'su_c1';
    res := res || jsonb_build_object('test', 'exactly one request stored', 'expected', '1', 'actual', n::text, 'pass', n = 1);
    select count(*) into n from public.attendance_signups
      where data->>'courseId' = 'su_c1' and data->>'status' = 'pending' and not (data ? 'studentIds');
    res := res || jsonb_build_object('test', 'extra fields from the form are ignored', 'expected', '1', 'actual', n::text, 'pass', n = 1);

    -- ======== attendance member ========
    perform set_config('request.jwt.claims', json_build_object('sub', u_att, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from public.attendance_signups;
    res := res || jsonb_build_object('test', 'attendance member sees the request', 'expected', '1', 'actual', n::text, 'pass', n = 1);
    perform public.helm_patch_doc('attendance_signups', (select id from public.attendance_signups limit 1), '{"status":"accepted"}');
    select count(*) into n from public.attendance_signups where data->>'status' = 'accepted' and data->>'name' = 'Test Student';
    res := res || jsonb_build_object('test', 'attendance member can accept it', 'expected', '1', 'actual', n::text, 'pass', n = 1);
    perform set_config('role', me_role, true);

    -- ======== cases-only user ========
    perform set_config('request.jwt.claims', json_build_object('sub', u_case, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from public.attendance_signups;
    res := res || jsonb_build_object('test', 'cases-only user sees no requests', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    select count(*) into n from public.attendance_signup_links;
    res := res || jsonb_build_object('test', 'cases-only user sees no links', 'expected', '0', 'actual', n::text, 'pass', n = 0);
    perform set_config('role', me_role, true);

    -- ======== rate limit ========
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    perform set_config('role', 'anon', true);
    for i in 1..45 loop
      r := public.attendance_signup_submit(tok, jsonb_build_object('name', 'Flood ' || i, 'phone', '0109' || lpad(i::text, 7, '0'), 'gender', 'm'));
    end loop;
    res := res || jsonb_build_object('test', 'flooding one link gets blocked', 'expected', 'error=busy', 'actual', r::text, 'pass', r->>'error' = 'busy');
    perform set_config('role', me_role, true);

    raise exception 'helm_signup_test_rollback';
  exception when others then
    perform set_config('role', me_role, true);
    if sqlerrm <> 'helm_signup_test_rollback' then raise; end if;
  end;
  return query select e->>'test', e->>'expected', e->>'actual', (e->>'pass')::boolean from jsonb_array_elements(res) e;
end $$;

select * from pg_temp.helm_signup_test();
