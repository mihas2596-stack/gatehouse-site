-- Run in the production project after the SMS migration and sender configuration.
-- Vault entry gatehouse_sms_worker must match the production SMS_CRON_SECRET.
begin;
create extension if not exists pg_net;
create extension if not exists pg_cron;
do $$ begin
 if not exists(select 1 from vault.decrypted_secrets where name='gatehouse_sms_worker' and length(decrypted_secret)>0) then
   raise exception 'Configure gatehouse_sms_worker in Vault first';
 end if;
end $$;

create or replace function public.gh_sms_wake_worker() returns void
language plpgsql security definer set search_path='' as $$
declare credential text;
begin
 if not exists(select 1 from public.gh_sms_jobs where state='pending' and due_at<=now() and expires_at>now()) then return; end if;
 select decrypted_secret into strict credential from vault.decrypted_secrets where name='gatehouse_sms_worker';
 perform net.http_get(url:='https://www.gatehousehomecleaning.com/api/visit?sms=1',
   headers:=jsonb_build_object('Authorization','Bearer '||credential),timeout_milliseconds:=55000);
end $$;
revoke all on function public.gh_sms_wake_worker() from public, anon, authenticated, service_role;
create or replace function public.gh_sms_wake_on_insert() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform public.gh_sms_wake_worker();
 return new;
exception when others then
 -- Leave the committed job for the scheduler if the wake-up is unavailable.
 raise warning 'Gatehouse SMS wake-up failed';
 return new;
end $$;
revoke all on function public.gh_sms_wake_on_insert() from public, anon, authenticated, service_role;
drop trigger if exists gh_sms_wake on public.gh_sms_jobs;
create trigger gh_sms_wake after insert on public.gh_sms_jobs for each row
 when (new.due_at<=now()) execute function public.gh_sms_wake_on_insert();
select cron.schedule('gatehouse-sms-dispatch','* * * * *','select public.gh_sms_wake_worker()');
commit;
