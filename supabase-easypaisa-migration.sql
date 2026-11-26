-- Apply once in Supabase SQL Editor after backing up the project.
-- Existing wallet_balance values remain untouched but are never spendable.
-- Only manually verified Easypaisa payments populate paid_balance.

alter table public.profiles
  add column if not exists paid_balance numeric(10,2) not null default 0.00;
alter table public.profiles
  alter column paid_balance set default 0.00;
alter table public.sessions
  add column if not exists budget_pkr numeric(10,2) not null default 0.00;
alter table public.stations
  add column if not exists power_kw numeric(8,3) not null default 0;
alter table public.stations
  add column if not exists device_last_seen_at timestamptz;
alter table public.stations
  alter column battery_pct drop not null;
update public.stations set battery_pct=null;

create table if not exists public.easypaisa_payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  transaction_id text not null,
  paid_amount_pkr numeric(10,2) not null check (paid_amount_pkr > 0),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  constraint easypaisa_transaction_id_not_blank check (length(btrim(transaction_id)) > 0)
);

alter table public.easypaisa_payment_requests
  add column if not exists verified_method text
  check (verified_method in ('admin','auto'));

create unique index if not exists easypaisa_payment_tid_unique
  on public.easypaisa_payment_requests (lower(btrim(transaction_id)));
create index if not exists easypaisa_payment_requests_user_created_idx
  on public.easypaisa_payment_requests (user_id, created_at desc);
create index if not exists easypaisa_payment_requests_status_created_idx
  on public.easypaisa_payment_requests (status, created_at);
create unique index if not exists sessions_one_active_per_user_idx
  on public.sessions (user_id) where status='active';
create unique index if not exists sessions_one_active_per_station_idx
  on public.sessions (station_id) where status='active';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id,email,full_name,phone,role,wallet_balance,paid_balance)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name','RideaseVX User'),
    coalesce(new.raw_user_meta_data->>'phone',''),
    'user',
    0.00,
    0.00
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and lower(coalesce(auth.jwt()->>'email',''))='mir.63059@iqra.edu.pk';
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

update public.profiles
set role=case
  when lower(coalesce(email,''))='mir.63059@iqra.edu.pk' then 'admin'
  else 'user'
end
where role is distinct from case
  when lower(coalesce(email,''))='mir.63059@iqra.edu.pk' then 'admin'
  else 'user'
end;

