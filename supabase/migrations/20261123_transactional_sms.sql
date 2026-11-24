begin;
-- A booking opt-in travels in the same INSERT as its visit. No legacy consent is inferred.
alter table gh_visits add column sms_opt_in_phone text check (sms_opt_in_phone ~ '^\+1[2-9][0-9]{9}$');
create table gh_sms_consents (
  audience text not null check (audience in ('client','cleaner')), subject uuid not null,
  phone text not null check (phone ~ '^\+1[2-9][0-9]{9}$'), source text not null,
  version text not null, granted_at timestamptz not null default now(),
  primary key(audience, subject, phone)
);
create table gh_sms_blocks (phone text primary key, blocked boolean not null, changed_at timestamptz not null default now());
create table gh_sms_keywords (sid text primary key, keyword text not null, received_at timestamptz not null default now());
create table gh_sms_jobs (
  id uuid primary key default gen_random_uuid(), visit_id uuid not null references gh_visits on delete cascade,
  kind text not null, audience text not null, subject uuid not null, phone text not null,
  schedule_date date, arrival text, cleaner uuid, report_at timestamptz, intent text,
  due_at timestamptz not null, expires_at timestamptz not null,
  state text not null default 'pending', attempts int not null default 0, attempted_at timestamptz,
  sid text unique, error_code text, delivery text
);
create unique index gh_sms_request_once on gh_sms_jobs(visit_id) where kind='received';
create unique index gh_sms_report_once on gh_sms_jobs(visit_id,kind,subject,report_at) where kind in ('complete','payment_reminder');
create unique index gh_sms_receipt_once on gh_sms_jobs(visit_id,intent) where kind='paid';
create index gh_sms_due on gh_sms_jobs(due_at) where state='pending';
create index gh_sms_rate on gh_sms_jobs(phone,attempted_at);
create table gh_sms_history (
  id bigint generated always as identity primary key, job uuid references gh_sms_jobs on delete cascade,
  state text not null, error_code text, recorded_at timestamptz not null default now()
);
alter table gh_sms_jobs enable row level security;
alter table gh_sms_consents enable row level security;
alter table gh_sms_blocks enable row level security;
alter table gh_sms_keywords enable row level security;
alter table gh_sms_history enable row level security;

create function gh_sms_start(d date,w text) returns timestamptz language plpgsql stable as $$
declare t time; m text[]; h int;
begin
 case lower(trim(w))
 when 'morning' then t := '07:00';
 when 'midday' then t := '11:00';
 when 'afternoon' then t := '14:00';
 else
   m := regexp_match(replace(upper(trim(w)),' TO ','-'), '^([0-9]{1,2})(?::([0-5][0-9]))?\s*(AM|PM)?\s*[-–—]\s*([0-9]{1,2})(?::[0-5][0-9])?\s*(AM|PM)?$');
   if m is null then return null; end if;
   h := m[1]::int;
   if coalesce(m[3],m[5]) is not null then
     if h not between 1 and 12 then return null; end if;
     if m[3] is null and h%12 > m[4]::int%12 then
       if m[5]='PM' and h between 7 and 11 and m[4]::int in (12,1,2,3,4,5,6) then m[3]:='AM'; else return null; end if;
     end if;
     h := h%12 + case when coalesce(m[3],m[5])='PM' then 12 else 0 end;
   elsif h>23 then return null;
   end if;
   t := make_time(h,coalesce(m[2],'0')::int,0);
 end case;
 return (d+t) at time zone 'America/New_York';
end $$;

create function gh_sms_assignee(v gh_visits) returns uuid language sql stable as $$
 select case when v.reclean_status='scheduled' and v.reclean_cleaner_id is not null then
 (select id from gh_cleaners where id::text=v.reclean_cleaner_id) else v.cleaner_id end;
$$;

