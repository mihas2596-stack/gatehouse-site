-- Link a verified report reply to one visit. A row lock makes the hold
-- and journal entry one transaction, including concurrent redelivery.
create or replace function public.gh_accept_report_email_reply(
  p_visit_id uuid, p_sender text, p_email_id text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v public.gh_visits%rowtype;
  prior_outcome text;
  outcome text;
  journal_event text := 'report_email_reply';
begin
  if p_email_id is null or p_email_id !~ '^[A-Za-z0-9_-]{1,128}$' or p_sender is null then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  select * into v from public.gh_visits where id = p_visit_id for update;
  if not found or lower(btrim(v.client_email)) is distinct from lower(btrim(p_sender)) then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  select detail->>'outcome' into prior_outcome
    from public.gh_events where visit_id = v.id
    and event in ('issue_opened', 'report_email_reply') and detail->>'via' = 'report_email'
    and detail->>'email_id' = p_email_id order by id desc limit 1;
  if found then
    return jsonb_build_object('outcome', prior_outcome, 'booking_id', v.booking_id);
  end if;
  if v.report_sent_at is null and not exists (
    select 1 from public.gh_events where visit_id = v.id and event = 'report_sent'
  ) then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  if v.status in ('paid', 'cancelled') then
    outcome := v.status;
  else
    outcome := case when v.status = 'payment_pending' then 'payment_in_progress' else 'held' end;
    journal_event := 'issue_opened';
    update public.gh_visits set issue_open = true, issue_ever = true, updated_at = now() where id = v.id;
  end if;
  insert into public.gh_events(visit_id, booking_id, actor, event, detail)
  values (v.id, v.booking_id, 'client', journal_event, jsonb_build_object(
    'via', 'report_email', 'email_id', p_email_id, 'outcome', outcome,
    'reason', 'The client replied to the photo report. Review the reply before taking payment.'
  ));
  return jsonb_build_object('outcome', outcome, 'booking_id', v.booking_id);
end;
$$;

revoke all on function public.gh_accept_report_email_reply(uuid, text, text) from public, anon, authenticated;
grant execute on function public.gh_accept_report_email_reply(uuid, text, text) to service_role;
