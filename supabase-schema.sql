-- RideaseVX Supabase schema. Safe to rerun; legacy table names are
-- renamed in place so existing charger/session/transaction data is preserved.
create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.stations') is null and to_regclass('public.chargers') is not null then
    alter table public.chargers rename to stations;
  end if;
  if to_regclass('public.sessions') is null and to_regclass('public.charging_sessions') is not null then
    alter table public.charging_sessions rename to sessions;
  end if;
  if to_regclass('public.transactions') is null and to_regclass('public.wallet_transactions') is not null then
    alter table public.wallet_transactions rename to transactions;
  end if;
  if to_regclass('public.sessions') is not null
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='charger_id')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='station_id') then
    alter table public.sessions rename column charger_id to station_id;
  end if;
end
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  phone text,
  role text not null default 'user' check (role in ('user','admin')),
  wallet_balance numeric(10,2) not null default 2500.00,
  total_sessions integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists role text not null default 'user';
alter table public.profiles add column if not exists wallet_balance numeric(10,2) not null default 2500.00;
alter table public.profiles add column if not exists total_sessions integer not null default 0;
alter table public.profiles add column if not exists created_at timestamptz not null default now();

create table if not exists public.stations (
  id text primary key,
  name text not null,
  location text not null default 'Unknown',
  latitude numeric(9,6),
  longitude numeric(9,6),
  status text not null default 'online' check (status in ('online','charging','offline','disabled')),
  voltage numeric(6,1) not null default 0,
  current numeric(6,1) not null default 0,
  current_kwh numeric(8,3) not null default 0,
  battery_pct integer not null default 50 check (battery_pct between 0 and 100),
  active_user_id uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
alter table public.stations add column if not exists latitude numeric(9,6);
alter table public.stations add column if not exists longitude numeric(9,6);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null,
  user_id uuid not null references public.profiles(id),
  station_id text not null references public.stations(id),
  energy_kwh numeric(8,3) not null default 0,
  unit_rate_pkr numeric(8,2) not null,
  total_bill_pkr numeric(10,2) not null default 0,
  duration_seconds integer not null default 0,
  status text not null default 'active' check (status in ('active','completed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists sessions_user_started_at_idx on public.sessions(user_id, started_at desc);
create index if not exists sessions_station_status_idx on public.sessions(station_id, status);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  amount_pkr numeric(10,2) not null check (amount_pkr >= 0),
  type text not null check (type in ('topup','charge_deduction')),
  description text,
  created_at timestamptz not null default now()
);
create index if not exists transactions_user_created_at_idx on public.transactions(user_id, created_at desc);

create table if not exists public.system_settings (
  id integer primary key default 1 check (id = 1),
  unit_rate_pkr numeric(8,2) not null default 65.00,
  updated_at timestamptz not null default now()
);

insert into public.system_settings(id, unit_rate_pkr) values (1,65.00)
on conflict (id) do nothing;

-- Example Karachi coordinates; verify actual locations before production use.
insert into public.stations
  (id,name,location,latitude,longitude,status,voltage,current,current_kwh,battery_pct)
values
  ('CHG-001','Main Gate Fast Charger','Karachi, Clifton',24.813800,67.030400,'online',0,0,0,42),
  ('CHG-002','Shopping Mall Charger','Karachi, DHA Phase 6',24.801900,67.062100,'online',0,0,0,68),
  ('CHG-003','Airport Express Charger','Karachi International Airport',24.906500,67.160800,'offline',0,0,0,50)
on conflict (id) do update set
  name=excluded.name,
  location=excluded.location,
  latitude=excluded.latitude,
  longitude=excluded.longitude;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id,email,full_name,phone,role,wallet_balance)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name','RideaseVX User'),
    coalesce(new.raw_user_meta_data->>'phone',''),
    'user',
    2500.00
  )
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.updated_at_timestamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists chargers_updated_at on public.stations;
drop trigger if exists stations_updated_at on public.stations;
create trigger stations_updated_at before update on public.stations
for each row execute function public.updated_at_timestamp();

drop trigger if exists settings_updated_at on public.system_settings;
create trigger settings_updated_at before update on public.system_settings
for each row execute function public.updated_at_timestamp();

