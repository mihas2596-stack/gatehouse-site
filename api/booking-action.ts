// POST /api/booking-action
//
// Operator actions for a booking: approve | dispute | resolve | charge | status | confirm | send_report.
// "send_report" stores the photo-report URLs in customer metadata, starts
// the 24h Terms clock (gh_report_sent_at) and emails the client the
// /report portal link (client actions live in api/report.ts).
// "confirm" is the owner confirming the booking DATE with the client before
// the visit (orthogonal flag gh_booking_confirmed — it never touches the
// gh_state machine the charge path depends on) and emails the client.
// Auth: ADMIN_TOKEN env var (Bearer token). Kolya sets it in Vercel; it is
// never exposed to the browser.
//
// State lives in Stripe Customer metadata (no database):
//   gh_state: requested → awaiting_card → card_ready → approved
//             → payment_pending → paid | payment_failed
//             issue_open blocks any charge until resolved.
//   gh_booking_id, gh_payment_method, gh_issue_open, gh_report_version
//
// Safety rules (enforced server-side):
//  - charge requires state == approved AND gh_issue_open != "1"
//  - charge requires a saved payment method (gh_payment_method)
//  - every charge uses Idempotency-Key = charge_<bid>_v<report_version>
//    → double clicks, retries and webhook races cannot create a second payment
//  - amount comes from the request but is capped server-side sanity check
//  - 24h auto-charge is NOT implemented here (owner enables it explicitly)

import { z } from "zod";
import { createHmac, timingSafeEqual, randomUUID, createCipheriv, createHash, randomBytes } from "crypto";

type BookingPayload = {
  bid: string;
  email: string;
  name: string;
  ts: number;
  first?: string;
  recurring?: string;
  service?: string;
  date?: string;
};

const TOKEN_TTL_SECONDS = 60 * 24 * 3600;

const b64urlEncode = (s: string): string =>
  Buffer.from(s, "utf8").toString("base64url");
const b64urlDecode = (s: string): string =>
  Buffer.from(s, "base64url").toString("utf8");

// v2 booking-link minting (same scheme as send-contact-email /
// create-checkout-session): send_report emails the client a fresh /report
// link, so this file needs the encrypt side too.
function tokenKey(secret: string): Buffer {
  return createHash("sha256").update(`gatehouse-booking-link:${secret}`).digest();
}

function encryptBookingPayload(secret: string, payload: BookingPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2.${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
}

const bookingLinkSecret = (stripeKey: string): string =>
  process.env["BOOKING_LINK_SECRET"] || stripeKey;

const _rlHits = new Map<string, number[]>();
function rateLimit(ip: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (_rlHits.get(ip) ?? []).filter((t) => t > windowStart);
  if (arr.length >= maxPerMinute) return false;
  arr.push(now);
  _rlHits.set(ip, arr);
  if (_rlHits.size > 5000) _rlHits.clear();
  return true;
}

function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ?? "unknown").split(",")[0].trim();
}


const STRIPE_API = "https://api.stripe.com/v1";

const ALLOWED_ORIGINS = [
  "https://gatehousehomecleaning.com",
  "https://www.gatehousehomecleaning.com",
  "http://localhost:8080",
];

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

const ActionSchema = z.object({
  action: z.enum(["approve", "dispute", "resolve", "charge", "status", "confirm", "send_report", "decline_date", "set_cleaner", "charge_fee", "delete_card"]),
  booking_id: z.string().min(1).max(100),
  // charge only:
  amount_cents: z.number().int().positive().max(200000).optional(), // sanity cap $2000
  report_version: z.number().int().positive().max(1000).optional(),
  reason: z.string().max(500).optional(),
  // confirm / decline_date:
  confirmed_date: z.string().max(20).optional(),
  confirmed_window: z.string().max(80).optional(),
  alt_dates: z.array(z.string().min(1).max(20)).max(3).optional(),
  // resolve: agreed re-clean date (YYYY-MM-DD)
  reclean_date: z.string().max(20).optional(),
  // set_cleaner: name as the client should see it; photo only with the
  // cleaner's permission — the operator supplies it, we store the URL.
  cleaner_name: z.string().max(80).optional(),
  cleaner_photo: z.string().max(1000).optional(),
  // send_report only: photo URLs, optionally with room + note per photo.
  photos: z.array(z.union([
    z.string().min(1).max(1000),
    z.object({
      url: z.string().min(1).max(1000),
      room: z.string().max(40).optional(),
      note: z.string().max(120).optional(),
    }),
  ])).max(24).optional(),
});

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

