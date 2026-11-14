import { clientVisitLink } from "./_booking_links.js";
import { emailDate, emailArrivalWindow, emailDocument } from "./_email_copy.js";
// /api/auto-charge — the server-side 24h timer for "Approve, then pay".
//
// Invoked by Vercel Cron (see vercel.json) or manually by the operator.
// Auth: Authorization: Bearer <redacted> (Vercel Cron sends this
// automatically when the CRON_SECRET env var exists) or the ADMIN_TOKEN.
//
// A booking is charged by the timer ONLY when ALL of these hold:
//   - gh_state == "report_sent" (a report was sent and not yet answered)
//   - the report was sent at least 24 hours ago (gh_report_sent_at)
//   - no issue is open AND no issue was EVER reported for this booking
//     (gh_issue_ever: after any complaint the auto-charge never resumes
//     on its own — resolution is communicated to the client and the
//     charge then goes through the operator approve/charge path)
//   - the report email was not confirmed bounced (gh_report_bounced:
//     per the Terms, the 24h window does not start until the report
//     reaches the client another way)
//   - a saved payment method exists
// The amount is the one pinned to this report by send_report
// (gh_report_amount_cents; fallback: the first-visit price). The
// PaymentIntent uses the SAME idempotency key as the manual charge
// (charge_<bid>_v<report_version>), and the state is claimed to
// payment_pending with a fresh re-read first — a timer run, an operator
// charge and a repeated webhook cannot produce two payments for one visit.

import { timingSafeEqual, createCipheriv, createHash, randomBytes } from "crypto";
import { sendReceiptEmailOnce, sendPaymentFailedEmailOnce, bookingEmailContact } from "./booking-action.js";
import { dbConfigured, dbSelect, dbSelectStrict, dbDelete, dbDeleteCount, dbUpdate, dbUpdateCount, logEvent, storageRemove } from "./_db.js";
import { chargeVisit } from "./_payment_obligation.js";
import { isFutureVisitDate } from "./_visit_date.js";
import { pickCustomerByEmail, pickCard, resolveCustomerByRowId } from "./_stripe_customer.js";
import { loadAccess } from "./_visit_access.js";
import { cleanupOrphanPhotos } from "./_storage-cleanup.js";
import { reconcileIntent, confirmIntent, getIntent, verifyIntentForObligation } from "./_payment_intent.js";

// Booking-scoped pass: the metadata search only sees the booking the
// shared customer is currently bound to. A report sent for another
// booking of the same client lives in gh_visits — find those rows,
// resolve the client by email and hydrate the customer's metadata from
// the booking's own record before the charge/reminder selection runs.
type BookingRow = {
  id: string; booking_id: string; status: string | null;
  amount_cents: number | null; cleaner_name: string | null;
  client_email: string | null; report_sent_at: string | null;
  report_bounced: boolean | null; report_status: string | null;
  issue_open: boolean | null; issue_ever: boolean | null;
  stripe_customer_id?: string | null;
  // Payment-date gate (B): the scheduled visit date, hydrated into
  // metadata as gh_visit_date (the confirmed date wins in selectDue).
  visit_date?: string | null;
};
type BookingEvent = { event: string; detail: Record<string, unknown> | null; created_at: string };
async function bookingEvents(bookingId: string): Promise<BookingEvent[]> {
  if (!dbConfigured()) return [];
  return dbSelect<BookingEvent>(
    "gh_events",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=created_at.desc&limit=60`,
  );
}
const latestEvent = (events: BookingEvent[], name: string): BookingEvent | null =>
  events.find((e) => e.event === name) ?? null;

// G3: the reminder-before-charge guard is keyed to the CURRENT
// publication, not to any reminder ever sent. The anchor is the
// latest (re-)publication: the reminders_rearmed event's
// report_sent_at when present (logged by publishReportToClient in
// api/cleaner.ts on every publish), else the latest report_sent
// event's time. A reminder counts only when it was sent AFTER that
// anchor — a reminder sent for an old publication never satisfies
// the guard for the new one, so the client always gets a fresh
// reminder before a charge on the new publication. With no anchor on
// record (legacy publications) the old behaviour stands: any latest
// reminder counts — the guard fails open rather than stalling
// charges on journal history it cannot see.
export function publicationAnchorMs(events: BookingEvent[]): number | null {
  const candidates: number[] = [];
  const rearm = latestEvent(events, "reminders_rearmed");
  if (rearm) {
    const sentAt = typeof rearm.detail?.["report_sent_at"] === "string" ? rearm.detail["report_sent_at"] : "";
    const ms = Date.parse(sentAt || rearm.created_at);
    if (Number.isFinite(ms)) candidates.push(ms);
  }
  const sent = latestEvent(events, "report_sent");
  if (sent) {
    const ms = Date.parse(sent.created_at);
    if (Number.isFinite(ms)) candidates.push(ms);
  }
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * The latest event of one of <names> that belongs to the current
 * publication: after the anchor when one exists, else the latest
 * overall (legacy). Null when no such event exists — e.g. the only
 * reminder predates a republication, so the new publication is
 * unreminded and the guard must wait for a fresh reminder.
 */
export function latestCurrentEvent(
  events: BookingEvent[],
  names: string[],
): BookingEvent | null {
  const anchor = publicationAnchorMs(events);
  const matches = events.filter((e) => names.includes(e.event));
  if (anchor === null) return matches[0] ?? null;
  return matches.find((e) => {
    const ms = Date.parse(e.created_at);
    return Number.isFinite(ms) && ms > anchor;
  }) ?? null;
}

// N29: a bounced reminder is not a delivered reminder. True when a
// <bounceEvent> journal event exists for this booking after <afterIso>
// (the time the reminder flag was set). The caller then clears the flag
// so the next run re-sends the reminder instead of skipping the client.
async function reminderBouncedAfter(bookingId: string, afterIso: string, bounceEvent: string): Promise<boolean> {
  if (!dbConfigured() || !bookingId) return false;
  try {
    const rows = await dbSelect<{ created_at: string; event: string }>(
      "gh_events",
      `booking_id=eq.${encodeURIComponent(bookingId)}&event=eq.${bounceEvent}&order=created_at.desc&limit=1`,
    );
    const hit = rows.find((r) => r.event === bounceEvent);
    const at = hit?.created_at ?? "";
    return Boolean(at) && at > afterIso;
  } catch {
    return false;
  }
}
const evStr = (ev: BookingEvent | null, key: string): string =>
  ev && typeof ev.detail?.[key] === "string" ? (ev.detail[key] as string) : "";
async function findCustomerByEmail(
  secretKey: string,
  email: string,
  bookingId?: string | null,
): Promise<{ id: string; metadata: Record<string, string>; email?: string; name?: string } | null> {
  const query = `email:'${email.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "10" })}`);
  const list = res.ok
    ? ((res.data["data"] as Array<{ id: string; metadata?: Record<string, string>; email?: string; name?: string }> | undefined) ?? [])
    : [];
  // C13: never take list[0] unchecked — the pick requires an exact
  // email match and prefers the customer bound to this booking.
  const picked = pickCustomerByEmail(list, email, bookingId);
  return picked
    ? { id: picked.id, metadata: picked.metadata ?? {}, email: picked.email, name: picked.name }
    : null;
}
async function hydrateCustomerMeta(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string> },
  row: BookingRow,
  events: BookingEvent[],
): Promise<void> {
  const confirmEv = latestEvent(events, "visit_confirmed");
  const opened = latestEvent(events, "issue_opened");
  const resolved = latestEvent(events, "issue_resolved");
  // P03: the journal window is only 60 events — an old dispute can
  // fall outside it. The row flags are the durable truth and must
  // survive hydration: never clear issue_ever because the window
  // lacks the event. OR, never overwrite, on both flags.
  const issueOpen = row.issue_open === true || Boolean(opened && (!resolved || resolved.created_at < opened.created_at));
  const issueEver = row.issue_ever === true || Boolean(opened);
  const cancelledEv = latestEvent(events, "visit_cancelled");
  const approvedEv = latestEvent(events, "report_approved");
  // G3: the reminder flags hydrate ONLY from a reminder that belongs
  // to the current publication (latestCurrentEvent). Without this,
  // hydration rebuilt the flags from the OLD publication's reminder
  // on every cron run, silently undoing the re-arm publishReportToClient
  // performed — the new publication's reminders would never fire, and
  // the charge-loop guard below would wait forever for a reminder the
  // reminder passes thought was already sent.
  const remindedEv = latestCurrentEvent(events, ["reminder_sent"]);
  const earlyRemindedEv = latestCurrentEvent(events, ["early_reminder_sent"]);
  const cardEmailEv = latestEvent(events, "card_saved_email");
  const state = row.status === "paid" ? "paid"
    // Fix round 2: a refunded visit is its own state — it must never
    // fall through to "report_sent" (which would make selectDue
    // consider it for auto-charge).
    : row.status === "refunded" ? "refunded"
    : cancelledEv ? "cancelled"
    : issueOpen ? "issue_open"
    : approvedEv ? "approved"
    : row.report_sent_at ? "report_sent"
    : customer.metadata["gh_state"] ?? "";
  const values: Record<string, string> = {
    gh_booking_id: row.booking_id,
    gh_state: state,
    gh_first_price_cents: row.amount_cents != null ? String(row.amount_cents) : "",
    gh_recurring_price_cents: "",
    gh_report_sent_at: row.report_sent_at ?? "",
    gh_report_amount_cents: row.amount_cents != null ? String(row.amount_cents) : "",
    gh_report_bounced: row.report_bounced ? "1" : "",
    gh_booking_confirmed: confirmEv ? "1" : "",
    gh_confirmed_date: evStr(confirmEv, "date"),
    gh_confirmed_window: evStr(confirmEv, "window"),
    // Payment-date gate (B): the scheduled visit date, so selectDue
    // can block a future-dated report even when no confirmed date
    // was ever set (the confirmed date wins when present).
    gh_visit_date: row.visit_date ?? "",
    gh_cleaner_name: row.cleaner_name ?? "",
    gh_issue_open: issueOpen ? "1" : "",
    gh_issue_ever: issueEver ? "1" : "",
    gh_reminded_at: remindedEv ? remindedEv.created_at : "",
    // C18: per-booking reminder flags (see the early/20h passes):
    // hydration from this booking's own journal rebuilds them after a
    // rebind, so a repeat client's new visit gets its own reminders.
    gh_reminder_for: remindedEv ? row.booking_id : "",
    gh_early_reminded_at: earlyRemindedEv ? earlyRemindedEv.created_at : "",
    gh_early_reminder_for: earlyRemindedEv ? row.booking_id : "",
    gh_card_email_sent: cardEmailEv ? "1" : "",
  };
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) params[`metadata[${k}]`] = v;
  await stripePost(secretKey, `/customers/${customer.id}`, params);
  Object.assign(customer.metadata, values);
}

