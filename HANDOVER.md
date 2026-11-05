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

## QA fix batch — 03.11.2026

### QA follow-up — 05.11.2026

- Verified remote `main` at `f4e944309515a3f7101a51e60679ac5043bf8842`
  with a successful Vercel deployment status. The November 4 release package
  is present; its two differing files contain subsequent TypeScript fixes.
- Reproduced and fixed delayed owner-link responses crossing between selected
  customers (including clipboard and manual-copy fallbacks), preview/share
  callbacks, and upload completion reopening the previous customer. Selection
  epochs also discard responses after leaving and reopening the same visit.
- An expired owner session now returns to email login and clears rejected
  stored credentials. An old list response cannot invalidate a newer login.
- Validation: 60 test files / 1022 tests pass (three new regression cases),
  `tsc --noEmit -p tsconfig.app.json`, production build, 18-page prerender and
  HTML checks pass. The repository root `tsc --noEmit` alone checks no source
  files because the root config only contains project references.
- Live owner-login email delivered and opened the panel; homepage and quote
  steps 1–2 inspected. This is not a complete live client/cleaner/payment cycle.
  No new booking, card save, charge or real cleaner dispatch was performed.
  Full card/charge QA, mobile private-page QA and all email variants remain
  unverified. Test prices and existing operational limits below still apply.
- This section records source verification; confirm the deployment of this
  follow-up separately before describing its fixes as live.

- Based on `3c43c83e`; the previous production verification is recorded
  below. This section describes source changes, not proof of deployment.
  Confirm the current main commit's Vercel status and live probes before
  calling this batch deployed.
- Owner login hook order fixed; visit/detail/action responses cannot replace
  a newly selected customer, and complaint drafts reset between customers.
- Cleaner checklist writes are serialized. Finish waits for them; a photo
  refresh does not overwrite unsaved edits, and a late checklist write
  cannot reopen a published report. The saving status includes the debounce.
- Client-excluded room uploads are blocked in the cleaner and owner editors
  and in both upload APIs. Matching ignores case and surrounding whitespace;
  free-text instructions still require the cleaner's judgment.
- On phones, cleaner camera controls use two columns with a separate gallery
  row; restricted rooms omit camera controls. Room badges wrap, checklist
  labels and small/icon buttons have 44px touch targets.
- Owner-registered complaints use a conditional durable row write before
  success notifications. Database failures do not email false success;
  journal failures retain the permanent payment block. Concurrent owner
  complaints send one confirmation. A paid row is never called paused.
- Terms §5.2, §6 and §7 aligned with the existing payment/cancel/report rules
  after the owner's approval. No price, payment amount or recurrence policy
  changed. Existing owner login lifetime remains 24 hours; the quote email
  and expiry test now describe that lifetime accurately.
- Live QA created one clearly named `QA Full Journey — DO NOT DISPATCH`
  request. Client and owner emails arrived. Stripe checkout was LIVE, so no
  real card was saved/selected and no charge or paid end-to-end pass was run.
  Staging with Stripe test mode remains necessary.
- The live read-only check found a card-choice UX contradiction: an old card
  was available, not yet confirmed for this booking, but /visit also said
  "Next step is ours." The client page now makes the customer's card choice
  the next action and only shows the owner-waiting message after that choice.
- Customer emails use readable US dates, Atlanta arrival windows, one primary
  button, and separated request details. Payment text states immediate approval
  charging and the 24h clock from report sending. A reissued report after any
  issue does not announce an automatic charge. Manual cleaner job messages
  explain entry, no-photo rooms, saved changes and the Finish action. No new
  automatic cleaner email channel was added. API photo restrictions import a
  pure api-local helper so Vercel functions do not depend on src/ imports.
- Local verification: 60 test files / 1019 tests pass, TypeScript check,
  production build, prerender of 18 pages and the generated HTML checks pass.
  The owner explicitly authorized publishing this batch and email fixes.
  Live deployment and a paid end-to-end run are not claimed here.

## Previously verified production version

- Deployed and live-verified commit on `main`: `e72ae94c` (03.11.2026) —
  round-2 mobile client/cleaner path fixes (H/Q/A/C/K) + owner ops audit
  (Open-issue-from-email, bounced-report queue state, proposed-date
  confirm default, owner search, funnel events) + this handover note.
  Live check after deploy: API probe healthy (invalid_link / 401s, no
  module failures) and the live homepage + /quote render the new copy.
- Previous verified commit: `0b3ce6fc` (mobile homepage, 03.11.2026).

## Install, run, build, test

- Toolchain: Node 22.x (see `package.json` engines), npm.
- `npm install`
- `npm run dev` — Vite dev server, http://127.0.0.1:8080. The dev server has
  NO `/api` proxy: private pages (`/visit`, `/report`, `/cleaner`) hit the
  live API only in production; locally they fail closed with a human error.
- `npm run build` — Vite build + SSR prerender (18 pages).
- `npm test` — Vitest suite (unit + API-behaviour tests).
- `npx tsc --noEmit` — type check (the Vite build alone does not typecheck).

