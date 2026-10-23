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
import { sendReceiptEmailOnce } from "./booking-action.js";
import { dbConfigured, dbSelect, logEvent } from "./_db.js";

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
const evStr = (ev: BookingEvent | null, key: string): string =>
  ev && typeof ev.detail?.[key] === "string" ? (ev.detail[key] as string) : "";
async function findCustomerByEmail(
  secretKey: string,
  email: string,
): Promise<{ id: string; metadata: Record<string, string>; email?: string; name?: string } | null> {
  const query = `email:'${email.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "10" })}`);
  const list = res.ok
    ? ((res.data["data"] as Array<{ id: string; metadata?: Record<string, string>; email?: string; name?: string }> | undefined) ?? [])
    : [];
  return list.length > 0
    ? { id: list[0].id, metadata: list[0].metadata ?? {}, email: list[0].email, name: list[0].name }
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
  const issueOpen = Boolean(opened && (!resolved || resolved.created_at < opened.created_at));
  const cancelledEv = latestEvent(events, "visit_cancelled");
  const approvedEv = latestEvent(events, "report_approved");
  const remindedEv = latestEvent(events, "reminder_sent");
  const state = row.status === "paid" ? "paid"
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
    gh_cleaner_name: row.cleaner_name ?? "",
    gh_issue_open: issueOpen ? "1" : "",
    gh_issue_ever: opened ? "1" : "",
    gh_reminded_at: remindedEv ? remindedEv.created_at : "",
  };
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) params[`metadata[${k}]`] = v;
  await stripePost(secretKey, `/customers/${customer.id}`, params);
  Object.assign(customer.metadata, values);
}

const STRIPE_API = "https://api.stripe.com/v1";
const MAX_PER_RUN = 25;

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
      bookingId,
      amountCents: amount,
      reportVersion: parseInt(m["gh_report_version"] ?? "1", 10) || 1,
      paymentMethod,
    });
  }
  return out;
}