create function gh_sms_enqueue(v gh_visits,k text,a text,due timestamptz,expires timestamptz) returns void language sql as $$
 insert into gh_sms_jobs(visit_id,kind,audience,subject,phone,schedule_date,arrival,cleaner,report_at,intent,due_at,expires_at)
 select v.id,k,a,c.subject,c.phone,v.visit_date,v."window",gh_sms_assignee(v),v.report_sent_at,v.payment_intent_id,due,expires
 from gh_sms_consents c where c.audience=a and due is not null and expires>now()
 and c.subject=case when a='client' then v.id else gh_sms_assignee(v) end
 and not exists(select from gh_sms_blocks b where b.phone=c.phone and b.blocked)
 and (a='client' or exists(select from gh_cleaners r where r.id=c.subject and r.active and
 right(regexp_replace(r.phone,'[^0-9]','','g'),10)=right(c.phone,10))) on conflict do nothing;
$$;

create function gh_sms_visit_changed() returns trigger language plpgsql as $$
declare due timestamptz; changed boolean; assigned boolean;
begin
 if tg_op='INSERT' then
   if new.sms_opt_in_phone is not null then
     insert into gh_sms_consents values ('client',new.id,new.sms_opt_in_phone,'booking','2026-11-23',now());
   end if;
   return new;
 end if;
 changed := (new.visit_date,new."window") is distinct from (old.visit_date,old."window");
 assigned := new.cleaner_id is distinct from old.cleaner_id;
 if changed or assigned or new.status='cancelled' then
   update gh_sms_jobs set state='obsolete' where visit_id=new.id and state='pending'
   and (kind in ('assigned','cleaner_action') or (kind='reminder' and (audience='cleaner' or changed or new.status='cancelled')) or ((changed or new.status='cancelled') and kind in ('confirmed','rescheduled')));
 end if;
 if assigned and new.cleaner_id is not null and new.status<>'cancelled' then
   perform gh_sms_enqueue(new,'assigned','client',now(),now()+interval '1 day');
   perform gh_sms_enqueue(new,'assigned','cleaner',now(),now()+interval '1 day');
 end if;
 if new.status='confirmed' and old.status='confirmed' and assigned and not changed then
   due := gh_sms_start(new.visit_date,new."window")-interval '24 hours';
   perform gh_sms_enqueue(new,'reminder','cleaner',due,due+interval '1 hour');
 end if;
 if new.report_email_id is not null and new.report_status='sent' and
 (new.report_email_id,new.report_sent_at) is distinct from (old.report_email_id,old.report_sent_at) then
   perform gh_sms_enqueue(new,'complete','client',now(),new.report_sent_at+interval '20 hours');
   perform gh_sms_enqueue(new,'payment_reminder','client',new.report_sent_at+interval '20 hours',new.report_sent_at+interval '24 hours');
 end if;
 if new.issue_open and not old.issue_open then perform gh_sms_enqueue(new,'issue','client',now(),now()+interval '1 day'); end if;
 if new.report_status='returned' and old.report_status is distinct from 'returned' then
   perform gh_sms_enqueue(new,'report_returned','cleaner',now(),now()+interval '1 day');
 end if;
 if new.reclean_status='scheduled' and (new.reclean_status,new.reclean_date,new.reclean_cleaner_id) is distinct from (old.reclean_status,old.reclean_date,old.reclean_cleaner_id)
 then perform gh_sms_enqueue(new,'cleaner_action','cleaner',now(),now()+interval '1 day'); end if;
 if new.status='cancelled' and old.status<>'cancelled' then perform gh_sms_enqueue(new,'cancelled','cleaner',now(),now()+interval '1 day'); end if;
 if new.status='paid' and new.paid_at is not null and new.payment_intent_id is not null
 and (old.status,old.payment_intent_id) is distinct from (new.status,new.payment_intent_id)
 then perform gh_sms_enqueue(new,'paid','client',now(),now()+interval '2 days'); end if;
 return new;
end $$;
create trigger gh_sms_visit after insert or update on gh_visits for each row execute function gh_sms_visit_changed();