// Find the Stripe Customer carrying this booking_id in metadata.
async function findCustomerByBooking(
  secretKey: string,
  bookingId: string,
): Promise<{ id: string; metadata: Record<string, string> } | null> {
  const q = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query: q, limit: "1" })}`);
  if (res.ok) {
    const list = (res.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
    if (list.length > 0) return { id: list[0].id, metadata: list[0].metadata ?? {} };
    return null;
  }
  // Fallback: list recent customers and filter client-side (restricted keys
  // may not allow /customers/search).
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return null;
  const list = (listRes.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
  const found = list.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
  return found ? { id: found.id, metadata: found.metadata ?? {} } : null;
}

export default async function handler(req: Req, res: Res) {
  const origin = req.headers["origin"];
  if (origin && (typeof origin !== "string" || !ALLOWED_ORIGINS.includes(origin))) {
    res.status(403).json({ ok: false, error: "origin_not_allowed" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  const log = (step: string, info?: unknown) =>
    console.log(JSON.stringify({ requestId, step, info }));
  const logErr = (step: string, err: unknown) =>
    console.error(
      JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }),
    );

  try {
    const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
    const ADMIN_TOKEN = process.env["ADMIN_TOKEN"];
    if (!STRIPE_SECRET_KEY) {
      logErr("config", "STRIPE_SECRET_KEY missing");
      return json(500, { ok: false, error: "server_error" });
    }
    if (!ADMIN_TOKEN) {
      logErr("config", "ADMIN_TOKEN missing");
      return json(500, { ok: false, error: "server_error" });
    }
    if (!rateLimit(clientIp(req.headers), 30)) {
      return json(429, { ok: false, error: "too_many_requests" });
    }

    // Admin auth: Bearer token. Never log the token value.
    const authRaw = req.headers["authorization"];
    const auth = Array.isArray(authRaw) ? authRaw[0] : authRaw ?? "";
    if (auth !== `Bearer ${ADMIN_TOKEN}`) {
      logErr("auth", "unauthorized");
      return json(401, { ok: false, error: "unauthorized" });
    }

    const parsed = ActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return json(400, { ok: false, error: "invalid_request" });
    }
    const { action, booking_id: bookingId } = parsed.data;

    const customer = await findCustomerByBooking(STRIPE_SECRET_KEY, bookingId);
    if (!customer) {
      logErr("lookup", "booking not found");
      return json(404, { ok: false, error: "booking_not_found" });
    }
    const meta = customer.metadata;
    const state = meta["gh_state"] ?? "unknown";
    const issueOpen = meta["gh_issue_open"] === "1";

    if (action === "status") {
      return json(200, {
        ok: true,
        booking_id: bookingId,
        state,
        issue_open: issueOpen,
        payment_method: meta["gh_payment_method"] ? "saved" : "none",
        booking_confirmed: meta["gh_booking_confirmed"] === "1",
        confirmed_date: meta["gh_confirmed_date"] ?? "",
        confirmed_window: meta["gh_confirmed_window"] ?? "",
      });
    }

    if (action === "confirm") {
      // Owner confirms the visit date/window with the client. Orthogonal to
      // gh_state: the report-approval/charge machine is untouched. Repeating
      // the same confirmation does not re-email the client; changing the
      // date or window does (it is a change notification).
      const date = (parsed.data.confirmed_date ?? "").trim();
      const win = (parsed.data.confirmed_window ?? "").trim();
      if (!date) {
        return json(400, { ok: false, error: "confirmed_date_required" });
      }
      const already =
        meta["gh_booking_confirmed"] === "1" &&
        meta["gh_confirmed_date"] === date &&
        (meta["gh_confirmed_window"] ?? "") === win;
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_booking_confirmed]": "1",
        "metadata[gh_confirmed_date]": date,
        "metadata[gh_confirmed_window]": win,
      });
      let emailSent = false;
      const RESEND_API_KEY = process.env["RESEND_API_KEY"];
      if (!already && RESEND_API_KEY) {
        const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
        const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
        const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
        if (custEmail) {
          const firstName = custName.trim().split(/\s+/)[0] || "there";
          const cents = parseInt(meta["gh_first_price_cents"] ?? "", 10);
          const priceLine = Number.isFinite(cents) && cents > 0
            ? `\nFirst visit: $${(cents / 100).toFixed(2).replace(/\.00$/, "")}.`
            : "";
          try {
            const resp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
                to: [custEmail],
                reply_to: "hello@gatehousehomecleaning.com",
                subject: `Booking confirmed — ${date}`,
                text:
                  `Hi ${firstName},\n\nYour cleaning is confirmed.\n\nDate: ${date}\nArrival window: ${win || "we'll confirm the window by email the day before"}.${priceLine}\n\n` +
                  "Your card is charged only after the visit — when you approve the photo report, or automatically 24 hours after we send it if you haven't reported an issue.\n\n" +
                  "Need to change or cancel? Email hello@gatehousehomecleaning.com — free up to 48 hours before your visit, $25 after that.\n\nNick\n\nGatehouse Home Cleaning\n",
              }),
              signal: AbortSignal.timeout(15000),
            });
            emailSent = resp.ok;
          } catch {
            emailSent = false;
          }
        }
      }
      log("confirm", { booking: bookingId, emailSent, already });
      return json(200, {
        ok: true,
        booking_confirmed: true,
        confirmed_date: date,
        confirmed_window: win,
        email_sent: emailSent,
        already_confirmed: already,
      });
    }

    if (action === "dispute") {
      // A dispute after a completed charge cannot just block: the money has
      // moved. It needs a refund flow, not a state flip.
      if (state === "paid") {
        logErr("dispute", "blocked: already paid, needs refund flow");
        return json(409, { ok: false, error: "already_paid" });
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "issue_open",
        "metadata[gh_issue_open]": "1",
        "metadata[gh_issue_ever]": "1",
        "metadata[gh_issue_reason]": (parsed.data.reason ?? "").slice(0, 200),
      });
      log("dispute", { booking: bookingId });
      return json(200, { ok: true, state: "issue_open" });
    }

    if (action === "resolve") {
      // resolve only re-opens a disputed booking. It must never move a paid
      // (or payment_pending) booking back to approved — that would re-arm
      // charging for an already-settled visit.
      if (state !== "issue_open") {
        logErr("resolve", `blocked: state=${state}, need issue_open`);
        return json(409, { ok: false, error: "nothing_to_resolve" });
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "approved",
        "metadata[gh_issue_open]": "",
        "metadata[gh_issue_resolved_at]": new Date().toISOString(),
        ...(parsed.data.reclean_date
          ? { "metadata[gh_reclean_date]": parsed.data.reclean_date }
          : {}),
      });
      log("resolve", { booking: bookingId });
      return json(200, { ok: true, state: "approved" });
    }

    if (action === "approve") {
      if (issueOpen) {
        logErr("approve", "blocked: issue open");
        return json(409, { ok: false, error: "issue_open" });
      }
      if (state !== "card_ready" && state !== "report_sent") {
        logErr("approve", `blocked: state=${state}, need card_ready or report_sent`);
        return json(409, { ok: false, error: "card_not_ready" });
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "approved",
      });
      log("approve", { booking: bookingId });
      return json(200, { ok: true, state: "approved" });
    }

    if (action === "charge") {
      const amountCents = parsed.data.amount_cents;
      const reportVersion = parsed.data.report_version ?? 1;
      if (!amountCents) {
        return json(400, { ok: false, error: "amount_required" });
      }
      // Hard safety gates — an open dispute or missing card blocks charging.
      if (issueOpen) {
        logErr("charge", "blocked: issue open");
        return json(409, { ok: false, error: "issue_open" });
      }
      if (state !== "approved") {
        logErr("charge", `blocked: state=${state}, need approved`);
        return json(409, { ok: false, error: "not_approved" });
      }
      const paymentMethod = meta["gh_payment_method"];
      if (!paymentMethod) {
        logErr("charge", "blocked: no saved payment method");
        return json(409, { ok: false, error: "no_payment_method" });
      }
      // Server-side amount check: the charge must equal the amount pinned
      // to THIS visit's report by send_report (gh_report_amount_cents —
      // the first or recurring price of the agreed order, validated there).
      // Bookings without a pinned report amount fall back to the
      // first-visit price stored at card-save time. The request amount is
      // never trusted on its own (fail-closed).
      const rawQuoted = meta["gh_report_amount_cents"] ? meta["gh_report_amount_cents"] : meta["gh_first_price_cents"];
      const quotedCents = parseInt(rawQuoted ?? "", 10);
      if (!Number.isFinite(quotedCents) || quotedCents <= 0) {
        logErr("charge", "blocked: no quoted price on record");
        return json(409, { ok: false, error: "quote_missing" });
      }
      if (amountCents !== quotedCents) {
        logErr("charge", `blocked: amount ${amountCents} != quoted ${quotedCents}`);
        return json(409, { ok: false, error: "amount_mismatch" });
      }
      // Idempotency: one payment per booking+report version, no matter how
      // many times this is called or how often Stripe redelivers webhooks.
      const idemKey = `charge_${bookingId}_v${reportVersion}`;
      // Fresh re-read immediately before creating the PaymentIntent: a
      // dispute (or another charge) landing concurrently must win over this
      // charge. Metadata writes are not transactional, so this narrows —
      // but cannot fully close — the race; the state machine above is the
      // backstop.
      const fresh = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
      const freshMeta = ((fresh.data["metadata"] as Record<string, string> | undefined) ?? {});
      if (freshMeta["gh_issue_open"] === "1") {
        logErr("charge", "blocked on re-read: issue open");
        return json(409, { ok: false, error: "issue_open" });
      }
      if ((freshMeta["gh_state"] ?? "") !== "approved") {
        logErr("charge", `blocked on re-read: state=${freshMeta["gh_state"] ?? "?"}, need approved`);
        return json(409, { ok: false, error: "not_approved" });
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "payment_pending",
        "metadata[gh_report_version]": String(reportVersion),
      });
      const pi = await stripePost(
        STRIPE_SECRET_KEY,
        "/payment_intents",
        {
          amount: String(amountCents),
          currency: "usd",
          customer: customer.id,
          payment_method: paymentMethod,
          off_session: "true",
          confirm: "true",
          description: `Gatehouse cleaning — booking ${bookingId}`,
          "metadata[gh_booking_id]": bookingId,
          "metadata[gh_report_version]": String(reportVersion),
        },
        idemKey,
      );
      if (!pi.ok) {
        const errMsg =
          ((pi.data["error"] as { message?: string } | undefined)?.message ?? "charge failed");
        logErr("charge", `stripe ${pi.status}: ${errMsg}`);
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_state]": "payment_failed",
        });
        // requires_action / declined: the client must complete or update the card.
        return json(402, { ok: false, error: "payment_failed", detail: errMsg });
      }
      const piStatus = pi.data["status"];
      if (piStatus === "succeeded") {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_state]": "paid",
        });
        log("charge", { booking: bookingId, status: "succeeded" });
        return json(200, { ok: true, state: "paid", payment_intent: pi.data["id"] });
      }
      // requires_action etc.: not a success, not a duplicate — client must act.
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "payment_failed",
      });
      log("charge", { booking: bookingId, status: String(piStatus) });
      return json(402, { ok: false, error: "payment_requires_action", status: piStatus });
    }

    if (action === "send_report") {
      // Operator sends the photo report: photo URLs are chunked into
      // customer metadata (Stripe caps a metadata value at 500 chars, so
      // the JSON list is split into 4 × 450-char keys gh_rp_0..3), the 24h
      // Terms clock starts now, and the client is emailed the /report link.
      // Re-sending (e.g. after a re-clean) bumps gh_report_version and
      // clears any open issue — the new report supersedes the old one.
      // The identical photo set re-sent within 10 minutes is a no-op
      // (double-click protection; no duplicate email).
      const rawPhotos = parsed.data.photos ?? [];
      const photos = rawPhotos.map((p) =>
        typeof p === "string" ? { url: p } : p,
      );
      if (photos.some((p) => !p.url.startsWith("https://"))) {
        return json(400, { ok: false, error: "invalid_photo_url" });
      }
      if (state === "paid" || state === "payment_pending") {
        return json(409, { ok: false, error: "already_paid" });
      }
      const photosJson = JSON.stringify(photos);
      if (photosJson.length > 450 * 4) {
        return json(400, { ok: false, error: "photo_payload_too_large" });
      }
      // Pin the agreed amount for THIS visit's report. The operator may
      // pass amount_cents, but it must equal one of the two prices of the
      // agreed order stored at card-save time (first or recurring) —
      // anything else is rejected, never trusted. Default: first-visit
      // price for the first report, recurring price after that.
      const firstCents = parseInt(meta["gh_first_price_cents"] ?? "", 10);
      const recurringCents = parseInt(meta["gh_recurring_price_cents"] ?? "", 10);
      let amountCents = parsed.data.amount_cents;
      if (amountCents !== undefined) {
        if (amountCents !== firstCents && amountCents !== recurringCents) {
          return json(400, { ok: false, error: "amount_not_agreed" });
        }
      } else if ((parseInt(meta["gh_report_version"] ?? "0", 10) || 0) === 0) {
        amountCents = firstCents;
      } else {
        amountCents = Number.isFinite(recurringCents) && recurringCents > 0 ? recurringCents : firstCents;
      }
      if (amountCents === undefined || !Number.isFinite(amountCents) || amountCents <= 0) {
        return json(409, { ok: false, error: "quote_missing" });
      }
      const photoHash = createHash("sha256").update(photosJson).digest("hex").slice(0, 16);
      const prevSentMs = Date.parse(meta["gh_report_sent_at"] ?? "");
      if (
        meta["gh_state"] === "report_sent" &&
        meta["gh_rp_hash"] === photoHash &&
        Number.isFinite(prevSentMs) &&
        Date.now() - prevSentMs < 10 * 60 * 1000
      ) {
        return json(200, { ok: true, state: "report_sent", already_sent: true, email_sent: false });
      }
      const version = (parseInt(meta["gh_report_version"] ?? "0", 10) || 0) + 1;
      const sentAt = new Date().toISOString();
      const params: Record<string, string> = {
        "metadata[gh_state]": "report_sent",
        "metadata[gh_issue_open]": "",
        "metadata[gh_issue_reason]": "",
        "metadata[gh_report_sent_at]": sentAt,
        "metadata[gh_report_version]": String(version),
        "metadata[gh_report_amount_cents]": String(amountCents),
        "metadata[gh_report_bounced]": "",
        "metadata[gh_rp_hash]": photoHash,
      };
      for (let i = 0; i < 4; i++) {
        params[`metadata[gh_rp_${i}]`] = photosJson.slice(i * 450, (i + 1) * 450);
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, params);
      let emailSent = false;
      const RESEND_API_KEY = process.env["RESEND_API_KEY"];
      if (RESEND_API_KEY) {
        const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
        const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
        const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
        if (custEmail) {
          const firstName = custName.trim().split(/\s+/)[0] || "there";
          const token = encryptBookingPayload(bookingLinkSecret(STRIPE_SECRET_KEY), {
            bid: bookingId,
            email: custEmail,
            name: custName,
            ts: Math.floor(Date.now() / 1000),
          });
          const link = `https://www.gatehousehomecleaning.com/report?bt=${token}`;
          const cents = amountCents;
          const priceLine = Number.isFinite(cents) && cents > 0
            ? ` Your card is charged $${(cents / 100).toFixed(2).replace(/\.00$/, "")} once you approve.`
            : "";
          const deadline = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            weekday: "short", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", timeZoneName: "short",
          }).format(new Date(Date.parse(sentAt) + 24 * 3600 * 1000));
          try {
            const resp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
                to: [custEmail],
                reply_to: "hello@gatehousehomecleaning.com",
                subject: "Your cleaning report is ready",
                text:
                  `Hi ${firstName},\n\nYour cleaning is done — your photo report is ready:\n\n${link}\n\n` +
                  `Open it to check every room.${priceLine} If something isn't right, tap "Report an issue" on that page — the charge stays paused while we make it right.\n\n` +
                  `If we don't hear from you by ${deadline}, your card is charged automatically, as agreed in the Terms.\n\nNick\n\nGatehouse Home Cleaning\n`,
              }),
              signal: AbortSignal.timeout(15000),
            });
            emailSent = resp.ok;
            if (resp.ok) {
              // Capture the Resend message id so a later confirmed bounce
              // (api/resend-webhook) can void this report's 24h clock.
              try {
                const j = (await resp.json()) as { id?: string };
                if (typeof j.id === "string" && j.id) {
                  await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
                    "metadata[gh_report_email_id]": j.id,
                  });
                }
              } catch {
                /* best-effort */
              }
            }
          } catch {
            emailSent = false;
          }
        }
      }
      log("send_report", { booking: bookingId, version, photos: photos.length, emailSent });
      return json(200, {
        ok: true,
        state: "report_sent",
        report_version: version,
        report_sent_at: sentAt,
        photos: photos.length,
        email_sent: emailSent,
      });
    }

      if (action === "decline_date") {
      // The requested date does not work: record the decline plus the
      // operator's alternative dates. The client picks one (or proposes
      // their own) from the /visit page — no form to refill, and the
      // saved card stays attached to the same request.
      const alts = (parsed.data.alt_dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "date_declined",
        "metadata[gh_alt_dates]": alts.join(","),
      });
      let emailed = false;
      const RESEND_API_KEY = process.env["RESEND_API_KEY"];
      if (RESEND_API_KEY) {
        const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
        const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
        const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
        if (custEmail) {
          const token = encryptBookingPayload(bookingLinkSecret(STRIPE_SECRET_KEY), {
            bid: bookingId, email: custEmail, name: custName,
            ts: Math.floor(Date.now() / 1000),
          });
          const firstName = custName.trim().split(/\s+/)[0] || "there";
          try {
            const resp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
                to: [custEmail],
                reply_to: "hello@gatehousehomecleaning.com",
                subject: "About your requested date",
                text:
                  `Hi ${firstName},\n\nThanks for your request. The date you picked doesn't work on our side` +
                  (alts.length ? ` — here are the closest dates we can do: ${alts.join(", ")}.` : ".") +
                  `\n\nPick one of these, suggest another date, or cancel the request — all from your visit page (nothing to fill in again):\n\nhttps://www.gatehousehomecleaning.com/visit?bt=${token}\n\n` +
                  `Your card stays saved with this request only, and nothing is charged. If none of the dates work and you cancel, there is no fee for cancelling now.\n\nNick\n\nGatehouse Home Cleaning\n`,
              }),
              signal: AbortSignal.timeout(15000),
            });
            emailed = resp.ok;
          } catch {
            emailed = false;
          }
        }
      }
      log("decline_date", { booking: bookingId, alts: alts.length, emailed });
      return json(200, { ok: true, state: "date_declined", alt_dates: alts, email_sent: emailed });
    }

    if (action === "set_cleaner") {
      // Assign (or replace) the cleaner the client will see. The photo
      // URL is stored only when the operator supplies one — by house
      // rule that means the cleaner agreed to be shown.
      const name = (parsed.data.cleaner_name ?? "").trim();
      if (!name) return json(400, { ok: false, error: "cleaner_name_required" });
      const photo = (parsed.data.cleaner_photo ?? "").trim();
      if (photo && !photo.startsWith("https://")) {
        return json(400, { ok: false, error: "invalid_photo_url" });
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_cleaner_name]": name.slice(0, 80),
        "metadata[gh_cleaner_photo]": photo,
      });
      log("set_cleaner", { booking: bookingId });
      return json(200, { ok: true, cleaner_name: name });
    }

    if (action === "charge_fee") {
      // Collect the late-cancellation fee recorded by the client cancel
      // flow (api/visit). Amount comes ONLY from server metadata — the
      // operator cannot invent a figure here.
      if (state !== "cancelled") {
        return json(409, { ok: false, error: "not_cancelled" });
      }
      const feeCents = parseInt(meta["gh_cancel_fee_cents"] ?? "", 10);
      if (!Number.isFinite(feeCents) || feeCents <= 0) {
        return json(409, { ok: false, error: "no_fee_due" });
      }
      if (meta["gh_fee_charged"] === "1") {
        return json(200, { ok: true, already: true, fee_cents: feeCents });
      }
      const pm = meta["gh_payment_method"] ?? "";
      if (!pm) return json(409, { ok: false, error: "no_payment_method" });
      const pi = await stripePost(
        STRIPE_SECRET_KEY,
        "/payment_intents",
        {
          amount: String(feeCents),
          currency: "usd",
          customer: customer.id,
          payment_method: pm,
          off_session: "true",
          confirm: "true",
          description: `Gatehouse late-cancellation fee — booking ${bookingId}`,
          "metadata[gh_booking_id]": bookingId,
          "metadata[gh_kind]": "cancellation_fee",
        },
        `fee_${bookingId}`,
      );
      if (pi.ok && pi.data["status"] === "succeeded") {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_fee_charged]": "1",
          "metadata[gh_last_payment]": String(pi.data["id"] ?? ""),
        });
        log("charge_fee", { booking: bookingId, feeCents });
        return json(200, { ok: true, fee_cents: feeCents, payment_intent: String(pi.data["id"] ?? "") });
      }
      const errMsg = (pi.data["error"] as { message?: string } | undefined)?.message ?? "fee charge failed";
      logErr("charge_fee", errMsg);
      return json(402, { ok: false, error: "fee_charge_failed", detail: errMsg });
    }

    if (action === "delete_card") {
      // Remove the saved card (e.g. the client cancelled and asked for
      // the card to be deleted). Detach at Stripe and clear our pointer.
      const pm = meta["gh_payment_method"] ?? "";
      if (pm) {
        const det = await stripePost(STRIPE_SECRET_KEY, `/payment_methods/${pm}/detach`, {});
        if (!det.ok) {
          logErr("delete_card", `stripe ${det.status}`);
          return json(502, { ok: false, error: "stripe_error" });
        }
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_payment_method]": "",
      });
      log("delete_card", { booking: bookingId });
      return json(200, { ok: true, card_deleted: true });
    }

    return json(400, { ok: false, error: "invalid_request" });
  } catch (error: unknown) {
    console.error(JSON.stringify({
      requestId, step: "unexpected",
      error: error instanceof Error ? error.message : String(error),
    }));
    return res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