create or replace function public.start_charging_session(p_station_id text)
returns public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_station public.stations%rowtype;
  v_profile public.profiles%rowtype;
  v_session public.sessions%rowtype;
  v_rate numeric(8,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile from public.profiles where id = v_user_id for update;
  if not found then
    raise exception 'User profile not found';
  end if;
  if v_profile.wallet_balance <= 0 then
    raise exception 'Insufficient wallet balance';
  end if;
  if exists (select 1 from public.sessions where user_id = v_user_id and status = 'active') then
    raise exception 'An active charging session already exists for this user';
  end if;

  select * into v_station from public.stations where id = p_station_id for update;
  if not found or v_station.status in ('offline','disabled','charging') then
    raise exception 'Station is not available';
  end if;

  select unit_rate_pkr into v_rate from public.system_settings where id = 1;
  insert into public.sessions (session_code,user_id,station_id,unit_rate_pkr)
  values (
    'SES-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    v_user_id,
    p_station_id,
    coalesce(v_rate,65.00)
  )
  returning * into v_session;

  update public.stations
  set status='charging', active_user_id=v_user_id
  where id=p_station_id;

  return v_session;
end
$$;
revoke all on function public.start_charging_session(text) from public;
grant execute on function public.start_charging_session(text) to authenticated;

drop function if exists public.complete_charging_session(text,text);
create function public.complete_charging_session(p_station_id text, p_reason text default 'Stopped')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.sessions%rowtype;
  v_is_admin boolean;
  v_bill numeric(10,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  v_is_admin := public.is_admin();
  select * into v_session
  from public.sessions
  where station_id=p_station_id and status='active'
  order by started_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No active session found for this station';
  end if;
  if v_session.user_id <> v_user_id and not v_is_admin then
    raise exception 'Not authorized to complete this session';
  end if;

  v_bill := round(greatest(v_session.energy_kwh,0) * v_session.unit_rate_pkr,2);
  update public.profiles
  set wallet_balance=wallet_balance-v_bill,
      total_sessions=total_sessions+1
  where id=v_session.user_id and wallet_balance >= v_bill;
  if not found then
    raise exception 'Insufficient wallet balance to settle this session';
  end if;

  update public.sessions
  set status='completed',
      ended_at=now(),
      duration_seconds=greatest(0,extract(epoch from (now()-started_at))::integer),
      total_bill_pkr=v_bill
  where id=v_session.id;

  insert into public.transactions(user_id,amount_pkr,type,description)
  values (
    v_session.user_id,
    v_bill,
    'charge_deduction',
    coalesce(p_reason,'Completed') || ' • ' || p_station_id
  );

  update public.stations
  set status='online',voltage=0,current=0,current_kwh=0,active_user_id=null
  where id=p_station_id;

  return jsonb_build_object(
    'ok',true,
    'session_id',v_session.id,
    'bill_pkr',v_bill,
    'station_id',p_station_id
  );
end
$$;
revoke all on function public.complete_charging_session(text,text) from public;
grant execute on function public.complete_charging_session(text,text) to authenticated;

drop function if exists public.top_up_wallet(numeric,text);

alter table public.profiles enable row level security;
alter table public.stations enable row level security;
alter table public.sessions enable row level security;
alter table public.transactions enable row level security;
alter table public.system_settings enable row level security;

drop policy if exists "Public charger read" on public.stations;
drop policy if exists "Admin charger manage" on public.stations;
drop policy if exists "Stations are readable" on public.stations;
drop policy if exists "Admins manage stations" on public.stations;
drop policy if exists "Active users update station telemetry" on public.stations;
drop policy if exists "Users read own profile" on public.profiles;
drop policy if exists "Users update own profile" on public.profiles;
drop policy if exists "Users create own profile" on public.profiles;
drop policy if exists "Profiles are readable by owner or admin" on public.profiles;
drop policy if exists "Users read own sessions" on public.sessions;
drop policy if exists "Users create own sessions" on public.sessions;
drop policy if exists "Admin manage sessions" on public.sessions;
drop policy if exists "Users read own transactions" on public.transactions;
drop policy if exists "Users create own transactions" on public.transactions;
drop policy if exists "Transactions are readable by owner or admin" on public.transactions;
drop policy if exists "Anyone reads tariff" on public.system_settings;
drop policy if exists "Admin updates tariff" on public.system_settings;
drop policy if exists "Tariff is readable" on public.system_settings;
drop policy if exists "Admins update tariff" on public.system_settings;

create policy "Stations are readable" on public.stations
for select using (true);
create policy "Admins manage stations" on public.stations
for all using (public.is_admin()) with check (public.is_admin());

create policy "Profiles are readable by owner or admin" on public.profiles
for select using (id=(select auth.uid()) or public.is_admin());

create policy "Users read own sessions" on public.sessions
for select using (user_id=(select auth.uid()) or public.is_admin());
create policy "Admins manage sessions" on public.sessions
for all using (public.is_admin()) with check (public.is_admin());

create policy "Transactions are readable by owner or admin" on public.transactions
for select using (user_id=(select auth.uid()) or public.is_admin());

create policy "Tariff is readable" on public.system_settings
for select using (true);
create policy "Admins update tariff" on public.system_settings
for all using (public.is_admin()) with check (public.is_admin());

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
revoke all on public.stations from anon, authenticated;
grant select on public.stations to anon, authenticated;
grant insert,update,delete on public.stations to authenticated;
revoke all on public.sessions from anon, authenticated;
grant select on public.sessions to authenticated;
grant update on public.sessions to authenticated;
revoke all on public.transactions from anon, authenticated;
grant select on public.transactions to authenticated;
revoke all on public.system_settings from anon, authenticated;
grant select on public.system_settings to anon, authenticated;
grant update on public.system_settings to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.stations;
exception when duplicate_object then null;
end
$$;
do $$
begin
  alter publication supabase_realtime add table public.sessions;
exception when duplicate_object then null;
end
$$;
do $$
begin
  alter publication supabase_realtime add table public.transactions;
exception when duplicate_object then null;
end
$$;
do $$
begin
  alter publication supabase_realtime add table public.system_settings;
exception when duplicate_object then null;
end
$$;
do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end
$$;