async function findByState(secretKey: string, state: string): Promise<Cust[]> {
  const query = `metadata['gh_state']:'${state}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "100" })}`);
  type Raw = { id: string; email?: string; name?: string; metadata?: Record<string, string> };
  if (res.ok) {
    const list = (res.data["data"] as Raw[] | undefined) ?? [];
    return list.map((c) => ({ id: c.id, email: c.email, name: c.name, metadata: c.metadata ?? {} }));
  }
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
// metadata cache when a card is found.
async function reconcileCard(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string> },
): Promise<string> {
  const existing = customer.metadata["gh_payment_method"] ?? "";
  if (existing) return existing;
  const res = await stripeGet(
    secretKey,
    `/customers/${encodeURIComponent(customer.id)}/payment_methods?${new URLSearchParams({ type: "card", limit: "1" })}`,
  );
  if (!res.ok) return "";
  const list = (res.data["data"] as Array<{ id: string }> | undefined) ?? [];
  const pm = list[0]?.id ?? "";
  if (!pm) return "";
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
    // DB pass: reports sent for bookings the shared customer is not
    // currently bound to (invisible to the metadata search above).
    try {
      if (dbConfigured()) {
        const rows = await dbSelect<BookingRow>(
          "gh_visits",
          "report_status=eq.sent&order=report_sent_at.asc&limit=50",
        );
        const seen = new Set(candidates.map((c) => c.metadata["gh_booking_id"]));
        for (const r of rows) {
          if (!r.booking_id || seen.has(r.booking_id) || !r.client_email) continue;
          const cust = await findCustomerByEmail(STRIPE_SECRET_KEY, r.client_email);
          if (!cust) continue;
          const events = await bookingEvents(r.booking_id);
          await hydrateCustomerMeta(STRIPE_SECRET_KEY, cust, r, events);
          candidates.push({ id: cust.id, email: cust.email, name: cust.name, metadata: cust.metadata });
          seen.add(r.booking_id);
        }
      }
    } catch (err) {
      logErr("db_pass", err);
    }
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
    const due = selectDue(candidates, now).slice(0, MAX_PER_RUN);
    let charged = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of due) {
      try {
        // Fresh re-read: a client issue (or an operator charge) landing
        // since the search must win over this timer run.
        const freshRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${item.customerId}`);
        const freshMeta = (freshRes.data["metadata"] as Record<string, string> | undefined) ?? {};
        const still = selectDue([{ id: item.customerId, metadata: freshMeta }], Date.now());
        if (still.length === 0) {
          skipped++;
          log("skip_fresh_recheck", { booking: item.bookingId });
          continue;
        }
        await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
          "metadata[gh_state]": "payment_pending",
          "metadata[gh_charge_source]": "timer_24h",
        });
        const pi = await stripePost(
          STRIPE_SECRET_KEY,
          "/payment_intents",
          {
            amount: String(item.amountCents),
            currency: "usd",
            customer: item.customerId,
            payment_method: item.paymentMethod,
            off_session: "true",
            confirm: "true",
            description: `Gatehouse cleaning — booking ${item.bookingId}`,
            "metadata[gh_booking_id]": item.bookingId,
            "metadata[gh_report_version]": String(item.reportVersion),
          },
          `charge_${item.bookingId}_v${item.reportVersion}`,
        );
        if (pi.ok && pi.data["status"] === "succeeded") {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
            "metadata[gh_state]": "paid",
            "metadata[gh_last_payment]": String(pi.data["id"] ?? ""),
          });
          charged++;
          log("charged", { booking: item.bookingId, amount: item.amountCents });
        } else {
          const errMsg =
            ((pi.data["error"] as { message?: string } | undefined)?.message ??
              `payment ${String(pi.data["status"] ?? "failed")}`);
          await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
            "metadata[gh_state]": "payment_failed",
          });
          failed++;
          logErr("charge_failed", `${item.bookingId}: ${errMsg}`);
        }
      } catch (err) {
        failed++;
        logErr("charge_exception", `${item.bookingId}: ${err instanceof Error ? err.message : String(err)}`);
        // Leave the booking visible as payment_failed rather than silently
        // re-arming the timer: the idempotency key above means a manual
        // operator retry resolves to the same PaymentIntent.
        try {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${item.customerId}`, {
            "metadata[gh_state]": "payment_failed",
          });
        } catch {
          /* ignore */
        }
      }
    }

    // --- Reminder pass: a report waiting 20+ hours gets ONE reminder
    // before the 24h auto-charge, so the charge never surprises the
    // client. Same guards as the charge itself (no issue, no bounce).
    let reminded = 0;
    const RESEND_API_KEY = process.env["RESEND_API_KEY"];
    if (RESEND_API_KEY) {
      for (const c of candidates) {
        const m = c.metadata;
        if (m["gh_reminded_at"]) continue;
        if (m["gh_issue_open"] === "1" || m["gh_issue_ever"] === "1") continue;
        if (m["gh_report_bounced"] === "1") continue;
        const sentMs = Date.parse(m["gh_report_sent_at"] ?? "");
        if (!Number.isFinite(sentMs)) continue;
        if (sentMs + 20 * 3600 * 1000 > now || sentMs + 24 * 3600 * 1000 <= now) continue;
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
              from: "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
              to: [c.email],
              reply_to: "hello@gatehousehomecleaning.com",
              subject: "Reminder: your cleaning report is waiting",
              text:
                `Hi ${(c.name || "").trim().split(/\s+/)[0] || "there"},\n\nA quick reminder: your photo report is still waiting for a look.\n\nhttps://www.gatehousehomecleaning.com/report?bt=${token}\n\n` +
                `If everything looks good, tap Approve. If something isn't right, tap "Report an issue" — that pauses the charge while we make it right.\n\n` +
                `As agreed, if we don't hear from you by ${deadline}, the visit is charged automatically.\n\nNick\n\nGatehouse Home Cleaning\n`,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) {
            await stripePost(STRIPE_SECRET_KEY, `/customers/${c.id}`, {
              "metadata[gh_reminded_at]": new Date().toISOString(),
              ...(m["gh_booking_id"] ? { "metadata[gh_reminder_for]": m["gh_booking_id"] } : {}),
            });
            if (m["gh_booking_id"]) {
              const vrows = await dbSelect<{ id: string }>(
                "gh_visits",
                `booking_id=eq.${encodeURIComponent(m["gh_booking_id"])}&order=visit_no.desc&limit=1`,
              );
              await logEvent(vrows[0]?.id ?? null, m["gh_booking_id"], "system", "reminder_sent", {});
            }
            reminded++;
          }
        } catch (err) {
          logErr("reminder", err);
        }
      }
    }

    // --- Receipt-retry pass: a paid visit whose receipt email failed
    // earlier gets the EMAIL resent — never the payment (§7: retry the
    // letter, not the charge). The helper no-ops when the receipt
    // marker is already stored.
    let receipts = 0;
    try {
      const paidAll = await findByState(STRIPE_SECRET_KEY, "paid");
      for (const c of paidAll) {
        if (c.metadata["gh_receipt_email_id"]) continue;
        const bid = c.metadata["gh_booking_id"];
        if (!bid) continue;
        const sent = await sendReceiptEmailOnce(STRIPE_SECRET_KEY, c.id, c.metadata, bid);
        if (sent) receipts++;
      }
    } catch (err) {
      logErr("receipt_retry", err);
    }

    // --- Retention pass: report photo links are deleted 90 days after
    // the report was sent (the retention the Privacy policy promises).
    // Applies to paid bookings; unpaid ones keep their evidence.
    let cleaned = 0;
    try {
      const paid = await findByState(STRIPE_SECRET_KEY, "paid");
      for (const c of paid) {
        const m = c.metadata;
        if (!m["gh_rp_0"]) continue;
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

    log("run_complete", { checked: candidates.length, due: due.length, charged, skipped, failed, reminded, cleaned, receipts });
    res.status(200).json({
      requestId, ok: true,
      checked: candidates.length, due: due.length, charged, skipped, failed, reminded, cleaned, receipts,
    });
  } catch (error: unknown) {
    logErr("unexpected", error);
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
