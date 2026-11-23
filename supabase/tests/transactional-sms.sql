-- Run on an isolated database after schema.sql and migrations. All fixtures roll back.
begin;
do $$
declare v uuid; roster uuid; other uuid; n int; j uuid; claims jsonb; reminder gh_sms_jobs; snapshot gh_visits; record_sid text:='SM'||repeat('a',32);
begin
 insert into gh_visits(booking_id,status) values('sms-qa-without-consent','requested') returning id into v;
 assert not exists(select from gh_sms_consents where subject=v);
 insert into gh_visits(booking_id,status,sms_opt_in_phone,client_email,amount_cents)
 values('sms-qa','requested','+14045550123','qa@example.invalid',2500) returning id into v;
 insert into gh_cleaners(name,phone) values('Cleaner A','404-555-0111') returning id into roster;
 insert into gh_cleaners(name,phone) values('Cleaner B','404-555-0222') returning id into other;
 update gh_visits set cleaner_id=roster,cleaner_name='Cleaner A',visit_date=current_date+4,"window"='8–10 AM',
 cleaner_token_expires=now()+interval '8 days',cleaner_token_hash='fixture',status='confirmed' where id=v;
 assert not gh_sms_cleaner_consent(v,'wrong','2026-11-23');
 assert gh_sms_cleaner_consent(v,'fixture','2026-11-23');
 insert into gh_events(visit_id,actor,event,detail) values(v,'owner','visit_confirmed',jsonb_build_object('date',current_date+4,'window','8–10 AM'));
 insert into gh_events(visit_id,actor,event,detail) values(v,'owner','visit_confirmed',jsonb_build_object('date',current_date+4,'window','8–10 AM'));
 assert (select count(*)=1 from gh_sms_jobs where visit_id=v and kind='confirmed');
 assert (select count(*)=2 from gh_sms_jobs where visit_id=v and kind='reminder' and state='pending');
 assert gh_sms_start('2026-07-15','8–10 AM')='2026-07-15 12:00:00+00'::timestamptz;
 assert gh_sms_start('2026-11-24','8–10 AM')='2026-11-24 13:00:00+00'::timestamptz;
 update gh_visits set visit_date=current_date+2 where id=v;
 insert into gh_events(visit_id,actor,event,detail) values(v,'client','visit_confirmed',jsonb_build_object('date',current_date+2,'window','8–10 AM'));
 assert (select count(*)=2 from gh_sms_jobs where visit_id=v and kind='rescheduled' and state='pending');
 select * into reminder from gh_sms_jobs where visit_id=v and kind='rescheduled' and audience='cleaner';
 update gh_visits set cleaner_id=other where id=v;
 select * into snapshot from gh_visits where id=v;
 assert gh_sms_eligible(reminder,snapshot) is not true;
 update gh_visits set visit_date=current_date,report_status='sent',status='report_sent',report_sent_at=now()-interval '21 hours',report_email_id='mail-a' where id=v;
 update gh_visits set report_email_id='mail-repair' where id=v;
 assert (select count(*)=1 from gh_sms_jobs where kind='payment_reminder' and visit_id=v);
 select * into reminder from gh_sms_jobs where kind='payment_reminder' and visit_id=v;
 select * into snapshot from gh_visits where id=v;
 assert gh_sms_eligible(reminder,snapshot);
 update gh_visits set issue_open=true,issue_ever=true where id=v;
 select * into snapshot from gh_visits where id=v;
 assert not gh_sms_eligible(reminder,snapshot);
 update gh_visits set issue_open=false,status='payment_pending',payment_intent_id='pi_fixture' where id=v;
 assert not exists(select from gh_sms_jobs where kind='paid' and visit_id=v);
 update gh_visits set status='paid',paid_at=now() where id=v;
 claims:=gh_sms_claim(); j:=(claims->>'id')::uuid;
 assert (gh_sms_payload(j)->>'kind')='paid';
 perform gh_sms_delivery(j,record_sid,'delivered',null);
 perform gh_sms_finish(j,'accepted',record_sid,null);
 perform gh_sms_delivery(j,record_sid,'queued',null);
 assert (select delivery='delivered' from gh_sms_jobs where id=j);
 perform gh_sms_keyword('stop-qa','+14045550123','STOP',now());
 perform gh_sms_keyword('start-old','+14045550123','START',now()-interval '1 hour');
 assert (select blocked from gh_sms_blocks where phone='+14045550123');
 perform gh_sms_keyword('start-new','+14045550123','START',now()+interval '1 minute');
 perform gh_sms_keyword('stop-qa','+14045550123','STOP',now());
 assert not (select blocked from gh_sms_blocks where phone='+14045550123');
 insert into gh_events(visit_id,actor,event,detail) values(v,'owner','client_contact','{"phone":"4045550999"}');
 assert gh_sms_link(j) is null;
 assert not has_function_privilege('anon','gh_sms_claim()','execute');
end $$;
rollback;
