-- =====================================================================
-- Team Calendar — Supabase schema
-- Paste this whole file into Supabase Dashboard → SQL Editor → Run.
-- Safe to re-run (idempotent where practical).
--
-- Data window: past 3 months + future 12 months (15 months total).
--   * Events can only be created/moved inside that window.
--   * A daily job deletes events, messages, tasks and audit records
--     older than 3 months.
-- =====================================================================

create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------------
-- Settings: retention window in one place
-- ---------------------------------------------------------------------
create or replace function public.window_past()   returns interval language sql immutable as $$ select interval '3 months' $$;
create or replace function public.window_future()  returns interval language sql immutable as $$ select interval '12 months' $$;

-- ---------------------------------------------------------------------
-- Profiles (one row per login account)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  role         text not null default 'member' check (role in ('owner','admin','member')),
  created_at   timestamptz not null default now()
);

-- Accounts are created with e-mail "<username>@team.local".
-- A profile row is created automatically; display name defaults to the username.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare uname text := lower(split_part(new.email, '@', 1));
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, uname, uname)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper: is the current user owner/admin?
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('owner','admin'))
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner')
$$;

-- ---------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id         bigint generated always as identity primary key,
  title      text not null check (char_length(btrim(title)) between 1 and 120),
  location   text not null default '' check (char_length(location) <= 200),
  dress_code text not null default '' check (char_length(dress_code) <= 120),
  notes      text not null default '' check (char_length(notes) <= 4000),
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  check (end_at - start_at <= interval '7 days')
);
create index if not exists events_start_idx on public.events (start_at);

create or replace function public.events_guard()
returns trigger language plpgsql as $$
begin
  if new.start_at < now() - public.window_past() or new.start_at > now() + public.window_future() then
    raise exception 'Event must start within the past 3 months or the next 12 months'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.created_by := old.created_by; new.created_at := old.created_at; end if;
  return new;
end $$;

drop trigger if exists events_guard on public.events;
create trigger events_guard before insert or update on public.events
  for each row execute function public.events_guard();

-- ---------------------------------------------------------------------
-- RSVPs
-- ---------------------------------------------------------------------
create table if not exists public.responses (
  event_id     bigint not null references public.events(id) on delete cascade,
  user_id      uuid   not null references public.profiles(id) on delete cascade default auth.uid(),
  status       text   not null check (status in ('going','late','maybe','not_going')),
  late_minutes int,
  updated_at   timestamptz not null default now(),
  primary key (event_id, user_id)
);
-- "late" requires minutes (1–1440); other answers must not have minutes.
alter table public.responses drop constraint if exists responses_check;
alter table public.responses drop constraint if exists responses_late_check;
alter table public.responses add constraint responses_late_check check (
  (status = 'late' and late_minutes is not null and late_minutes between 1 and 1440)
  or (status <> 'late' and late_minutes is null));

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists responses_touch on public.responses;
create trigger responses_touch before update on public.responses
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Message board
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  body       text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_created_idx on public.messages (created_at desc);

-- ---------------------------------------------------------------------
-- Assignments (task board)
-- ---------------------------------------------------------------------
create table if not exists public.assignments (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(btrim(title)) between 1 and 160),
  details     text not null default '' check (char_length(details) <= 4000),
  assignee    uuid references public.profiles(id) on delete set null,
  due_at      timestamptz,
  status      text not null default 'todo' check (status in ('todo','doing','done')),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists assignments_touch on public.assignments;
create trigger assignments_touch before update on public.assignments
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Audit log (written only by triggers / trusted functions)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_name  text,
  action      text not null,          -- INSERT / UPDATE / DELETE / LOGIN / ADMIN_*
  table_name  text,
  record_id   text,
  old_data    jsonb,
  new_data    jsonb
);
create index if not exists audit_at_idx on public.audit_log (at desc);

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  uname text;
  rid   text;
begin
  -- Changes with no logged-in user are system jobs (retention cleanup,
  -- account creation) — those are logged explicitly elsewhere.
  if uid is null then return null; end if;
  select coalesce(display_name || ' (' || username || ')', username) into uname
    from public.profiles where id = uid;
  if tg_table_name = 'responses' then
    rid := coalesce(new.event_id, old.event_id)::text;
  elsif tg_table_name = 'profiles' then
    rid := coalesce(new.id, old.id)::text;
  else
    rid := (case when tg_op = 'DELETE' then old.id else new.id end)::text;
  end if;
  insert into public.audit_log (actor, actor_name, action, table_name, record_id, old_data, new_data)
  values (uid, uname, tg_op, tg_table_name, rid,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','events','responses','messages','assignments'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s
                    for each row execute function public.audit_trigger()', t);
  end loop;
end $$;

-- Called by the website right after a successful sign-in.
create or replace function public.log_login()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.audit_log (actor, actor_name, action)
  select id, display_name || ' (' || username || ')', 'LOGIN' from public.profiles where id = auth.uid();
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.events      enable row level security;
alter table public.responses   enable row level security;
alter table public.messages    enable row level security;
alter table public.assignments enable row level security;
alter table public.audit_log   enable row level security;

-- Nobody who is not logged in can read anything.
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;

-- profiles: everyone logged in can read; you can only change your own display_name.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
revoke insert, update, delete on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- events: all read; only owner/admin write.
drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (true);
drop policy if exists events_write on public.events;
create policy events_write on public.events for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.events to authenticated;

-- responses: all read; each person manages only their own RSVP.
drop policy if exists responses_read on public.responses;
create policy responses_read on public.responses for select to authenticated using (true);
drop policy if exists responses_own on public.responses;
create policy responses_own on public.responses for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.responses to authenticated;

-- messages: all read; post as yourself; delete your own (admins can delete any).
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (true);
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
revoke update on public.messages from authenticated;
grant select, insert, delete on public.messages to authenticated;

-- assignments: all read; only owner/admin write.
drop policy if exists assignments_read on public.assignments;
create policy assignments_read on public.assignments for select to authenticated using (true);
drop policy if exists assignments_write on public.assignments;
create policy assignments_write on public.assignments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.assignments to authenticated;

-- audit_log: only owner/admin can read; nobody can write directly.
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;

grant execute on function public.is_admin(), public.is_owner(), public.log_login(),
                          public.window_past(), public.window_future() to authenticated;
revoke execute on function public.handle_new_user(), public.audit_trigger() from authenticated;

-- ---------------------------------------------------------------------
-- Retention: keep only the last 3 months of history
-- ---------------------------------------------------------------------
create or replace function public.run_retention()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.events      where end_at     < now() - public.window_past();
  delete from public.messages    where created_at < now() - public.window_past();
  delete from public.assignments where coalesce(due_at, created_at) < now() - public.window_past();
  delete from public.audit_log   where at         < now() - public.window_past();
end $$;
revoke execute on function public.run_retention() from public, anon, authenticated;

-- Tiny public function the GitHub keep-alive job calls so the free
-- project never counts as "inactive" (free projects pause after 7 idle days).
create or replace function public.keepalive()
returns timestamptz language sql stable as $$ select now() $$;
grant execute on function public.keepalive() to anon, authenticated;

-- Daily at 09:00 UTC (03:00 Chicago).
select cron.unschedule('team-calendar-retention')
  where exists (select 1 from cron.job where jobname = 'team-calendar-retention');
select cron.schedule('team-calendar-retention', '0 9 * * *', 'select public.run_retention()');

-- ---------------------------------------------------------------------
-- Realtime (live updates for chat and calendar)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['messages','events','responses','assignments'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