-- The customer's acceptance of an alternative date writes an agreement event
-- without changing row.status to confirmed. Both owner and client use this journal.
create function gh_sms_agreement() returns trigger language plpgsql as $$
declare v gh_visits; prior gh_events; k text; due timestamptz;
begin
 select * into v from gh_visits where id=new.visit_id for update;
 if v.status in ('cancelled','paid','refunded') or v.report_status in ('submitted','sent') or
 v.visit_date::text is distinct from new.detail->>'date' then return new; end if;
 select * into prior from gh_events where visit_id=v.id and event='visit_confirmed' and id<new.id order by id desc limit 1;
 if found and (prior.detail->>'date',prior.detail->>'window') is not distinct from (new.detail->>'date',new.detail->>'window') then return new; end if;
 k:=case when prior.id is null then 'confirmed' else 'rescheduled' end;
 update gh_sms_jobs set state='obsolete' where visit_id=v.id and kind in ('confirmed','rescheduled','reminder') and state='pending';
 perform gh_sms_enqueue(v,k,'client',now(),now()+interval '1 day');
 if k='rescheduled' then perform gh_sms_enqueue(v,k,'cleaner',now(),now()+interval '1 day'); end if;
 due:=gh_sms_start(v.visit_date,v."window")-interval '24 hours';
 perform gh_sms_enqueue(v,'reminder','client',due,due+interval '1 hour');
 perform gh_sms_enqueue(v,'reminder','cleaner',due,due+interval '1 hour');
 return new;
end $$;
create trigger gh_sms_agreement after insert on gh_events for each row when (new.event='visit_confirmed') execute function gh_sms_agreement();

-- A corrected phone number invalidates prior customer opt-in and all outstanding links.
create function gh_sms_contact_changed() returns trigger language plpgsql as $$
declare v gh_visits;
begin
 update gh_visits set sms_opt_in_phone=null where id=new.visit_id and sms_opt_in_phone is not null
 and right(sms_opt_in_phone,10) is distinct from right(regexp_replace(new.detail->>'phone','[^0-9]','','g'),10);
 -- Contact persistence follows natural-key deduplication in the booking handler.
 select * into v from gh_visits where id=new.visit_id;
 if new.actor='client' and v.sms_opt_in_phone is not null and v.visit_no=1 and v.status='requested' then
   perform gh_sms_enqueue(v,'received','client',now(),now()+interval '1 day');
 end if;
 return new;
end $$;
create trigger gh_sms_contact after insert on gh_events for each row when (new.event='client_contact') execute function gh_sms_contact_changed();

create function gh_sms_cleaner_consent(visit uuid, token_hash text, disclosure text) returns boolean language plpgsql as $$
declare v gh_visits; r gh_cleaners; n text;
begin
 select * into v from gh_visits where id=visit and cleaner_token_hash=token_hash
 and cleaner_token_expires>now() and status not in ('cancelled','paid') for share;
 select * into r from gh_cleaners where id=gh_sms_assignee(v) and active for share;
 n:=regexp_replace(r.phone,'[^0-9]','','g');
 if n ~ '^1[0-9]{10}$' then n:=substr(n,2); end if;
 if n is null or n !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' or disclosure is distinct from '2026-11-23' then return false; end if;
 insert into gh_sms_consents values ('cleaner',r.id,'+1'||n,'cleaner_portal',disclosure,now()) on conflict do nothing;
 if found and v.reclean_status='scheduled' then
   perform gh_sms_enqueue(v,'cleaner_action','cleaner',now(),now()+interval '1 day');
 elsif found and v.status='confirmed' then
   perform gh_sms_enqueue(v,'assigned','cleaner',now(),now()+interval '1 day');
   perform gh_sms_enqueue(v,'reminder','cleaner',gh_sms_start(v.visit_date,v."window")-interval '24 hours',gh_sms_start(v.visit_date,v."window")-interval '23 hours');
 end if;
 return true;
end $$;

