# Gatehouse Home Cleaning — handover

Short, current transfer note for the next person working on this site.
No secrets, no real personal data, no private tokens in this file.

## Repository and deployment

- Repository: https://github.com/mihas2596-stack/gatehouse-site, branch `main`.
- Production: https://www.gatehousehomecleaning.com (Vercel auto-deploy from `main`).
- Vercel project: the project connected to this repo (confirm the slug in the
  Vercel dashboard — it is not recorded here). Every push to `main` deploys;
  a push is NOT proof of a healthy deploy (see "Deploy and rollback").
- Working tree warning: a local checkout may differ from `main` (extra test /
  scratch files). Never commit a whole worktree. Ship only an explicit list
  of paths, and verify `git status` shows exactly those files.

## Current release — TBD (this push)

- **Version: TBD (this push)** — the commit hash of this push was not known
  when this note was written; fill it in from the push receipt before
  calling the release deployed. Base: production/main `90a50106`
  (07.11.2026, "Fix H1: unknown payment outcome never shows as Approved").
- This push is the **audit-fix release for the 09.11.2026 site audit**
  (`Аудит сайта 2026-11-09.md`: 0 critical, 8 high, 20 medium, 30 low).
  Of the 58 findings, 49 are fixed in this push, 1 is accepted as
  designed with no change (N21), and 8 stay open
  as data, owner-decision or live-check items. Findings fixed by parallel
  batches are marked "observed in worktree diff" — this note's author
  verified them by code tag / diff, not by running each batch's tests;
  the full suite runs separately before deploy.
- **H1 (from 90a50106) holds:** an unknown payment outcome never shows as
  "Approved" — it returns `payment_unknown` with retry and a status check
  (`api/report.ts`, `api/visit.ts`, screens in `Report.tsx` / `Visit.tsx`).
  Two live $1.49 payments are proved (client Approve; automatic timer),
  combined $2.30 payout arrived early November.
- **Test prices run to 13.11.2026 23:59 Europe/Minsk**
  (`2026-11-13T20:59:59Z`). Both calculator and API use the same cutoff.
  This remains a LIVE Stripe environment with reduced prices; it is not a
  Stripe sandbox. Existing visit amounts are unchanged. Do NOT start ads
  while test prices are public. After the owner says "test complete",
  remove the `tp1` test-price code and the window constants — do not just
  hide the banner.
- **Report-reply auto-processing is OFF:** `RESEND_REPORT_REPLIES_ENABLED`
  and `RESEND_REPORT_REPLY_DOMAIN` are NOT set in Vercel (verified live
  09.11). Replies to the photo-report email are not processed
  automatically; the owner still triages the inbox and presses
  "Open issue from email" in /owner. The Resend inbound domain is
  unverified and the Resend login never arrived — a re-check needs it.
- **Row Level Security is CLOSED, not open:** RLS was enabled on
  `public.gh_cleaners` on 07.11; Supabase Advisors showed 0 errors and
  0 warnings everywhere on 09.11, and the roster loads 10 cleaners in
  /owner. The old "standing RLS warning" in earlier handovers is done.
- **New env (optional):** `OWNER_NOTIFICATION_EMAIL` (N22) — the single
  mailbox all server emails to the owner go to. Unset, it falls back to
  the long-standing owner mailbox, so nothing breaks without it.
- **New migrations in this push (apply in Supabase; both are no-ops when
  the object already exists):** `20261109_report_photos_bucket.sql`
  (N30 — creates the private `report-photos` storage bucket) and
  `20261109_webhook_dedup.sql` (C14 — `gh_webhook_events` table for
  persistent webhook dedup).
- **Former test gap, fixed in this worktree:** `src/test/payment-path.test.ts`
  had 5 failing resend-webhook tests because C14's persistent dedup keys
  on the Svix delivery id while that file's `svixReq` helper reused one
  fixed id (`msg_test_1`) for every delivery. The helper now mints a
  unique id per delivery (`msg_test_${++svixCounter}`); payment-path is
  16/16 green and the full suite is 1165 passed across 81 files.