const STRIPE_API = "https://api.stripe.com/v1";
const MAX_PER_RUN = 25;
// M8: the reminder passes share the charge cap's per-run discipline —
// one cron run sends at most MAX_PER_RUN reminders (early + 20h
// combined), so a backlog of unreminded reports can never turn a
// single run into an unbounded burst of reminder emails. Only the
// charges were capped before; the reminder loops below break on it.
const MAX_REMINDERS_PER_RUN = MAX_PER_RUN;

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

type Cust = { id: string; email?: string; name?: string; metadata: Record<string, string> };

async function stripeGet(
  secretKey: string,
  path: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15000),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { ok: response.ok, status: response.status, data };
}

async function stripePost(
  secretKey: string,
  path: string,
  params: Record<string, string>,
  idempotencyKey?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { ok: response.ok, status: response.status, data };
}

export type DueCharge = {
  customerId: string;
  customerEmail: string | null;
  bookingId: string;
  amountCents: number;
  reportVersion: number;
  paymentMethod: string;
};

// Pure selection: which of these customers are due an automatic charge
// right now. Exported for tests; the handler re-runs it on a fresh
// re-read of each customer immediately before charging.
export function selectDue(customers: Cust[], nowMs: number): DueCharge[] {
  const out: DueCharge[] = [];
  for (const c of customers) {
    const m = c.metadata;
    if ((m["gh_state"] ?? "") !== "report_sent") continue;
    if (m["gh_issue_open"] === "1" || m["gh_issue_ever"] === "1") continue;
    if (m["gh_report_bounced"] === "1") continue;
    // Payment-date gate (B): a visit may be charged on or after its
    // date, never before. The effective date is the confirmed date
    // when set, else the scheduled visit date (both hydrated into
    // metadata). A future-dated sent report is never due — chargeVisit
    // re-checks the same gate against the DB row at charge time.
    const effectiveDate = m["gh_confirmed_date"] || m["gh_visit_date"] || "";
    if (isFutureVisitDate(effectiveDate, nowMs)) continue;
    const sentMs = Date.parse(m["gh_report_sent_at"] ?? "");
    if (!Number.isFinite(sentMs)) continue;
    if (sentMs + 24 * 3600 * 1000 > nowMs) continue;
    const paymentMethod = m["gh_payment_method"] ?? "";
    if (!paymentMethod) continue;
    const rawAmount = m["gh_report_amount_cents"] ? m["gh_report_amount_cents"] : m["gh_first_price_cents"];
    const amount = parseInt(rawAmount ?? "", 10);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const bookingId = m["gh_booking_id"] ?? "";
    if (!bookingId) continue;
    out.push({
      customerId: c.id,
      customerEmail: c.email ?? null,
      bookingId,
      amountCents: amount,
      reportVersion: parseInt(m["gh_report_version"] ?? "1", 10) || 1,
      paymentMethod,
    });
  }
  return out;
}