create function gh_sms_eligible(j gh_sms_jobs,v gh_visits) returns boolean language sql stable as $$
 select j.expires_at>now() and exists(select from gh_sms_consents where audience=j.audience and subject=j.subject and phone=j.phone)
 and not exists(select from gh_sms_blocks where phone=j.phone and blocked)
 and (j.audience<>'client' or v.sms_opt_in_phone=j.phone)
 and (j.audience='client' or (j.cleaner=gh_sms_assignee(v) and exists(select from gh_cleaners r where r.active and r.id=gh_sms_assignee(v)
 and right(regexp_replace(r.phone,'[^0-9]','','g'),10)=right(j.phone,10))))
 and case
 when j.kind='received' then v.status in ('requested','scheduled','card_ready') and
 not exists(select from gh_events where visit_id=v.id and event='visit_confirmed')
 when j.kind='paid' then v.status='paid' and v.paid_at is not null and v.payment_intent_id=j.intent and v.amount_cents>0
 when j.kind='cancelled' then v.status='cancelled'
 when j.kind='issue' then v.issue_open and v.paid_at is null
 when j.kind='report_returned' then v.status<>'cancelled' and v.report_status='returned'
 when j.kind='cleaner_action' then v.status<>'cancelled' and v.reclean_status='scheduled' and v.reclean_cleaner_id=j.subject::text
 when j.kind in ('complete','payment_reminder') then v.status='report_sent' and v.report_status='sent' and
 v.report_sent_at=j.report_at and v.report_email_id is not null and not v.report_bounced and not v.issue_open and v.paid_at is null
 and (j.kind='complete' or (v.visit_date<=(now() at time zone 'America/New_York')::date and not v.issue_ever and not v.charge_waived and v.payment_intent_id is null and
 not exists(select from gh_events e where e.visit_id=v.id and (e.event='issue_opened' or
 (e.created_at>=v.report_sent_at and e.event in ('report_approved','payment_unknown','payment_unconfirmed','payment_create_unknown'))))))
 when j.kind in ('confirmed','rescheduled','assigned','reminder') then
 (v.status='confirmed' or (v.status in ('requested','scheduled','card_ready') and (j.kind='assigned' or
 exists(select from gh_events e where e.visit_id=v.id and e.event='visit_confirmed' and e.detail->>'date'=v.visit_date::text)))) and v.visit_date >= (now() at time zone 'America/New_York')::date and
 (j.kind<>'reminder' or v.visit_date=(now() at time zone 'America/New_York')::date+1) and
 (j.kind<>'assigned' or v.cleaner_id=j.cleaner) and v.visit_date=j.schedule_date and v."window" is not distinct from j.arrival
 else false end;
$$;
-- Atomically reserve a single attempt, with per-phone serialization. An ambiguous provider acceptance is never resent.
create function gh_sms_claim() returns jsonb language plpgsql as $$
declare j gh_sms_jobs; v gh_visits;
begin
 delete from gh_sms_jobs where expires_at<now()-interval '30 days';
 update gh_sms_jobs set state='expired' where state='pending' and expires_at<=now();
 update gh_sms_jobs set state='unknown' where state='sending' and attempted_at<now()-interval '10 minutes';
 for j in select * from gh_sms_jobs where state='pending' and due_at<=now() order by due_at,id limit 20 for update skip locked loop
   if not pg_try_advisory_xact_lock(hashtext(j.phone)) then continue; end if;
   select * into v from gh_visits where id=j.visit_id;
   if not coalesce(gh_sms_eligible(j,v),false) then update gh_sms_jobs set state='obsolete' where id=j.id; continue; end if;
   if (select count(*) from gh_sms_jobs where phone=j.phone and attempted_at>now()-interval '1 hour')>=8 then
     update gh_sms_jobs set due_at=now()+interval '5 minutes' where id=j.id; continue;
   end if;
   update gh_sms_jobs set state='sending',attempted_at=now(),attempts=attempts+1 where id=j.id;
   return jsonb_build_object('id',j.id,'phone',j.phone);
 end loop;
 return '{}'::jsonb;
end $$;
create function gh_sms_payload(job uuid) returns jsonb language sql stable as $$
 select coalesce((select jsonb_build_object('id',j.id,'kind',j.kind,'audience',j.audience,'phone',j.phone,'visit',v.id,'booking',v.booking_id,
 'date',v.visit_date,'window',v."window",'name',split_part(trim(v.cleaner_name),' ',1),'email',v.client_email,'amount',v.amount_cents,
 'issuance',v.cleaner_link_issuance,'hash',v.cleaner_token_hash,'expiry',v.cleaner_token_expires,'test',v.is_test)
 from gh_sms_jobs j join gh_visits v on v.id=j.visit_id where j.id=job and j.state='sending' and gh_sms_eligible(j,v)
 and (j.audience<>'client' or not exists(select from gh_visits newer where newer.booking_id=v.booking_id and newer.visit_no>v.visit_no))), '{}'::jsonb);