## Environment variables (names only, never values)

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Postgres + Storage backend.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — payments, SetupIntents,
  customer metadata as the shared booking record.
- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` — transactional email + bounce
  webhook.
- `ADMIN_TOKEN` — owner-panel auth (Bearer) and operator API auth.
- `BOOKING_LINK_SECRET`, `CLEANER_LINK_SECRET`, `VISIT_ACCESS_KEY` —
  signed client/cleaner/visit links and entry-secret encryption.
- `CRON_SECRET` — auto-charge cron auth (falls back to `ADMIN_TOKEN`).

## Services and what each does

- Supabase (Postgres + Storage): visits, photos, journal events, cleaner
  directory, per-visit entry secrets. Server access uses the service-role key;
  there is no Row Level Security reliance for server paths.
- Stripe: saved cards (SetupIntents, $0 at booking), customer metadata as the
  shared booking record, charges, webhooks. Payouts to the owner's bank are a
  separate Stripe step — never confuse a client payment with a bank payout.
- Resend: client/owner emails (confirmation, report, issue, receipt,
  reminders) and the bounce webhook that voids the 24h clock.
- Vercel: hosting + cron (see below). Termly: consent banner + consent-gated
  analytics (dataLayer events only, no PII — see `src/lib/measurement.ts`).

## Supabase schema and migrations

- Base schema: `supabase/schema.sql` — `gh_visits`, `gh_photos`, `gh_events`,
  `gh_cleaners` (+ indexes). Entry secrets live in `gh_visit_access`
  (migration `20261026_visit_access.sql`).
- Migrations in `supabase/migrations/` (newest first in application order):
  `20261024_cleaner_link_v2.sql`, `20261026_visit_access.sql`,
  `20261027_fee_and_reminder.sql`, `20261028_entry_method.sql`.
- There is a standing Supabase Advisor warning about a table without RLS
  (believed to be `gh_cleaners`). It is NOT fixed silently: it needs the
  owner's confirmation of the exact table plus an explicit yes for one SQL
  fix (`enable row level security`), with no code or deploy change.

## Webhook and cron entry points

- `POST /api/stripe-webhook` — Stripe events (card save, payment outcomes).
  Verified with `STRIPE_WEBHOOK_SECRET`; without it the endpoint refuses.
- `POST /api/resend-webhook` — Resend delivery events (Svix-signed). A
  confirmed bounce of the report email flags the booking, clears
  `gh_report_sent_at`, and returns it to `card_ready` — the timer never runs
  on an undelivered report.
- Vercel cron (`vercel.json`): `GET /api/auto-charge` twice daily
  (10:00 and 22:00 UTC = 13:00 and 01:00 Europe/Minsk). It sends the early
  reminder (first run after 4h), then charges reports 24h+ old with no issue
  ever, no bounce, and a saved card. Reminder-before-charge: a report is
  never charged in the run that first reminded it.

## Price source and test-pricing mode

- Real price source: `src/config/calculator.ts` (tiers S/M/L; standard
  one-time 149/219/279, recurring 129/189/239, deep 249/329/399, move-in/out
  279/369/449; add-ons oven $35, fridge $35, cabinets $45, windows $8 each,
  pets $15; extra time $45/hr only with approval) mirrored by the server
  calculator in `api/send-contact-email.ts`. The two must stay in parity
  (see `price-parity` tests).
- Test-pricing mode (active at handover time): prices ×0.01 capped at $1.50
  with a "Test pricing is active" banner, until **06.11.2026 13:33
  Europe/Minsk**. Bookings made inside the window keep test prices forever
  by design. Do NOT start ads while test prices are public. After the owner
  says "test complete", remove the `tp1` test-price code and the window
  constants — do not just hide the banner.
- A visit's charge amount is ALWAYS its pinned `gh_visits.amount_cents`.
  Never re-price an existing visit from the current calculator.

## Order and payment state machine

- Visit row (`gh_visits.status`): `requested` → `confirmed` →
  `report_sent` → `approved` → `paid`, plus `cancelled` and `issue_open`
  (issue flags are separate booleans: `issue_open`, `issue_ever`).
- Report (`report_status`): `none` → `draft` → `submitted` (owner review
  queue) → `sent` (published to the client). `submitted` is NOT delivered.
- Payment model (Terms §5.2): $0 at booking, card saved via Stripe. Approve
  on the report charges the pinned amount at once. Silence for 24h after the
  report is SENT (publish time, not submit time) with no issue = automatic
  charge. An issue (report page, or owner-registered from an email) blocks
  auto-charge for that visit forever (`issue_ever`); resolving it does NOT
  restart the timer — only a new client Approve pays. A bounced report
  email voids the clock until the report reaches the client another way.
- Cancellation: free up to 48h before the visit, $25 after (Terms §6).
  Client cancels on the visit page (this visit only, or this + all future
  recurring) or by email. Cancelling revokes the cleaner's entry access.
- Reschedule: the client proposes a date from the visit page; the owner
  confirms it in /owner (Schedule block). A proposal never clears the agreed
  date. The owner can also propose alternatives ("Propose another time").
- Idempotency / races: approve / complaint / cron / webhook are guarded by
  the shared payment-basis rule (`api/_payment_basis.ts`), CAS publish of
  reports, and single-charge flows. `chargeVisit` re-resolves amount, version
  and publication time from the visit row + journal at charge time.

## Owner queue (/owner)

- Filters: Needs attention / Upcoming / Completed / Cancelled / All visits,
  plus a text search (client, address, booking). Test bookings are hidden by
  default.
- The queue rule lives in ONE place: `src/lib/ownerActions.ts`
  (`attentionItems`, `nextActionFor`). List rows, detail card and filter
  must agree — a visit must never say "No action needed" in one place and
  "Confirm the date" in another.
- Attention states: Approve request, Assign a cleaner, Confirm the date,
  Entry not agreed (confirmed visit within 2 days, entry unsettled),
  Review the report (submitted), Report delivery failed (bounced),
  Resolve the customer issue, Retry the payment (current failure only — a
  later success or a paid row clears it).
- Owner actions that email: confirmation, cleaner change (client emailed in
  advance), issue opened from email (client confirmation email), report
  publish / re-send. Previewing a link or opening the cleaner link is NOT
  acceptance of the job.
- Cleaner change: entry is revoked BEFORE the new assignment lands (a failed
  revoke aborts the change); a fresh link is minted and the old link dies;
  reports and history stay on the visit row.

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
  automation: an email in the inbox blocks nothing by itself. The reliable
  process is: owner reads the inbox → presses "Open issue from email" in
  /owner (reason optional) → the visit's auto-charge blocks at once
  (`issue_open` + `issue_ever`), the client gets a confirmation email, and
  the issue appears in the queue until resolved. The action is idempotent:
  pressing it twice does not double-log or double-email.
- Remainder: the human latency between the email arriving and the owner
  pressing the button is still unguarded. A complaint arriving shortly
  before a cron run can still auto-charge before the owner acts. Do not
  claim email triage is automatic, and do not use AI classification as the
  sole basis for a financial block.

## Test scenarios (where they live)

- `src/test/` — Vitest: payment-basis and race tests, auto-charge guards,
  quote/booking flows, owner queue rules (`owner-actions.test.ts`), report
  API, cleaner links, measurement consent. Run the full suite before any
  deploy; a green subset is not proof for money/access/race paths.
- Browser checks: Playwright against the local dev server (localhost only)
  for mobile widths 320/390/430 + desktop, keyboard/focus, no horizontal
  scroll, no page errors. Private pages need real signed links — invalid
  links must fail closed with a human message, never a stack trace.
- Isolated staging with Stripe test mode does NOT exist yet: there are no
  staging test keys and no test-mail sink configured. Live-owner walkthroughs
  and end-to-end money flows were therefore verified at code + unit level,
  not by a live staged run. Do not run test charges in production.

## Open problems and known limits

1. Test prices public until 06.11.2026 13:33 Minsk (see above); ads blocked
   until they are gone and the owner confirms real prices (he intends to
   change prices before ads anyway).
2. No verified cleaners: trial cleanings were cancelled by the owner
   (28.10); verification now rests on references + the first paid booking.
3. No insurance, no EIN yet; the Whitlock quote draft (~$18k/yr contractor
   payouts) is unsent — the owner fills in tenure and sends it himself.
4. Terms wording updated in the 03.11.2026 QA fix batch with the owner's
   approval: §5.2 never resumes automatically after an issue, §6 visit-page
   cancellation/date requests, §7 report-page issues + 72h from the issue.
5. Recurring automation missing (see above) — owner decision needed.
6. Email-issue human latency (see above).
7. P03: Termly consent banner not verified live — only from the owner's
   phone in real Safari with a clean profile.
8. Supabase RLS Advisor warning (see above).
9. The owner's Meta ads access for the ads helper lapsed at login — needs a
   fresh owner login to restart.
10. Live phone check + live Stripe card-save run after deploy are still
    open (owner's phone session).
11. Test-environment decision: Stripe test keys + a test-mail sink for a
    real staged end-to-end run (owner decision).

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
3. Then render the live homepage + one private-page error state in a real
   browser (production lags the push by 1–2 minutes).
4. Rollback: revert the push on `main` (or redeploy the previous Vercel
   deployment) and re-run the same probe. Never describe local changes as
   deployed.
5. Secrets hygiene: never paste `ADMIN_TOKEN` or any secret into chat,
   code, or this file. Tokens the owner sends in chat are single-use
   (transit only) and he must delete them afterwards.

## Uncommitted changes and unfinished tasks (at handover time)

- See "Verified version" above: the round-2 + audit batch is deployed as
  `e72ae94c` and live-verified per "Deploy and rollback".
- Standing owner decisions still waiting (not to be assumed):
  test-prices "test complete", Chenika inactive marking + the
  17.10 Instagram carousel fate, live dispute-email test, staging test keys.