drop function if exists public.start_charging_session(text);
create or replace function public.start_charging_session(
  p_station_id text,
  p_budget_pkr numeric
)
returns public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_station public.stations%rowtype;
  v_session public.sessions%rowtype;
  v_rate numeric(8,2);
  v_budget numeric(10,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if p_budget_pkr is null or p_budget_pkr <= 0 or p_budget_pkr <> round(p_budget_pkr,2) then
    raise exception 'Enter a positive charging budget with at most two decimal places';
  end if;

  v_budget := p_budget_pkr;
  select * into v_profile
  from public.profiles
  where id=v_user_id
  for update;
  if not found then
    raise exception 'User profile not found';
  end if;
  if v_profile.paid_balance < v_budget then
    raise exception 'Insufficient verified Easypaisa balance';
  end if;
  if exists (
    select 1 from public.sessions
    where user_id=v_user_id and status='active'
  ) then
    raise exception 'An active charging session already exists for this user';
  end if;

  select * into v_station
  from public.stations
  where id=p_station_id
  for update;
  if not found or v_station.status in ('offline','disabled','charging') then
    raise exception 'Station is not available';
  end if;
  if v_station.device_last_seen_at is null
     or v_station.device_last_seen_at < now()-interval '15 seconds' then
    raise exception 'Charger device is offline. Wait for its live heartbeat before starting';
  end if;

  select unit_rate_pkr into v_rate
  from public.system_settings
  where id=1;
  if v_rate is null or v_rate <= 0 then
    raise exception 'Charging tariff is unavailable';
  end if;

  update public.profiles
  set paid_balance=paid_balance-v_budget
  where id=v_user_id;

  insert into public.sessions (
    session_code,user_id,station_id,unit_rate_pkr,budget_pkr
  )
  values (
    'SES-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
    v_user_id,p_station_id,v_rate,v_budget
  )
  returning * into v_session;

  update public.stations
  set status='charging',active_user_id=v_user_id
  where id=p_station_id;

  return v_session;
end
$$;
revoke all on function public.start_charging_session(text,numeric) from public, anon;
grant execute on function public.start_charging_session(text,numeric) to authenticated;

create or replace function public.settle_charging_session(
  p_session_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions%rowtype;
  v_bill numeric(10,2);
  v_refund numeric(10,2);
begin
  select * into v_session
  from public.sessions
  where id=p_session_id and status='active'
  for update;
  if not found then
    raise exception 'Active charging session not found';
  end if;
  if v_session.budget_pkr <= 0 then
    raise exception 'This session has no verified paid budget and cannot be billed';
  end if;

  v_bill := least(
    round(greatest(v_session.energy_kwh,0)*v_session.unit_rate_pkr,2),
    v_session.budget_pkr
  );
  v_refund := v_session.budget_pkr-v_bill;

  update public.profiles
  set paid_balance=paid_balance+v_refund,
      total_sessions=total_sessions+1
  where id=v_session.user_id;
  if not found then
    raise exception 'User profile not found while settling charging session';
  end if;

  update public.sessions
  set status='completed',
      ended_at=now(),
      duration_seconds=greatest(0,extract(epoch from (now()-started_at))::integer),
      total_bill_pkr=v_bill
  where id=v_session.id;

  if v_bill > 0 then
    insert into public.transactions(user_id,amount_pkr,type,description)
    values (
      v_session.user_id,
      v_bill,
      'charge_deduction',
      coalesce(p_reason,'Completed') || ' • ' || v_session.station_id
    );
  end if;

  update public.stations
  set status=case when status='disabled' then 'disabled' else 'online' end,
      voltage=0,current=0,current_kwh=0,active_user_id=null
  where id=v_session.station_id;

  return jsonb_build_object(
    'ok',true,
    'session_id',v_session.id,
    'bill_pkr',v_bill,
    'refund_pkr',v_refund,
    'station_id',v_session.station_id
  );
end
$$;
revoke all on function public.settle_charging_session(uuid,text) from public, anon, authenticated;

create or replace function public.complete_charging_session(
  p_station_id text,
  p_reason text default 'Stopped'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.sessions%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_session
  from public.sessions
  where station_id=p_station_id and status='active'
  for update;
  if not found then
    raise exception 'No active session found for this station';
  end if;
  if v_session.user_id<>v_user_id and not public.is_admin() then
    raise exception 'Not authorized to complete this session';
  end if;
  return public.settle_charging_session(v_session.id,p_reason);
end
$$;
revoke all on function public.complete_charging_session(text,text) from public, anon;
grant execute on function public.complete_charging_session(text,text) to authenticated;

create or replace function public.submit_easypaisa_payment(
  p_transaction_id text,
  p_paid_amount_pkr numeric
)
returns public.easypaisa_payment_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.easypaisa_payment_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_transaction_id is null or length(btrim(p_transaction_id)) not between 1 and 100 then
    raise exception 'Enter a valid Easypaisa transaction ID';
  end if;
  if p_paid_amount_pkr is null
     or p_paid_amount_pkr<=0
     or p_paid_amount_pkr>1000000
     or p_paid_amount_pkr<>round(p_paid_amount_pkr,2) then
    raise exception 'Enter a valid payment amount in PKR';
  end if;

  insert into public.easypaisa_payment_requests(user_id,transaction_id,paid_amount_pkr)
  values (auth.uid(),btrim(p_transaction_id),p_paid_amount_pkr)
  returning * into v_request;
  return v_request;
exception
  when unique_violation then
    raise exception 'This Easypaisa TID has already been submitted';
end
$$;
revoke all on function public.submit_easypaisa_payment(text,numeric) from public, anon;
grant execute on function public.submit_easypaisa_payment(text,numeric) to authenticated;

create or replace function public.review_easypaisa_payment(
  p_payment_id uuid,
  p_approve boolean
)
returns public.easypaisa_payment_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.easypaisa_payment_requests%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;
  if p_approve is null then
    raise exception 'Choose approve or reject';
  end if;

  select * into v_request
  from public.easypaisa_payment_requests
  where id=p_payment_id
  for update;
  if not found then
    raise exception 'Payment request not found';
  end if;
  if v_request.status<>'pending' then
    raise exception 'This payment request has already been reviewed';
  end if;

  if p_approve then
    update public.profiles
    set paid_balance=paid_balance+v_request.paid_amount_pkr
    where id=v_request.user_id;
    if not found then
      raise exception 'Payment owner profile not found';
    end if;
    insert into public.transactions(user_id,amount_pkr,type,description)
    values (
      v_request.user_id,
      v_request.paid_amount_pkr,
      'topup',
      'Verified Easypaisa TID ' || v_request.transaction_id
    );
  end if;

  update public.easypaisa_payment_requests
  set status=case when p_approve then 'approved' else 'rejected' end,
      verified_at=now(),
      verified_by=auth.uid(),
      verified_method='admin'
  where id=p_payment_id
  returning * into v_request;
  return v_request;
end
$$;
revoke all on function public.review_easypaisa_payment(uuid,boolean) from public, anon;
grant execute on function public.review_easypaisa_payment(uuid,boolean) to authenticated;

-- Approves every pending TID older than 120 seconds (database clock), crediting
-- its exact submitted amount once. Rows are locked and status is flipped in the
-- same transaction, so repeated polls, concurrent clients, or a later admin click
-- cannot credit the same request twice.
create or replace function public.apply_stale_easypaisa_auto_approvals()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.easypaisa_payment_requests%rowtype;
  v_count integer := 0;
begin
  for v_request in
    select * from public.easypaisa_payment_requests
    where status='pending'
      and created_at <= now() - interval '120 seconds'
    order by created_at
    for update skip locked
  loop
    update public.profiles
    set paid_balance=paid_balance+v_request.paid_amount_pkr
    where id=v_request.user_id;

    insert into public.transactions(user_id,amount_pkr,type,description)
    values (
      v_request.user_id,
      v_request.paid_amount_pkr,
      'topup',
      'Auto-verified Easypaisa TID ' || v_request.transaction_id
    );

    update public.easypaisa_payment_requests
    set status='approved',
        verified_at=now(),
        verified_by=null,
        verified_method='auto'
    where id=v_request.id;

    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;
revoke all on function public.apply_stale_easypaisa_auto_approvals() from public, anon, authenticated;
grant execute on function public.apply_stale_easypaisa_auto_approvals() to service_role;

-- Client-callable wrapper used by the app's polling timer. The 120-second
-- threshold is fixed server-side and cannot be shortened by the caller.
create or replace function public.auto_approve_stale_easypaisa_payments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  return public.apply_stale_easypaisa_auto_approvals();
end
$$;
revoke all on function public.auto_approve_stale_easypaisa_payments() from public, anon;
grant execute on function public.auto_approve_stale_easypaisa_payments() to authenticated;

-- Optional: server-side sweep every minute when pg_cron is enabled in Supabase
-- (Database > Extensions). Without it, the app's polling timer still applies the rule.
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname='easypaisa-auto-approve';
    perform cron.schedule(
      'easypaisa-auto-approve',
      '* * * * *',
      'select public.apply_stale_easypaisa_auto_approvals()'
    );
  end if;
end
$$;

drop function if exists public.record_charging_telemetry(uuid,numeric,numeric,numeric,integer);
create or replace function public.record_charging_telemetry(
  p_session_id uuid,
  p_energy_kwh numeric,
  p_voltage numeric,
  p_current numeric,
  p_power_kw numeric,
  p_battery_pct integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions%rowtype;
  v_bill numeric(10,2);
begin
  if coalesce(auth.role(),'')<>'service_role'
     and (auth.uid() is null or not public.is_admin()) then
    raise exception 'Trusted charger telemetry access is required';
  end if;
  if p_energy_kwh is null or p_energy_kwh<0
     or p_voltage is null or p_voltage<0
     or p_current is null or p_current<0
     or p_power_kw is null or p_power_kw<0
     or (p_battery_pct is not null and p_battery_pct not between 0 and 100) then
    raise exception 'Invalid charging telemetry';
  end if;

  select * into v_session
  from public.sessions
  where id=p_session_id and status='active'
  for update;
  if not found then
    raise exception 'Active charging session not found';
  end if;
  if v_session.budget_pkr <= 0 or v_session.unit_rate_pkr <= 0 then
    raise exception 'Session has no valid paid budget or tariff';
  end if;
  if p_energy_kwh<v_session.energy_kwh then
    raise exception 'Charger energy readings cannot move backwards';
  end if;

  v_bill:=least(
    round(p_energy_kwh*v_session.unit_rate_pkr,2),
    v_session.budget_pkr
  );
  update public.sessions
  set energy_kwh=least(p_energy_kwh,v_session.budget_pkr/v_session.unit_rate_pkr),
      total_bill_pkr=v_bill,
      duration_seconds=greatest(0,extract(epoch from (now()-started_at))::integer)
  where id=v_session.id;
  update public.stations
  set voltage=p_voltage,
      current=p_current,
      power_kw=p_power_kw,
      current_kwh=least(p_energy_kwh,v_session.budget_pkr/v_session.unit_rate_pkr),
      battery_pct=coalesce(p_battery_pct,battery_pct)
  where id=v_session.station_id;

  if v_bill>=v_session.budget_pkr then
    return public.settle_charging_session(v_session.id,'Paid session budget reached');
  end if;
  return jsonb_build_object(
    'ok',true,
    'session_id',v_session.id,
    'bill_pkr',v_bill,
    'remaining_pkr',v_session.budget_pkr-v_bill,
    'stop_required',false
  );
end
$$;
revoke all on function public.record_charging_telemetry(uuid,numeric,numeric,numeric,numeric,integer) from public, anon;
grant execute on function public.record_charging_telemetry(uuid,numeric,numeric,numeric,numeric,integer) to authenticated, service_role;

alter table public.easypaisa_payment_requests enable row level security;
drop policy if exists "Users read own Easypaisa payment requests" on public.easypaisa_payment_requests;
drop policy if exists "Admins read all Easypaisa payment requests" on public.easypaisa_payment_requests;
create policy "Users read own Easypaisa payment requests"
  on public.easypaisa_payment_requests for select
  using (user_id=(select auth.uid()));
create policy "Admins read all Easypaisa payment requests"
  on public.easypaisa_payment_requests for select
  using (public.is_admin());

revoke all on public.easypaisa_payment_requests from anon, authenticated;
grant select on public.easypaisa_payment_requests to authenticated;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
revoke all on public.sessions from anon, authenticated;
grant select on public.sessions to authenticated;
revoke all on public.transactions from anon, authenticated;
grant select on public.transactions to authenticated;
revoke all on public.stations from anon, authenticated;
grant select on public.stations to anon, authenticated;
grant insert,update,delete on public.stations to authenticated;
revoke all on public.system_settings from anon, authenticated;
grant select on public.system_settings to anon, authenticated;
grant update on public.system_settings to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.easypaisa_payment_requests;
exception when duplicate_object then null;
end
$$;

notify pgrst, 'reload schema';