$$;
create function gh_sms_finish(job uuid,result text,provider_sid text,code text) returns boolean language plpgsql as $$
begin
 update gh_sms_jobs set state=case when result='retry' and attempts<4 then 'pending' when result='retry' then 'failed' else result end,
 due_at=case when result='retry' then now()+interval '1 minute'*power(2,attempts) else due_at end,
 sid=coalesce(sid,provider_sid),error_code=code where id=job and state in ('sending','unknown') and (sid is null or sid=provider_sid);
 return true;
end $$;
create function gh_sms_delivery(job uuid,provider_sid text,delivery_status text,code text) returns boolean language plpgsql as $$
begin
 update gh_sms_jobs set sid=provider_sid,state='accepted',delivery=delivery_status,error_code=code
 where id=job and state in ('sending','unknown','accepted') and (sid is null or sid=provider_sid)
 and coalesce(delivery,'') not in ('delivered','undelivered','failed') and (delivery is distinct from delivery_status)
 and array_position(array['queued','sending','sent','delivered','undelivered','failed'],delivery_status)
 >= coalesce(array_position(array['queued','sending','sent','delivered','undelivered','failed'],delivery),0);
 if found and code in ('21610','30630') then
   insert into gh_sms_blocks select phone,true,now() from gh_sms_jobs where id=job
   on conflict(phone) do update set blocked=true,changed_at=now();
 end if;
 return true;
end $$;
create function gh_sms_keyword(provider_sid text,number text,command text,event_time timestamptz default null) returns boolean language plpgsql as $$
begin
 insert into gh_sms_keywords values(provider_sid,command,now()) on conflict do nothing;
 if not found then return true; end if;
 if command in ('STOP','START') then
   insert into gh_sms_blocks values(number,command='STOP',coalesce(event_time,now()))
   on conflict(phone) do update set blocked=excluded.blocked,changed_at=excluded.changed_at
   where excluded.changed_at>gh_sms_blocks.changed_at or (excluded.changed_at=gh_sms_blocks.changed_at and excluded.blocked);
   if command='STOP' then update gh_sms_jobs set state='suppressed' where phone=number and state='pending'; end if;
 end if;
 return true;
end $$;
create function gh_sms_track() returns trigger language plpgsql as $$
begin
 if (old.state,old.delivery,old.attempts) is distinct from (new.state,new.delivery,new.attempts) then
 insert into gh_sms_history(job,state,error_code) values(new.id,coalesce(new.delivery,new.state),new.error_code);
 end if;
 return new;
end $$;
create trigger gh_sms_track after update on gh_sms_jobs for each row execute function gh_sms_track();
create function gh_sms_link(job uuid) returns jsonb language sql stable as $$
 select jsonb_build_object('id',j.id,'kind',j.kind,'audience',j.audience,'visit',v.id,'booking',v.booking_id,'email',v.client_email,
 'issuance',v.cleaner_link_issuance,'hash',v.cleaner_token_hash,'expiry',v.cleaner_token_expires)
 from gh_sms_jobs j join gh_visits v on v.id=j.visit_id where j.id=job and j.state in ('sending','accepted','unknown')
 and exists(select from gh_sms_consents where audience=j.audience and subject=j.subject and phone=j.phone)
 and not exists(select from gh_sms_blocks where phone=j.phone and blocked)
 and ((j.audience='client' and v.sms_opt_in_phone=j.phone and not exists(select from gh_visits newer where newer.booking_id=v.booking_id and newer.visit_no>v.visit_no))
 or (j.audience='cleaner' and gh_sms_assignee(v)=j.subject and v.status<>'cancelled' and v.cleaner_token_expires>now()
 and exists(select from gh_cleaners r where r.id=gh_sms_assignee(v) and r.active and right(regexp_replace(r.phone,'[^0-9]','','g'),10)=right(j.phone,10))));
$$;
do $$ declare f regprocedure; begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname like 'gh_sms_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
grant select,insert,update,delete on gh_sms_jobs,gh_sms_consents,gh_sms_keywords,gh_sms_blocks,gh_sms_history to service_role;
grant usage on sequence gh_sms_history_id_seq to service_role;
commit;