## Audit 09.11 — findings and dispositions (one line each)

High — 8 of 8 fixed.
- **B1 — fixed:** `testPricing` in Services/WhatsIncluded is now computed
  synchronously at render, like Index — prerender and live page show the
  same prices.
- **B2 — fixed:** the homepage now says email is registered manually and
  to tap "Report an issue" for an immediate block, matching the FAQ.
- **B3 — fixed (batch C, live data):** Chenika Williams was deactivated
  in the roster by batch C, per the owner's 26.10 verdict ("брать не
  буду — плохо убирает"). No code change was needed.
- **B4 — fixed:** the owner `status` action resolves a booking with no
  Stripe customer, and the card shows "No Stripe customer — no card can
  be charged" instead of neutral "Not paid yet".
- **B5 — fixed:** Charge (and test-flag change, report-photo delete) now
  ask `window.confirm` with amount and client name before acting.
- **B6 — fixed:** a past visit date is its own `date_passed` state —
  fallback dates from the row, no confirm-by promise, no card prompt,
  free reschedule/cancel.
- **B7 — fixed:** one-letter extra zones are dropped, never stored as
  rooms; the 7898b53d checklist corruption cannot recur (the row itself
  still needs its one-time repair — see open data items below).
- **B8 — fixed:** `send_report` with `resolve_issue` no longer closes the
  issue in the CAS; the issue closes only after the report email is
  proven sent, and a failed send restores the publication and the timer.

Medium — 19 of 20 fixed; C8 needs investigation.
- **C1 — fixed (copy, no legal change):** the FAQ damage-claim answer
  now names the 48-hour waiver and AAA arbitration up front.
- **C2 — fixed (batch C, live data):** `is_test` flags were re-marked on
  all 41 rows by batch C, so the "Hide test bookings" filter now rests on
  correct flags. No code change was needed.
- **C3 — fixed:** list rows show a card badge (journal `card_confirmed`)
  and an exact issue badge from the row flag.
- **C4 — fixed:** the owner card shows the auto-charge deadline
  (`report_sent_at + 24h`).
- **C5 — fixed:** "Cancel visit" exists in /owner, with the $25 late-fee
  rule and the post-report guard.
- **C6 — fixed:** "Detach card" exists in /owner, with the result (and
  Stripe errors) shown.
- **C7 — fixed:** the visit badge reflects the report — a `confirmed` row
  with a sent report badges as "Report sent".
- **C8 — OPEN:** `entry_agreed=false` for all 41 bookings, including
  paid ones; the source (entry data never saved in the test era) is not
  established — do not trust the signal until it is.
- **C9 — fixed:** `status` returns brand + last4; the card shows
  "Visa •••• 1234", and paid rows no longer read as "no card".
- **C10 — fixed:** issue reasons carry a source — client words vs
  operator notes are never rendered as "You told us" again.
- **C11 — fixed:** the charge re-checks the issue on fresh data
  immediately before creating the intent (accepted residual race is now
  recorded here, not silent).
- **C12 — fixed:** a separate `revoke_cleaner_link` action revokes a
  cleaner link without rotating it; `resolveVisit` checks visit status.
- **C13 — fixed:** Stripe customer/card choice is bound to the booking
  (row `stripe_customer_id`, `card_confirmed` wins, else a lone card) —
  never an unchecked `list[0]`.
- **C14 — fixed:** persistent webhook dedup by event id
  (`gh_webhook_events`, migration `20261109_webhook_dedup.sql`) for
  Stripe and Resend; in-memory set is only a same-process fallback.
- **C15 — fixed:** this rewrite. The file described 06.11/9deb6156 and
  never mentioned H1, `payment_unknown` or 90a50106.
- **C16 — fixed:** manual `charge` checks the reminder guard like the
  cron — no charge without a delivered 20h reminder (warning +
  confirmation in the panel).
- **C17 — fixed:** `send_report` returns 409 for a cancelled visit.
- **C18 — fixed:** reminder flags are per-booking (`gh_reminder_for` /
  `gh_early_reminder_for`); a repeat client's new visit gets its own
  early and 20h reminders, rebuilt from its own journal on rebind.
