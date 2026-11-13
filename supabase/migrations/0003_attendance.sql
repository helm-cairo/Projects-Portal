-- =====================================================================
-- Helm Portal: 0003 attendance & courses system (الطلاب والدورات)
-- Run after 0001 and 0002. Safe to run again.
--
-- Everyone with attendance access has the same rights (read + write).
-- Each record is stored as JSON in "data" (same shape the app already uses).
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'attendance_students',   -- central students database
    'attendance_courses',    -- courses (name, teacher, fee, studentIds...)
    'attendance_sessions',   -- one row per lesson, with who attended
    'attendance_payments',   -- subscriptions paid
    'attendance_expenses',   -- course expenses
    'attendance_groups',     -- saved groups of students (for messages)
    'attendance_messages',   -- message log
    'attendance_settings'    -- app settings
  ] loop
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

create index if not exists attendance_sessions_course_idx on public.attendance_sessions ((data->>'courseId'));
create index if not exists attendance_payments_course_idx on public.attendance_payments ((data->>'courseId'));
create index if not exists attendance_messages_at_idx on public.attendance_messages ((data->>'at'));