// N27: oldest report first, in place. A candidate without a parseable
// report_sent_at sorts last — it can never jump ahead of a dated one,
// so the MAX_PER_RUN slice always takes the longest-waiting charges.
export function sortCandidatesOldestFirst(candidates: Cust[]): Cust[] {
  const sentMs = (c: Cust): number => {
    const t = Date.parse(c.metadata["gh_report_sent_at"] ?? "");
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  candidates.sort((a, b) => sentMs(a) - sentMs(b));
  return candidates;
}

async function findByState(secretKey: string, state: string): Promise<Cust[]> {
  const query = `metadata['gh_state']:'${state}'`;
  type Raw = { id: string; email?: string; name?: string; metadata?: Record<string, string> };
  // N27: Stripe search is paged (limit=100 is a page, not the set) — walk
  // next_page so a 101st report-sent customer is not invisible to the
  // cron forever. Capped at 10 pages to bound one run.
  const out: Cust[] = [];
  let page: string | undefined;
  let searchOk = false;
  for (let p = 0; p < 10; p++) {
    const params = new URLSearchParams({ query, limit: "100", ...(page ? { page } : {}) });
    const res = await stripeGet(secretKey, `/customers/search?${params}`);
    if (!res.ok) break;
    searchOk = true;
    const list = (res.data["data"] as Raw[] | undefined) ?? [];
    for (const c of list) out.push({ id: c.id, email: c.email, name: c.name, metadata: c.metadata ?? {} });
    const next = typeof res.data["next_page"] === "string" ? (res.data["next_page"] as string) : "";
    if (!next) break;
    page = next;
  }
  // The list fallback is only for a failed search — a search that ran
  // and found nothing means there is nothing to list.
  if (searchOk) return out;
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return [];
  const list = (listRes.data["data"] as Raw[] | undefined) ?? [];
  return list
    .map((c) => ({ id: c.id, email: c.email, name: c.name, metadata: c.metadata ?? {} }))
    .filter((c) => c.metadata["gh_state"] === state);
}

async function findReportSentCustomers(secretKey: string): Promise<Cust[]> {
  return findByState(secretKey, "report_sent");
}

function authed(req: Req): boolean {
  const secret = process.env["CRON_SECRET"] || process.env["ADMIN_TOKEN"] || "";
  if (!secret) return false;
  const raw = req.headers["authorization"];
  const auth = Array.isArray(raw) ? raw[0] : raw ?? "";
  const a = Buffer.from(auth, "utf8");
  const b = Buffer.from(`Bearer ${secret}`, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Reconcile the saved-card state with Stripe itself: the webhook normally
// maintains gh_payment_method, but a missing webhook secret or a dropped
// event must not hide a card that Stripe actually holds. Backfills the
// metadata cache when a card is found — but only an UNAMBIGUOUS one
// (C13): several cards with no booking signal means no backfill, and
// the booking is skipped by selection instead of charged on a guessed
// card. chargeVisit still prefers the booking's card_confirmed event
// at charge time.
async function reconcileCard(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string> },
): Promise<string> {
  const existing = customer.metadata["gh_payment_method"] ?? "";
  if (existing) return existing;
  const res = await stripeGet(
    secretKey,
    `/customers/${encodeURIComponent(customer.id)}/payment_methods?${new URLSearchParams({ type: "card", limit: "10" })}`,
  );
  if (!res.ok) return "";
  const list = (res.data["data"] as Array<{ id: string }> | undefined) ?? [];
  const picked = pickCard(list);
  if (picked.status !== "ok") return "";
  const pm = picked.pm;
  const patch: Record<string, string> = { "metadata[gh_payment_method]": pm };
  const state = customer.metadata["gh_state"] ?? "";
  if (!state || state === "awaiting_card" || state === "card_failed") {
    patch["metadata[gh_state]"] = "card_ready";
  }
  await stripePost(secretKey, `/customers/${customer.id}`, patch);
  customer.metadata["gh_payment_method"] = pm;
  if (patch["metadata[gh_state]"]) customer.metadata["gh_state"] = "card_ready";
  return pm;
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const log = (step: string, info?: unknown) =>
    console.log(JSON.stringify({ requestId, step, info }));
  const logErr = (step: string, err: unknown) =>
    console.error(
      JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }),
    );

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }
  const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
  if (!STRIPE_SECRET_KEY) {
    logErr("config", "STRIPE_SECRET_KEY missing");
    res.status(500).json({ requestId, ok: false, error: "server_error" });
    return;
  }
  if (!process.env["CRON_SECRET"] && !process.env["ADMIN_TOKEN"]) {
    logErr("config", "no CRON_SECRET / ADMIN_TOKEN configured — refusing to run");
    res.status(500).json({ requestId, ok: false, error: "server_error" });
    return;
  }
  if (!authed(req)) {
    res.status(401).json({ requestId, ok: false, error: "unauthorized" });
    return;
  }

  try {
    const now = Date.now();
    const candidates = await findReportSentCustomers(STRIPE_SECRET_KEY);
    for (const candidate of candidates) {
      const contact = await bookingEmailContact(candidate.metadata["gh_booking_id"] ?? "", candidate.email ?? "", candidate.name ?? "");
      candidate.name = contact.name;
    }
    // DB pass: reports sent for bookings the shared customer is not
    // currently bound to (invisible to the metadata search above).
    // N27: the DB pass is the ordered source of truth — pages of 50
    // by report_sent_at ascending (oldest first), up to 200 rows, so a
    // due charge cannot starve behind an arbitrary Stripe-search
    // order. A page that repeats already-seen booking ids stops the
    // walk (a backend that ignores offset would otherwise repeat the
    // same page forever).
    try {
      if (dbConfigured()) {
        const seen = new Set(candidates.map((c) => c.metadata["gh_booking_id"]));
        let offset = 0;
        for (let page = 0; page < 4; page++) {
          const rows = await dbSelect<BookingRow>(
            "gh_visits",
            `report_status=eq.sent&order=report_sent_at.asc&limit=50&offset=${offset}`,
          );
          if (rows.length === 0) break;
          offset += rows.length;
          // A page that repeats booking ids seen before means the
          // backend ignored offset — stop instead of looping the same
          // page. A page of new ids that simply has no Stripe customer
          // yet is NOT a reason to stop: later pages may resolve.
          const seenBefore = new Set(seen);
          const repeated = rows.some((r) => r.booking_id && seenBefore.has(r.booking_id));
          let newIds = 0;
          for (const r of rows) {
            if (!r.booking_id || seen.has(r.booking_id) || !r.client_email) continue;
            seen.add(r.booking_id);
            newIds++;
            const byRow = r.stripe_customer_id
              ? await resolveCustomerByRowId(
                  (id) => stripeGet(STRIPE_SECRET_KEY, `/customers/${encodeURIComponent(id)}`),
                  r.stripe_customer_id, r.client_email)
              : null;
            const cust = byRow
              ? { id: byRow.id, metadata: byRow.metadata ?? {}, email: byRow.email, name: byRow.name }
              : await findCustomerByEmail(STRIPE_SECRET_KEY, r.client_email, r.booking_id);
            if (!cust) continue;
            const events = await bookingEvents(r.booking_id);
            await hydrateCustomerMeta(STRIPE_SECRET_KEY, cust, r, events);
            const contact = await bookingEmailContact(r.booking_id, r.client_email, cust.name ?? "");
            candidates.push({ id: cust.id, email: cust.email, name: contact.name, metadata: cust.metadata });
          }
          if (newIds === 0 && repeated) break;
          if (rows.length < 50) break;
        }
      }
    } catch (err) {
      logErr("db_pass", err);
    }
    // N27: deterministic oldest-first order for every pass below
    // (reminders, then the MAX_PER_RUN charge slice): the longest-waiting
    // report is always served first, whatever order Stripe returned.
    sortCandidatesOldestFirst(candidates);
    // Reconcile saved cards with Stripe before selecting due charges: a
    // booking whose card-save webhook was missed still has its card.
    for (const c of candidates) {
      if (!c.metadata["gh_payment_method"]) {
        try {
          await reconcileCard(STRIPE_SECRET_KEY, c);
        } catch {
          /* selection below simply skips it, as before */
        }
      }
    }
    // --- Reminder pass (runs BEFORE the charge loop): a report waiting
    // 20+ hours gets ONE reminder before its auto-charge, so the charge
    // never surprises the client. Same guards as the charge itself
    // (no issue, no bounce). The charge loop below never charges a
    // report in the same run that first reminded it, nor one that was
    // never reminded while reminders are enabled: a late-discovered
    // report therefore charges one run later, not in the ambush run.
    let reminded = 0;
    const remindedThisRun = new Set<string>();
    const RESEND_API_KEY = process.env["RESEND_API_KEY"];
    // --- Early reminder pass (runs BEFORE the 20h reminder pass): a
    // report waiting 4+ hours gets ONE early heads-up, so a client who
    // forgot still hears from us long before the 24h charge. It uses its
    // OWN flag (gh_early_reminded_at) and journal event
    // (early_reminder_sent): it never satisfies the 20h reminder pass
    // nor the charge loop's reminder-before-charge guard, so the 20h
    // reminder still fires and the charge still waits for it. Fires
    // only inside the 4h..20h window: a report discovered after 20h
    // gets the 20h reminder only, never two reminders in one run.
    let earlyReminded = 0;
    if (RESEND_API_KEY) {
      for (const c of candidates) {
        // M8: cap the early-reminder pass like the charges.
        if (earlyReminded + reminded >= MAX_REMINDERS_PER_RUN) break;
        const m = c.metadata;
        // C18: the flag alone proves nothing — it may belong to a
        // previous visit of the same (shared) customer. Only a flag
        // FOR this booking counts as "already reminded": _for must
        // name this booking, or be absent (legacy shape — then assume
        // it is this booking's, never duplicate). A _for naming
        // another booking means this visit was never early-reminded,
        // so the N29 bounce check below does not apply either.
        const earlyForThisBooking = Boolean(m["gh_early_reminded_at"])
          && (!m["gh_early_reminder_for"] || m["gh_early_reminder_for"] === m["gh_booking_id"]);
        if (earlyForThisBooking) {
          // N29: a bounced early reminder does not count as delivered —
          // clear the flag so this run re-sends it.
          if (!m["gh_booking_id"] || !(await reminderBouncedAfter(m["gh_booking_id"], m["gh_early_reminded_at"], "early_reminder_bounced"))) continue;
          await stripePost(STRIPE_SECRET_KEY, `/customers/${c.id}`, { "metadata[gh_early_reminded_at]": "" });
          m["gh_early_reminded_at"] = "";
        }
        if (m["gh_issue_open"] === "1" || m["gh_issue_ever"] === "1") continue;
        if (m["gh_report_bounced"] === "1") continue;
        const sentMs = Date.parse(m["gh_report_sent_at"] ?? "");
        if (!Number.isFinite(sentMs)) continue;
        if (m["gh_state"] === "paid") continue;
        // Fix round 2: a future-dated sent report gets no reminder —
        // the client must not be told "you'll be charged in 24h"
        // before the visit has happened. Same effective date as
        // selectDue (confirmed date wins, else scheduled date).
        if (isFutureVisitDate(m["gh_confirmed_date"] || m["gh_visit_date"] || "", now)) continue;
        if (sentMs + 4 * 3600 * 1000 > now) continue;
        if (sentMs + 20 * 3600 * 1000 <= now) continue;
        if (!c.email) continue;
        try {
          // The report link needs a fresh booking token.
          const key = createHash("sha256")
            .update(`gatehouse-booking-link:${process.env["BOOKING_LINK_SECRET"] || STRIPE_SECRET_KEY}`)
            .digest();
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const payload = JSON.stringify({
            bid: m["gh_booking_id"] ?? "", email: c.email, name: c.name ?? "",
            ts: Math.floor(Date.now() / 1000),
          });
          const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
          const token = "v2." + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
          const deadline = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", timeZoneName: "short",
          }).format(new Date(sentMs + 24 * 3600 * 1000));
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
              to: [c.email],
              reply_to: "hello@gatehousehomecleaning.com",
              subject: "Your cleaning report is ready — a quick look",
              html: emailDocument({ firstName: (c.name || "there").split(/\s+/)[0], heading: "Your report is ready to review", paragraphs: ["Open your photos and checklist. Choose Approve & pay if everything looks good, or Report an issue if something needs attention.", `Review by ${deadline} (Atlanta time). Approving charges the agreed visit amount immediately. Otherwise automatic payment follows the 24-hour rule unless you report an issue.`], action: { url: `https://www.gatehousehomecleaning.com/report?bt=${token}`, label: "Review my cleaning" } }),
              text:
                `Hi ${(c.name || "").trim().split(/\s+/)[0] || "there"},\n\nYour photo report is ready — please take a quick look.\n\nhttps://www.gatehousehomecleaning.com/report?bt=${token}\n\n` +
                `If everything looks good, tap Approve. If something isn't right, tap "Report an issue" — that pauses the charge while we make it right.\n\n` +
                `As agreed, if we don't hear from you by ${deadline}, the visit is charged automatically.\n\nGatehouse Home Cleaning\n`,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) {
            // N29: keep the Resend id — the bounce webhook matches it
            // to this booking, so a bounced reminder is journaled and
            // never counts as delivered.
            let sentEmailId = "";
            try {
              const sent = (await resp.json()) as { id?: string };
              if (typeof sent.id === "string") sentEmailId = sent.id;
            } catch { /* the Resend id is best-effort */ }
            await stripePost(STRIPE_SECRET_KEY, `/customers/${c.id}`, {
              "metadata[gh_early_reminded_at]": new Date().toISOString(),
              ...(m["gh_booking_id"] ? { "metadata[gh_early_reminder_for]": m["gh_booking_id"] } : {}),
            });
            if (m["gh_booking_id"]) {
              const vrows = await dbSelect<{ id: string }>(
                "gh_visits",
                `booking_id=eq.${encodeURIComponent(m["gh_booking_id"])}&order=visit_no.desc&limit=1`,
              );
              await logEvent(vrows[0]?.id ?? null, m["gh_booking_id"], "system", "early_reminder_sent", sentEmailId ? { email_id: sentEmailId } : {});
            }
            earlyReminded++;
          }
        } catch (err) {
          logErr("early_reminder", err);
        }
      }
    }
    if (RESEND_API_KEY) {
      for (const c of candidates) {
        // M8: cap the 20h-reminder pass like the charges — the cap is
        // shared with the early pass above, so one run sends at most
        // MAX_REMINDERS_PER_RUN reminders in total.
        if (earlyReminded + reminded >= MAX_REMINDERS_PER_RUN) break;
        const m = c.metadata;
        // C18: same per-booking rule as the early pass — a flag whose
        // _for names another booking does not satisfy this visit.
        const remindedForThisBooking = Boolean(m["gh_reminded_at"])
          && (!m["gh_reminder_for"] || m["gh_reminder_for"] === m["gh_booking_id"]);
        if (remindedForThisBooking) {
          // N29: a bounced 20h reminder does not count as delivered —
          // clear the flag so this run re-sends it; the charge guard
          // below also refuses to charge on a bounced reminder.
          if (!m["gh_booking_id"] || !(await reminderBouncedAfter(m["gh_booking_id"], m["gh_reminded_at"], "reminder_bounced"))) continue;
          await stripePost(STRIPE_SECRET_KEY, `/customers/${c.id}`, { "metadata[gh_reminded_at]": "" });
          m["gh_reminded_at"] = "";
        }
        if (m["gh_issue_open"] === "1" || m["gh_issue_ever"] === "1") continue;
        if (m["gh_report_bounced"] === "1") continue;
        const sentMs = Date.parse(m["gh_report_sent_at"] ?? "");
        if (!Number.isFinite(sentMs)) continue;
        if (m["gh_state"] === "paid") continue;
        // Fix round 2: a future-dated sent report gets no reminder —
        // the client must not be told "you'll be charged in 24h"
        // before the visit has happened. Same effective date as
        // selectDue (confirmed date wins, else scheduled date).
        if (isFutureVisitDate(m["gh_confirmed_date"] || m["gh_visit_date"] || "", now)) continue;
        if (sentMs + 20 * 3600 * 1000 > now) continue;
        if (!c.email) continue;
        try {
          // The report link needs a fresh booking token.
          const key = createHash("sha256")
            .update(`gatehouse-booking-link:${process.env["BOOKING_LINK_SECRET"] || STRIPE_SECRET_KEY}`)
            .digest();
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const payload = JSON.stringify({
            bid: m["gh_booking_id"] ?? "", email: c.email, name: c.name ?? "",
            ts: Math.floor(Date.now() / 1000),
          });
          const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
          const token = "v2." + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
          const deadline = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", timeZoneName: "short",
          }).format(new Date(sentMs + 24 * 3600 * 1000));
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
              to: [c.email],
              reply_to: "hello@gatehousehomecleaning.com",
              subject: "Reminder: your cleaning report is waiting",
              html: emailDocument({ firstName: (c.name || "there").split(/\s+/)[0], heading: "Your cleaning report is waiting", paragraphs: ["Please review your photos and checklist. Use Report an issue on your visit page if something was missed; this blocks automatic payment for this visit.", `Review by ${deadline} (Atlanta time). Approving charges the agreed visit amount immediately.`], action: { url: `https://www.gatehousehomecleaning.com/report?bt=${token}`, label: "Review my cleaning" } }),
              text:
                `Hi ${(c.name || "").trim().split(/\s+/)[0] || "there"},\n\nA quick reminder: your photo report is still waiting for a look.\n\nhttps://www.gatehousehomecleaning.com/report?bt=${token}\n\n` +
                `If everything looks good, tap Approve. If something isn't right, tap "Report an issue" — that pauses the charge while we make it right.\n\n` +
                // M4: the reply_to of this reminder is hello@, not the
                // signed report-reply address, so a reply here does NOT
                // open a dispute automatically. Never tell the client
                // to reply — point them at "Report an issue" on the
                // report page instead.
                `${sentMs + 24 * 3600 * 1000 <= now ? "The 24-hour review period has ended. If something isn't right, tap \"Report an issue\" on your report page — we'll review it with you." : `As agreed, if we don't hear from you by ${deadline}, the visit is charged automatically.`}\n\nGatehouse Home Cleaning\n`,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) {
            // N29: keep the Resend id — see the early-reminder pass.
            let sentEmailId = "";
            try {
              const sent = (await resp.json()) as { id?: string };
              if (typeof sent.id === "string") sentEmailId = sent.id;
            } catch { /* the Resend id is best-effort */ }
            await stripePost(STRIPE_SECRET_KEY, `/customers/${c.id}`, {
              "metadata[gh_reminded_at]": new Date().toISOString(),
              ...(m["gh_booking_id"] ? { "metadata[gh_reminder_for]": m["gh_booking_id"] } : {}),
            });
            if (m["gh_booking_id"]) {
              const vrows = await dbSelect<{ id: string }>(
                "gh_visits",
                `booking_id=eq.${encodeURIComponent(m["gh_booking_id"])}&order=visit_no.desc&limit=1`,
              );
              await logEvent(vrows[0]?.id ?? null, m["gh_booking_id"], "system", "reminder_sent", sentEmailId ? { email_id: sentEmailId } : {});
              remindedThisRun.add(m["gh_booking_id"]);
            }
            reminded++;
          }
        } catch (err) {
          logErr("reminder", err);
        }
      }
    }

    const due = selectDue(candidates, now).slice(0, MAX_PER_RUN);
    let charged = 0;
    let failed = 0;
    let skipped = 0;
    let syncNeeded = 0;

    for (const item of due) {
      try {
        // Reminder-before-charge: never charge a report in the run that
        // first reminded it, and never charge one that was never
        // reminded while reminders are enabled. Fail open only when the
        // journal is unreadable — a DB outage cannot stall charges, the
        // next run retries the reminder, and the panel still shows the
        // failure. A MISSING reminder channel fails CLOSED (G3): with no
        // RESEND_API_KEY no reminder was ever sent, so charging would
        // surprise a client who never heard from us — the item waits.
        if (!RESEND_API_KEY) {
          skipped++;
          log("skip_no_reminder_channel", { booking: item.bookingId });
          continue;
        }
        if (dbConfigured()) {
          let firstReminder = remindedThisRun.has(item.bookingId);
          if (!firstReminder) {
            try {
              // N29 + G3: the latest reminder event decides — a bounce
              // after the send means the client was never reminded, so
              // the charge waits for a fresh reminder — AND the reminder
              // must belong to the CURRENT publication
              // (latestCurrentEvent): a reminder sent for a publication
              // that was later replaced never satisfies the guard.
              // Filtered client-side too, so a backend that ignores the
              // `in.` filter cannot mistake an unrelated journal event
              // for a reminder.
              const prior = await dbSelect<{ created_at: string; event: string; detail: Record<string, unknown> | null }>(
                "gh_events",
                `booking_id=eq.${encodeURIComponent(item.bookingId)}&event=in.(reminder_sent,reminder_bounced,reminders_rearmed,report_sent)&order=created_at.desc&limit=10`,
              );
              const latest = latestCurrentEvent(prior, ["reminder_sent", "reminder_bounced"]);
              firstReminder = !latest || latest.event === "reminder_bounced";
            } catch {
              firstReminder = false;
            }
          }
          if (firstReminder) {
            skipped++;
            log("skip_first_reminder", { booking: item.bookingId });
            continue;
          }
        }
        // Row-resolved obligation (RA01/RA04/RA06): the due item came
        // from shared customer metadata, which may describe another
        // booking of this email. Amount, version and publication time
        // are re-resolved from the visit's own row + journal at charge
        // time — a stale or foreign metadata version never mints a
        // second payment, and a republication resets the 24h clock.
        // A database read failure skips the item (sync_needed), it
        // never falls back to metadata (RA04).
        let vrow: { id: string; client_email: string | null; amount_cents: number | null; status: string | null } | null = null;
        let rowUnreadable = false;
        if (dbConfigured()) {
          const strict = await dbSelectStrict<{ id: string; client_email: string | null; amount_cents: number | null; status: string | null }>(
            "gh_visits",
            `booking_id=eq.${encodeURIComponent(item.bookingId)}&order=visit_no.desc&limit=1`,
          );
          if (!strict.ok) {
            rowUnreadable = true;
          } else {
            vrow = strict.rows[0] ?? null;
          }
        }
        if (rowUnreadable) {
          syncNeeded++;
          log("skip_row_unreadable", { booking: item.bookingId });
          continue;
        }
        if (vrow) {
          const outcome = await chargeVisit({
            secretKey: STRIPE_SECRET_KEY,
            bookingId: item.bookingId,
            customerId: item.customerId,
            customerEmail: item.customerEmail,
            paymentMethod: item.paymentMethod,
            source: "timer_24h",
            allowedBases: ["timer_rule", "client_approved"],
            requestedAmountCents: item.amountCents,
            nowMs: now,
            deps: {
              setCustomerMeta: async (patch) => {
                const params: Record<string, string> = {};
                for (const [k, v] of Object.entries(patch)) params[`metadata[${k}]`] = v;
                await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, params);
              },
              sendReceipt: (cents) => sendReceiptEmailOnce(STRIPE_SECRET_KEY, item.customerId, {
                gh_state: "paid",
                gh_report_amount_cents: String(cents),
              }, item.bookingId),
              sendPaymentFailedEmail: async (visitId) => {
                await sendPaymentFailedEmailOnce(
                  STRIPE_SECRET_KEY, item.customerId, item.bookingId, visitId,
                );
              },
            },
          });
          if (outcome.outcome === "paid") {
            charged++;
            log("charged", { booking: item.bookingId, amount: item.amountCents, adopted: outcome.adopted });
          } else if (outcome.outcome === "failed") {
            failed++;
            logErr("charge_failed", `${item.bookingId}: ${outcome.detail}`);
          } else if (outcome.outcome === "unknown") {
            syncNeeded++;
            log("sync_needed", { booking: item.bookingId, error: outcome.error });
          } else {
            skipped++;
            log("skip_charge", { booking: item.bookingId, outcome: outcome.outcome, error: (outcome as { error?: string }).error ?? "" });
          }
          continue;
        }
        // No visit row: not chargeable (N08). Shared metadata is
        // not proof of amount, consent, payment or absence of a
        // dispute, so a booking without a durable row needs an
        // explicit migration record first — never a metadata charge.
        skipped++;
        log("skip_no_row", { booking: item.bookingId });
        continue;
      } catch (err) {
        failed++;
        logErr("charge_exception", `${item.bookingId}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
            "metadata[gh_state]": "payment_failed",
          });
        } catch {
          /* ignore */
        }
        try {
          const vrows = await dbSelect<{ id: string }>(
            "gh_visits",
            `booking_id=eq.${encodeURIComponent(item.bookingId)}&order=visit_no.desc&limit=1`,
          );
          await logEvent(vrows[0]?.id ?? null, item.bookingId, "system", "payment_failed", {
            source: "timer_24h",
            error: String(err instanceof Error ? err.message : String(err)).slice(0, 200),
          });
          await sendPaymentFailedEmailOnce(STRIPE_SECRET_KEY, item.customerId, item.bookingId, vrows[0]?.id ?? null);
        } catch { /* journal + email are best-effort; the meta flag still surfaces the failure */ }
      }
    }

    // --- Sync-recovery pass (RA11): a Stripe success whose row write
    // was lost (meta paid, row not paid) is repaired WITHOUT a new
    // charge — the verified mirror, counted as synced, never charged.
    let synced = 0;
    try {
      if (dbConfigured()) {
        const paidCustomers = await findByState(STRIPE_SECRET_KEY, "paid");
        for (const c of paidCustomers) {
          const bid = c.metadata["gh_booking_id"];
          const lastPi = c.metadata["gh_last_payment"];
          if (!bid || !lastPi) continue;
          const strict = await dbSelectStrict<{ id: string; status: string | null; payment_intent_id: string | null; amount_cents: number | null }>(
            "gh_visits",
            `booking_id=eq.${encodeURIComponent(bid)}&order=visit_no.desc&limit=1`,
          );
          if (!strict.ok) {
            syncNeeded++;
            continue;
          }
          const vrow = strict.rows[0];
          if (!vrow || vrow.status === "paid") continue;
          // N08: shared metadata is only a HINT. Before repairing a
          // row to paid, verify the real intent at Stripe: it must
          // belong to THIS booking, THIS customer, the pinned amount,
          // USD, the cleaning kind, and be succeeded. A foreign intent
          // (another booking's, a fee intent, a wrong amount, a
          // pending/failed intent) never marks a cleaning paid.
          if (vrow.payment_intent_id && vrow.payment_intent_id !== lastPi) {
            log("skip_sync_conflict", { booking: bid });
            continue;
          }
          const got = await getIntent(STRIPE_SECRET_KEY, lastPi);
          if (got.status === "error") {
            syncNeeded++;
            continue;
          }
          const vAmount = typeof vrow.amount_cents === "number" ? vrow.amount_cents : NaN;
          const mismatch = !Number.isFinite(vAmount)
            ? "amount_missing"
            : verifyIntentForObligation(got.intent, {
                amountCents: vAmount, currency: "usd", customerId: c.id, bookingId: bid,
              });
          if (mismatch || got.intent.status !== "succeeded") {
            log("skip_sync_unverified", { booking: bid, reason: mismatch ?? got.intent.status });
            continue;
          }
          const n = await dbUpdateCount(
            "gh_visits",
            `id=eq.${vrow.id}&status=neq.paid`,
            { status: "paid", paid_at: new Date().toISOString(), payment_intent_id: lastPi },
          );
          if (n === 1) {
            await logEvent(vrow.id, bid, "system", "payment_succeeded", {
              via: "timer_sync_recovery", payment_intent: lastPi,
            });
            synced++;
          } else if (n < 0) {
            syncNeeded++;
          }
        }
      }
    } catch (err) {
      logErr("sync_recovery", err);
    }

    // Delete eligible photo rows themselves, so completed/empty visits cannot
    // starve later visits. Keep the pointer until Storage confirms deletion.
    let retentionDeleted = 0;
    let retentionFailed = 0;
    try {
      if (dbConfigured()) {
        const cutoff = new Date(now - 90 * 24 * 3600 * 1000).toISOString();
        const batches = [
          `gh_visits.report_sent_at=lt.${encodeURIComponent(cutoff)}`,
          `gh_visits.report_sent_at=is.null&created_at=lt.${encodeURIComponent(cutoff)}`,
        ];
        const seen = new Set<string>();
        for (const match of batches) {
          const photos = await dbSelect<{ id: string; visit_id: string; storage_path: string; gh_visits?: { booking_id?: string; issue_open?: boolean | null; issue_ever?: boolean | null } }>(
            "gh_photos", `select=id,visit_id,storage_path,gh_visits!inner(booking_id,report_sent_at,issue_open,issue_ever)&${match}&order=created_at.asc&limit=200`,
          );
          for (const photo of photos) {
            if (seen.has(photo.id)) continue;
            seen.add(photo.id);
            // Task 4 (12.11.2026): a disputed visit's photos are
            // evidence for the complaint / a later chargeback — never
            // delete them by age while the issue is open or ever
            // existed. The 90-day retention (Privacy policy) applies
            // to clean visits only.
            if (photo.gh_visits?.issue_open === true || photo.gh_visits?.issue_ever === true) continue;
            if (!await storageRemove(photo.storage_path)) { retentionFailed++; continue; }
            if (!await dbDelete("gh_photos", `id=eq.${photo.id}`)) { retentionFailed++; continue; }
            retentionDeleted++;
            await logEvent(photo.visit_id, photo.gh_visits?.booking_id ?? null, "system", "photos_retention_deleted", { count: 1 });
          }
        }
      }
    } catch (err) { retentionFailed++; logErr("retention", err); }

    // M5: orphan-photo cleanup — objects signed for upload but never
    // registered (the sign→register gap) are NOT covered by the 90-day
    // retention pass above (it only deletes REGISTERED photos). The
    // cron runs it here, best-effort. No free Vercel cron slot exists
    // (both slots are this endpoint, 10:00 and 22:00), so this
    // piggybacks the existing run instead of a new schedule. There is
    // no on-demand endpoint: api/_storage-cleanup.ts is a helper, not
    // a route (Vercel Hobby allows 12 functions and the site has 12).
    let orphanPhotosDeleted = 0;
    let orphanPhotosFailed = 0;
    try {
      const orphan = await cleanupOrphanPhotos({ nowMs: now });
      orphanPhotosDeleted = orphan.deleted;
      orphanPhotosFailed = orphan.failed;
    } catch (err) {
      logErr("orphan_cleanup", err);
    }

    // --- Receipt-retry pass (N13): a paid visit whose receipt email
    // failed earlier gets the EMAIL resent — never the payment (§7:
    // retry the letter, not the charge). The marker is PER BOOKING
    // (row receipt_email_id, or a payment_succeeded journal event
    // with receipt_sent true) — never the shared customer's metadata
    // flag, which belongs to whatever booking the customer is
    // currently bound to and used to suppress other bookings'
    // receipts. The amount comes from the visit's own pinned amount.
    // M10: the old pass fetched an arbitrary 50 paid visits
    // (status=eq.paid, no order, no receipt filter), so a visit
    // missing its receipt could starve forever behind 50 already-
    // receipted ones. Now the DB filters to visits actually missing
    // a receipt (no id, or a stale "claim:" placeholder whose send
    // never landed) and orders oldest-paid first, so every paid
    // visit eventually gets its receipt. The journal check below
    // (payment_succeeded with receipt_sent) stays as the second half
    // of the "missing receipt" filter.
    let receipts = 0;
    try {
      if (dbConfigured()) {
        const paidRows = await dbSelect<{
          id: string; booking_id: string; amount_cents: number | null; receipt_email_id: string | null;
          client_email: string | null; paid_at: string | null;
        }>(
          "gh_visits",
          `status=eq.paid&or=(receipt_email_id.is.null,receipt_email_id.like.claim:*)&order=paid_at.asc.nullslast&limit=50`,
        );
        for (const prow of paidRows) {
          if (!prow.booking_id) continue;
          if (prow.receipt_email_id && !prow.receipt_email_id.startsWith("claim:")) continue;
          const evs = await bookingEvents(prow.booking_id);
          if (evs.some((e) => e.event === "payment_succeeded"
            && (e.detail?.["receipt_sent"] === true))) continue;
          // Resolve the Stripe customer by the visit's own email —
          // never by the shared metadata binding, which may currently
          // point at another booking of the same client.
          if (!prow.client_email) continue;
          const match = await findCustomerByEmail(STRIPE_SECRET_KEY, prow.client_email, prow.booking_id);
          if (!match) continue;
          const sent = await sendReceiptEmailOnce(STRIPE_SECRET_KEY, match.id, {
            gh_state: "paid",
            gh_report_amount_cents: prow.amount_cents != null ? String(prow.amount_cents) : "",
          }, prow.booking_id);
          if (sent) receipts++;
        }
      }
    } catch (err) {
      logErr("receipt_retry", err);
    }

    // --- Retention pass: report photo links are deleted 90 days after
    // the report was sent (the retention the Privacy policy promises).
    // Applies to paid bookings; unpaid ones keep their evidence.
    // Task 4 (12.11.2026): a disputed visit's report links are evidence
    // too — never clear them while the issue is open or ever existed.
    // (Shared-customer caveat: the flags live on the shared customer
    // record, so they may come from another booking of the same client.
    // Over-keeping links is the safe direction; the photos themselves
    // are guarded per-visit by the pass above.)
    let cleaned = 0;
    try {
      const paid = await findByState(STRIPE_SECRET_KEY, "paid");
      for (const c of paid) {
        const m = c.metadata;
        if (!m["gh_rp_0"]) continue;
        if (m["gh_issue_open"] === "1" || m["gh_issue_ever"] === "1") continue;
        const sentMs = Date.parse(m["gh_report_sent_at"] ?? "");
        if (!Number.isFinite(sentMs)) continue;
        if (sentMs + 90 * 24 * 3600 * 1000 > now) continue;
        await stripePost(STRIPE_SECRET_KEY, `/customers/${c.id}`, {
          "metadata[gh_rp_0]": "",
          "metadata[gh_rp_1]": "",
          "metadata[gh_rp_2]": "",
          "metadata[gh_rp_3]": "",
          "metadata[gh_photos_deleted_at]": new Date().toISOString(),
        });
        cleaned++;
      }
    } catch (err) {
      logErr("retention", err);
    }

    // --- Entry reminder + retention pass (spec A §5-6): one calm
    // reminder per visit, never duplicated (journal event dedupes),
    // and expired entry rows are deleted. Runs on the existing cron
    // (twice daily), so a visit inside the next ~24-48h is caught.
    // The email contains NO entry details — only the date, window,
    // cleaner name and the instruction to choose on the visit page.
    let entryReminded = 0;
    let entryCleaned = 0;
    try {
      if (dbConfigured()) {
        const expired = await dbSelect<{ id: string }>(
          "gh_visit_access",
          `expires_at=lt.${encodeURIComponent(new Date(now).toISOString())}&limit=100`,
        );
        for (const e of expired) {
          const deleted = await dbDeleteCount("gh_visit_access", `id=eq.${encodeURIComponent(e.id)}`);
          if (deleted > 0) entryCleaned++;
        }
        // M9: the visit window is an ET window — "today"/"tomorrow"
        // are America/New_York calendar dates, not UTC dates. Around
        // midnight UTC a visit can be "tomorrow" in UTC while still
        // "today" in Atlanta (and vice versa), so the UTC window
        // reminded on the wrong day for the client. Tomorrow is
        // calendar arithmetic on the NY date, so DST never skews it.
        const nyDay = (ms: number) =>
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/New_York",
            year: "numeric", month: "2-digit", day: "2-digit",
          }).format(new Date(ms));
        const today = nyDay(now);
        const [nyY, nyM, nyD] = today.split("-").map(Number);
        const tomorrow = new Date(Date.UTC(nyY, nyM - 1, nyD + 1)).toISOString().slice(0, 10);
        const rows = await dbSelect<{
          id: string; booking_id: string; client_email: string | null; client_name?: string | null; cleaner_name: string | null;
          visit_date: string | null; window: string | null; status: string | null; report_sent_at: string | null;
          entry_reminder_sent: boolean | null;
          entry_method: string | null;
        }>(
          "gh_visits",
          `visit_date=gte.${today}&visit_date=lte.${tomorrow}&limit=50`,
        );
        const RESEND_KEY = process.env["RESEND_API_KEY"];
        for (const r of rows) {
          if (!r.booking_id || !r.client_email || !r.cleaner_name) continue;
          if (r.status === "cancelled" || r.report_sent_at) continue;
          if (r.entry_reminder_sent) continue;
          // Quote-time choice settles the reminder too: a meeting
          // choice needs no code, so reminding would be noise.
          if (r.entry_method === "home" || r.entry_method === "other_person") continue;
          const evs = await bookingEvents(r.booking_id);
          if (!evs.some((e) => e.event === "visit_confirmed")) continue;
          if (evs.some((e) => e.event === "entry_reminder_sent")) continue;
          const acc = await loadAccess(r.id);
          if (acc?.entry_method) continue;
          // Arrange-before WITH saved details is settled as well.
          if (r.entry_method === "arrange_before" && acc?.entry_secret) continue;
          if (!RESEND_KEY) continue;
          // N12: ATOMIC claim before sending. The two daily cron
          // runs used to both see "no journal event" and both email.
          // The winner claims entry_reminder_sent=true by CAS; the
          // loser sees the claim and skips. If the send fails or its
          // outcome is unknown, the claim is RELEASED (false) so a
          // later run retries — an unknown send never becomes a
          // duplicate and never becomes a lost reminder.
          const claimed = await dbUpdateCount(
            "gh_visits",
            `id=eq.${r.id}&entry_reminder_sent=neq.true`,
            { entry_reminder_sent: true },
          );
          if (claimed !== 1) continue;
          let sent = false;
          try {
            const resp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
                to: [r.client_email],
                reply_to: "hello@gatehousehomecleaning.com",
                subject: `Before your cleaning ${emailDate(r.visit_date ?? "")} — arrange entry`,
                html: emailDocument({ firstName: (r.client_name ?? "there").split(/\s+/)[0], heading: "How should your cleaner get in?", paragraphs: [`Your visit: ${emailDate(r.visit_date ?? "")} · ${emailArrivalWindow(r.window ?? "")}. Cleaner: ${r.cleaner_name}.`, "You can meet your cleaner — no code needed. Open your visit page to choose how to arrange entry. Entry details are never included in this email."], action: { url: clientVisitLink(STRIPE_SECRET_KEY, { bid: r.booking_id, email: r.client_email, name: r.client_name ?? "" }), label: "Arrange entry" } }),
                text: `Hi there,\n\nYour cleaning is coming up on ${emailDate(r.visit_date ?? "")}${r.window ? ` (${emailArrivalWindow(r.window)})` : ""} with ${r.cleaner_name}.\n\nWe still need to know how your cleaner should get in. Please open your visit page: ${clientVisitLink(STRIPE_SECRET_KEY, { bid: r.booking_id, email: r.client_email, name: r.client_name ?? "" })}\n\nChoose one: you will be home, someone else will meet the cleaner, or you will arrange entry before the visit.\n\nIf you will be home, no codes are needed.\n\nGatehouse Home Cleaning\n`,
              }),
              signal: AbortSignal.timeout(15000),
            });
            sent = resp.ok;
          } catch { sent = false; }
          if (!sent) {
            await dbUpdate("gh_visits", `id=eq.${r.id}`, { entry_reminder_sent: false });
            continue;
          }
          await logEvent(r.id, r.booking_id, "system", "entry_reminder_sent");
          entryReminded++;
        }
      }
    } catch (err) {
      logErr("entry_reminder", err);
    }

    log("run_complete", { checked: candidates.length, due: due.length, charged, skipped, failed, reminded, early_reminded: earlyReminded, cleaned, receipts, synced, sync_needed: syncNeeded, entry_reminded: entryReminded, entry_cleaned: entryCleaned, orphan_photos_deleted: orphanPhotosDeleted, orphan_photos_failed: orphanPhotosFailed });
    res.status(200).json({
      requestId, ok: true,
      checked: candidates.length, due: due.length, charged, skipped, failed, reminded, early_reminded: earlyReminded, cleaned, receipts, synced, sync_needed: syncNeeded,
      entry_reminded: entryReminded, entry_cleaned: entryCleaned, photo_retention_deleted: retentionDeleted, photo_retention_failed: retentionFailed,
      orphan_photos_deleted: orphanPhotosDeleted, orphan_photos_failed: orphanPhotosFailed,
    });
  } catch (error: unknown) {
    logErr("unexpected", error);
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