- **C19 — fixed:** receipt and fee-receipt emails point at "Report an
  issue" on the report page instead of inviting a reply that opens
  nothing.
- **C20 — fixed (this batch):** routine request emails no longer carry a
  one-click owner login (`owner?ol=`, 24h). The only issuer left is the
  "Send login link" button in /owner itself (`Owner.tsx`, "Send login
  link to my email").

Low — 26 of 30 fixed; N3, N8, N25 stay open, N21 is accepted.
- **N1 — fixed (copy):** the test banner says all home sizes are
  temporarily priced the same while test pricing is active.
- **N2 — fixed:** unknown URLs go through server rewrites to
  `/api/owner-auth?notfound=1` (the `notFoundHandler` in `api/_not_found.ts`,
  answered by the owner-auth handler before any origin/auth check)
  instead of a soft 200; verify the live status code after deploy.
  Folded from the standalone `api/not-found.ts` on 09.11.2026 — the
  Hobby plan allows only 12 serverless functions and the extra file
  pushed the count to 13, failing the 857ae50 deploy.
- **N3 — OPEN (live check):** `/areas/cumming` and other unserved cities
  need a real-browser check; subagents cannot do it.
- **N4 — fixed:** `/reviews`, `/gallery`, `/availability` (and siblings)
  are permanent server redirects in `vercel.json`, not JS-only.
- **N5 — fixed:** the Terms contents list no longer duplicates numbers.
- **N6 — fixed (copy):** "Your cleaner brings the supplies…" replaces
  the unverifiable "We bring our own…" in FAQ and city pages.
- **N7 — fixed:** "Open issue from email" is also offered before any
  report is sent (requested/confirmed bookings).
- **N8 — OPEN (data):** roster still mixes duplicate "Test Cleaner"
  rows and test people with real cleaners; cleanup is a data pass.
- **N9 — fixed:** owner search covers name, email, phone, cleaner,
  amount, address and booking id.
- **N10 — fixed:** list amounts carry a "test price" badge when the
  amount is a test tariff.
- **N11 — fixed:** an expired cleaner link on a submitted report says
  so ("report already submitted, no action needed").
- **N12 — fixed:** /visit in the `approved` state shows "Approved —
  your payment is being completed".
- **N13 — fixed (batch H):** the `awaiting` state now shows a single
  Approve CTA — the retry/unknown-payment box (`Try charging again`) is
  rendered only when `rep.state !== "awaiting"` (Visit.tsx).
- **N14 — fixed:** /report now says "approve above", matching where the
  buttons are.
- **N15 — fixed:** JourneySteps maps the visit day to step 2
  ("Cleaning").
- **N16 — fixed:** after a card detach, the card line is built from
  `card_confirmed + last4` (paid rows), not from `has_card`.
- **N17 — fixed:** reports with after-photos only say so ("After photos
  only — no before photos were taken for this visit.").
- **N18 — fixed (batch H):** the post-payment issue form has a photo
  upload (`paid-issue-photo` in Report.tsx), wired through
  `act("issue")` to the photo-accepting issue handler in api/report.ts;
  a failed or oversized photo never blocks the issue itself.
- **N19 — fixed:** `invalid_link` statuses are unified across
  /api/visit, /api/report and /api/cleaner; verify live after deploy.
- **N20 — fixed:** a bounced report returns no deadline in the API —
  the timer is blocked, so the deadline is dead.
- **N21 — accepted as designed, no change:** the entry secret stays in
  the owner detail response behind owner auth (deliberate, per audit).
- **N22 — fixed (this batch):** the owner mailbox lives in one place —
  `api/_owner_email.ts`, `ownerNotificationEmail()`, env
  `OWNER_NOTIFICATION_EMAIL` with fallback to the long-standing
  mailbox. All six call sites use it.
- **N23 — fixed (this batch):** the quote response returns
  `server_first` / `server_recurring`, and Quote/ThankYou show the
  server totals with an "Updated price" note before the card step.
  Deliberate choice over 409: the mismatch path already pins the
  correct amount in the signed token — the defect was opacity, not
  acceptance — and a 409 on every drift would reject bookings the
  server can accept at the right price. The 409 stays for the
  test-window case, where the client must actively re-review.
- **N24 — fixed:** the 48h cancellation threshold is counted to the
  arrival-window start (Atlanta time), not to noon of the visit day.
- **N25 — OPEN (owner decision):** lockout (full visit price) and extra
  time ($45/hr) in Terms still have no code — either build the
  operator path or take them out of Terms.
- **N26 — fixed:** Terms §7 (24h) and §10.2 (48h) windows are enforced
  on issue intake (the parallel batch tags this work "C26" in code and
  tests; the audit number is N26).
- **N27 — fixed (this batch):** the cron can no longer starve due
  charges — Stripe search is paged (`next_page`, max 10 pages), the DB
  pass pages 50 rows at a time by `report_sent_at` ascending (max 200
  rows, repeat-page guard), and all candidates are sorted oldest-first
  before the reminder passes and the `MAX_PER_RUN=25` charge slice.
- **N28 — fixed:** the owner-dispute Stripe mirror write is checked —
  a failed sync returns 502 with an honest status instead of a silent
  stale panel.
- **N29 — fixed (this batch):** the bounce webhook now matches reminder
  (20h + early 4h), receipt and fee-receipt email ids — each bounced
  mail is journaled (`reminder_bounced`, `early_reminder_bounced`,
  `receipt_bounced`, `cancellation_fee_receipt_bounced`, redelivery
  deduped). Reminder sends store their Resend id in the journal, and a
  bounced reminder no longer counts as delivered: the cron re-sends it
  next run and the charge guard refuses to charge on it.
- **N30 — fixed (this batch):** migration
  `20261109_report_photos_bucket.sql` creates the private
  `report-photos` bucket idempotently (`on conflict do nothing`);
  production already has the bucket, so it is a no-op there. No smoke
  test existed in the repo, so the check is the migration-content test
  `n30-report-photos-bucket.test.ts`.

## What this batch verified (its own 7 findings)

- `npx tsc --noEmit -p tsconfig.app.json` — clean.
- New/updated tests, 24 passed in 7 files: `n22-owner-email` (3),
  `n23-server-first` (3), `n27-cron-order` (2), `n29-webhook-bounce`
  (6), `n29-reminder-bounce-guard` (2), `n30-report-photos-bucket`
  (2), `thank-you-states` (6, incl. the new N23 notice case).
- Affected existing suites pass (737 passed across 15 files, plus 68
  across 6 more): contact-api, auto-charge guards/early-reminder,
  ra11, send-contact-rooms-entry, price-parity, calculator, db-storage,
  email-copy, owner-auth, owner-login, client-path-v2, minimal-flow,
  report-api, cleaner-report, cleaner-link-v2, ra07, quote steps/review.
  The former 5 `payment-path.test.ts` webhook failures are fixed in this
  worktree (unique Svix id per delivery in the test helper) — the full
  suite is green: 1165 passed across 81 files, 0 failed (verified
  09.11 by the independent push-package check).
- Price parity untouched: `git diff` on `api/send-contact-email.ts`
  contains zero changed lines matching `SERVER_PRICES`,
  `serverBreakdown` or any tariff value; `src/config/calculator.ts`
  was not touched at all. The file's only changes are C20 (login link
  removed), N22 (owner mailbox via helper) and N23 (response fields).
- No real payments, no real emails, no commits, no pushes in this batch.

## Install, run, build, test

- Toolchain: Node 22.x (see `package.json` engines), npm.
- `npm install`
- `npm run dev` — Vite dev server, http://127.0.0.1:8080. The dev server has
  NO `/api` proxy: private pages (`/visit`, `/report`, `/cleaner`) hit the
  live API only in production; locally they fail closed with a human error.
- `npm run build` — Vite build + SSR prerender (18 pages).
- `npm test` — Vitest suite (unit + API-behaviour tests).
- `npx tsc --noEmit -p tsconfig.app.json` — type check (the Vite build
  alone does not typecheck; the root `tsc --noEmit` alone checks no
  source files because the root config only contains project references).

## Environment variables (names only, never values)

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Postgres + Storage backend.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — payments, SetupIntents,
  customer metadata as the shared booking record.
- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` — transactional email + bounce
  webhook.
- `RESEND_REPORT_REPLY_DOMAIN`, `RESEND_REPORT_REPLIES_ENABLED` — automatic
  processing of replies to the photo-report email (PR #6): a verified client
  reply opens an issue and blocks the charge
  (`gh_accept_report_email_reply`, migration
  `20261107_report_email_reply.sql`). **Currently NOT set — the feature
  is off (see "Current release").**
- `OWNER_NOTIFICATION_EMAIL` — the owner's notification mailbox (N22,
  this push). Optional; falls back to the long-standing owner mailbox.
- `ADMIN_TOKEN` — owner-panel auth (Bearer) and operator API auth.
- `BOOKING_LINK_SECRET`, `CLEANER_LINK_SECRET`, `VISIT_ACCESS_KEY` —
  signed client/cleaner/visit links and entry-secret encryption.
- `CRON_SECRET` — auto-charge cron auth (falls back to `ADMIN_TOKEN`).

## Services and what each does

- Supabase (Postgres + Storage): visits, photos, journal events, cleaner
  directory, per-visit entry secrets, webhook dedup rows
  (`gh_webhook_events`). Server access uses the service-role key; RLS is
  enabled on the tables (see "Current release" — the Advisor warning is
  closed), but server paths do not rely on RLS.
- Stripe: saved cards (SetupIntents, $0 at booking), customer metadata as the
  shared booking record, charges, webhooks. Payouts to the owner's bank are a
  separate Stripe step — never confuse a client payment with a bank payout.
- Resend: client/owner emails (confirmation, report, issue, receipt,
  reminders) and the bounce webhook that voids the 24h clock — and now
  also journals bounced reminders/receipts (N29).
- Vercel: hosting + cron (see below). Termly: consent banner + consent-gated
  analytics (dataLayer events only, no PII — see `src/lib/measurement.ts`).

## Supabase schema and migrations

- Base schema: `supabase/schema.sql` — `gh_visits`, `gh_photos`, `gh_events`,
  `gh_cleaners` (+ indexes). Entry secrets live in `gh_visit_access`
  (migration `20261026_visit_access.sql`).
- Migrations in `supabase/migrations/` (newest first in application order):
  `20261109_report_photos_bucket.sql` (N30), `20261109_webhook_dedup.sql`
  (C14), `20261107_report_email_reply.sql`, `20261024_cleaner_link_v2.sql`,
  `20261026_visit_access.sql`, `20261027_fee_and_reminder.sql`,
  `20261028_entry_method.sql`.
- Apply new migrations in the Supabase SQL editor; both 20261109 files
  are no-ops when their object already exists.

## Webhook and cron entry points

- `POST /api/stripe-webhook` — Stripe events (card save, payment outcomes).
  Verified with `STRIPE_WEBHOOK_SECRET`; without it the endpoint refuses.
  Persistent dedup by event id (C14).
- `POST /api/resend-webhook` — Resend delivery events (Svix-signed). A
  confirmed bounce of the report email flags the booking
  (`report_bounced=true`); `gh_report_sent_at` is NOT cleared — the timer
  never runs on an undelivered report. Bounced reminders, receipts and fee
  receipts are journaled by their own email ids (N29). Persistent dedup
  by Svix delivery id (C14).
- Vercel cron (`vercel.json`): `GET /api/auto-charge` twice daily
  (10:00 and 22:00 UTC = 13:00 and 01:00 Europe/Minsk). It sends the early
  reminder (first run after 4h), then charges reports 24h+ old with no issue
  ever, no bounce, and a saved card. Reminder-before-charge: a report is
  never charged in the run that first reminded it. Candidates run
  oldest-first; the Stripe search is paged and the DB pass is paged by
  `report_sent_at` (N27).

## Price source and test-pricing mode

- Real price source: `src/config/calculator.ts` (tiers S/M/L; standard
  one-time 149/219/279, recurring 129/189/239, deep 249/329/399, move-in/out
  279/369/449; add-ons oven $35, fridge $35, cabinets $45, windows $8 each,
  pets $15; extra time $45/hr only with approval) mirrored by the server
  calculator in `api/send-contact-email.ts`. The two must stay in parity
  (see `price-parity` tests).
- Test-pricing mode (active at handover time): prices ×0.01 capped at $1.50
  with a "Test pricing is active" banner, until **13.11.2026 23:59
  Europe/Minsk**. Bookings made inside the window keep test prices forever
  by design. Do NOT start ads while test prices are public. After the owner
  says "test complete", remove the `tp1` test-price code and the window
  constants — do not just hide the banner.
- A visit's charge amount is ALWAYS its pinned `gh_visits.amount_cents`.
  Never re-price an existing visit from the current calculator.
- The quote response now returns the server-verified totals
  (`server_first`, `server_recurring`); Quote/ThankYou show them with an
  "Updated price" note when they differ from the browser tab (N23).

## Order and payment state machine

- Visit row (`gh_visits.status`): `requested` → `confirmed` →
  `report_sent` → `payment_pending` (charge in flight; a retry reconciles
  the in-flight intent before any new charge) → `paid`, plus `cancelled`
  and `issue_open` (issue flags are separate booleans: `issue_open`,
  `issue_ever`). `approved` is the client-consent state in the journal /
  Stripe metadata, not a row status. A past date is its own
  `date_passed` state (B6).
- Report (`report_status`): `none` → `draft` → `submitted` (owner review
  queue) → `sent` (published to the client). `submitted` is NOT delivered.
- Payment model (Terms §5.2): $0 at booking, card saved via Stripe. Approve
  on the report charges the pinned amount at once. Silence for 24h after the
  report is SENT (publish time, not submit time) with no issue = automatic
  charge. An issue (report page, or owner-registered from an email) blocks
  auto-charge for that visit forever (`issue_ever`); resolving it does NOT
  restart the timer — only a new client Approve pays. A bounced report
  email voids the clock until the report reaches the client another way.
  A bounced reminder voids the reminder, not the charge directly — the
  cron re-sends the reminder and the charge waits for a delivered one (N29).
- Cancellation: free up to 48h before the visit's arrival-window start,
  $25 after (Terms §6, N24). Client cancels on the visit page (this visit
  only, or this + all future recurring) or by email; the owner can also
  cancel from /owner (C5). Cancelling revokes the cleaner's entry access.
- Reschedule: the client proposes a date from the visit page; the owner
  confirms it in /owner (Schedule block). A proposal never clears the agreed
  date. The owner can also propose alternatives ("Propose another time").
- Idempotency / races: approve / complaint / cron / webhook are guarded by
  the shared payment-basis rule (`api/_payment_basis.ts`), CAS publish of
  reports, and single-charge flows. `chargeVisit` re-resolves amount, version
  and publication time from the visit row + journal at charge time, and
  re-checks the issue on fresh data immediately before creating the
  intent (C11).

## Owner queue (/owner)

- Filters: Needs attention / Upcoming / Completed / Cancelled / All visits,
  plus a text search (client, email, phone, cleaner, amount, address,
  booking). Test bookings are hidden by default; test-price amounts carry
  a "test price" badge.
- The queue rule lives in ONE place: `src/lib/ownerActions.ts`
  (`attentionItems`, `nextActionFor`). List rows, detail card and filter
  must agree — a visit must never say "No action needed" in one place and
  "Confirm the date" in another.
- Attention states: Approve request, Assign a cleaner, Confirm the date,
  Entry not agreed (confirmed visit within 2 days, entry unsettled),
  Review the report (submitted), Report delivery failed (bounced),
  Resolve the customer issue, Retry the payment (current failure only — a
  later success or a paid row clears it).
- List rows show card and issue badges; the card shows the auto-charge
  deadline (`report_sent_at + 24h`), brand + last4, and the owner can
  cancel the visit, detach the card, revoke a cleaner link, or re-issue
  a login link from the panel. Owner login links are issued ONLY from
  the panel — never inside routine request emails (C20).
- Owner actions that email: confirmation, cleaner change (client emailed in
  advance), issue opened from email (client confirmation email), report
  publish / re-send. Previewing a link or opening the cleaner link is NOT
  acceptance of the job.
- Cleaner change: entry is revoked BEFORE the new assignment lands (a failed
  revoke aborts the change); a fresh link is minted and the old link dies;
  reports and history stay on the visit row. A cleaner link can also be
  revoked on its own (C12).
- "Open issue from email" is offered before any report is sent too (N7).

## Recurring visits — honest current state

- There is NO automatic next-visit creation: no cron, no scheduler, no
  "create next visit" action in /owner, no "book next" step for the client.
  "Every other week" today is a price promise (pinned recurring amount per
  visit) + a cancel scope (this visit vs stop all future). A following visit
  requires a fresh request (or a manual owner process outside the system).
  Do not promise automation that does not exist; deciding the real
  next-visit process is an open owner decision (see below).

## Email issues — the gap that was closed, and its remainder

- Terms and FAQ allow reporting an issue by email. There is NO inbound-email
  automation while the report-reply env vars are unset: an email in the
  inbox blocks nothing by itself. The reliable process is: owner reads the
  inbox → presses "Open issue from email" in /owner (reason optional) →
  the visit's auto-charge blocks at once (`issue_open` + `issue_ever`),
  the client gets a confirmation email, and the issue appears in the queue
  until resolved. The action is idempotent: pressing it twice does not
  double-log or double-email.
- Remainder: the human latency between the email arriving and the owner
  pressing the button is still unguarded. A complaint arriving shortly
  before a cron run can still auto-charge before the owner acts. Do not
  claim email triage is automatic, and do not use AI classification as the
  sole basis for a financial block.

## Test scenarios (where they live)

- `src/test/` — Vitest: payment-basis and race tests, auto-charge guards,
  quote/booking flows, owner queue rules (`owner-actions.test.ts`), report
  API, cleaner links, measurement consent, and the audit-fix regressions
  (`n22-*`, `n23-*`, `n27-*`, `n29-*`, `n30-*`, plus the tagged cases in
  the other batches' files). Run the full suite before any deploy; a green
  subset is not proof for money/access/race paths.
- Browser checks: Playwright against the local dev server (localhost only)
  for mobile widths 320/390/430 + desktop, keyboard/focus, no horizontal
  scroll, no page errors. Private pages need real signed links — invalid
  links must fail closed with a human message, never a stack trace.
- Isolated staging with Stripe test mode does NOT exist yet: there are no
  staging test keys and no test-mail sink configured. Live-owner walkthroughs
  and end-to-end money flows were therefore verified at code + unit level,
  not by a live staged run. Do not run test charges in production.

## Open problems and known limits

1. Test prices public until 13.11.2026 23:59 Minsk (see above); ads blocked
   until they are gone and the owner confirms real prices (he intends to
   change prices before ads anyway).
2. No verified cleaners: trial cleanings were cancelled by the owner
   (28.10); verification now rests on references + the first paid booking.
3. No insurance, no EIN yet; the Whitlock quote draft (~$18k/yr contractor
   payouts) is unsent — the owner fills in tenure and sends it himself.
4. Recurring automation missing (see above) — owner decision needed.
5. Email-issue human latency (see above).
6. P03: Termly consent banner not verified live — only from the owner's
   phone in real Safari with a clean profile.
7. The owner's Meta ads access for the ads helper lapsed at login — needs a
   fresh owner login to restart.
8. Live phone check + live Stripe card-save run after deploy are still
   open (owner's phone session).
9. Test-environment decision: Stripe test keys + a test-mail sink for a
   real staged end-to-end run (owner decision).
10. Audit 09.11 remainder: C8 (find why `entry_agreed` is false
    everywhere), N3 (live-browser check for unserved cities), N8
    (roster dedup — data), N25 (lockout / extra time: build it or
    take it out of Terms). Closed since the audit by live data/code
    batches: B3 (Chenika deactivated), C2 (`is_test` re-marked on all
    41 rows), N13 (single Approve CTA in `awaiting`), N18 (photo in
    the post-payment issue form).
11. Data repairs still waiting: the 7898b53d checklist (one-letter rooms
    are blocked from recurring, but the row itself still holds them);
    Kate 86548240 (visit 11.11, no Stripe customer) and the four cards
    whose detachments were refused with a 502 on 07.11.
12. Former test gap now closed: the 5 `payment-path.test.ts` webhook
    failures (C14 dedup vs a reused Svix id) are fixed by the unique-id
    test helper in this worktree; full suite green (1165/1165).

## Deploy and rollback

1. Deploy = push to `main` (Vercel auto-deploy). Ship only the explicit
   path list; binary files (images) cannot go through the snapshot push —
   upload them via the GitHub web UI first, then the text files.
2. After EVERY push, verify the deploy actually landed (a push does not
   prove Vercel deployed): wait for the Vercel build Ready, then run the
   live no-secret API probe: `GET /api/visit` → `invalid_link`,
   `GET /api/cleaner` → `invalid_link`, `GET /api/owner` → 401 without
   auth, `POST /api/booking-action` without auth → 401,
   `GET /api/report` → JSON error. `FUNCTION_INVOCATION_FAILED` means a
   server module failed to load — fix immediately, do not wait.
   Also apply the two new migrations in Supabase if not yet applied,
   and re-check the live homepage + /services prices and the test
   banner (B1), plus the real 404 status on an unknown URL (N2).
3. Then render the live homepage + one private-page error state in a real
   browser (production lags the push by 1–2 minutes).
4. Rollback: revert the push on `main` (or redeploy the previous Vercel
   deployment) and re-run the same probe. Never describe local changes as
   deployed.
5. Secrets hygiene: never paste `ADMIN_TOKEN` or any secret into chat,
   code, or this file. Tokens the owner sends in chat are single-use
   (transit only) and he must delete them afterwards.

## Earlier releases (history — read newest first)

- **07.11.2026, `90a50106`:** Fix H1 (unknown payment outcome never
  shows as Approved; `payment_unknown` with retry + status check),
  reminder text, HANDOVER to HEAD. Live-verified the same day; Vercel
  Production Ready. Test prices extended through 13.11 23:59 Minsk.
- **06.11.2026, `9deb6156` (PR #6):** total-audit release — report-email
  replies (`RESEND_REPORT_REPLY_DOMAIN` /
  `RESEND_REPORT_REPLIES_ENABLED`, migration
  `20261107_report_email_reply.sql`), owner pagination, explicit test
  marking, past-date review, resend-status, next-visit invitation.
  See `docs/total-audit-release-2026-11-06.md`.
- **06.11.2026:** UX and contact fix batch — homepage hero rework, quote
  entry cards, readable payment summary, Nick → Gatehouse in operational
  copy, phone saved as a visit-scoped `client_contact` event.
- **03–05.11.2026:** QA fix batch — owner-link response races, cleaner
  checklist serialization, owner-registered complaints (durable row
  before success notifications), Terms §5.2/§6/§7 alignment with the
  owner's approval. Verified remote `main` at `f4e94430`.
- **03.11.2026, `e72ae94c`:** round-2 mobile client/cleaner path fixes +
  owner ops audit (Open-issue-from-email, bounced-report queue state,
  proposed-date confirm default, owner search, funnel events).
- **03.11.2026, `0b3ce6fc`:** mobile homepage.

## Uncommitted changes and unfinished tasks (at handover time)

- This handover describes the worktree as assembled for this push; the
  release version above is TBD until the push receipt lands — fill it in
  then, and re-run the deploy probe before calling anything deployed.
- Standing owner decisions still waiting (not to be assumed):
  test-prices "test complete", new prices before ads, Chenika inactive
  marking + the 17.10 Instagram carousel fate, live dispute-email test,
  staging test keys, lockout/extra-time (N25), the 7898b53d checklist
  repair, Kate + the four undetached cards.
