import { createHmac, timingSafeEqual, randomUUID, createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { dbConfigured, dbSelect, dbSelectStrict, dbInsert, logEvent, logEventStrict } from "./_db.js";
import { emailDate, emailDocument, paymentEmailCopy } from "./_email_copy.js";

// Booking-scoped truth. The Stripe customer is shared by every booking of
// one email, so its metadata can describe a DIFFERENT booking than the one
// being viewed. gh_visits (pinned at submission) and gh_events (the
// per-booking journal) are the source of truth for this booking's own
// price, confirmation and email history.
type BookingRow = {
  id: string; booking_id: string; status: string | null;
  amount_cents: number | null; service: string | null; visit_date: string | null;
  client_name?: string | null; client_email?: string | null; created_at?: string | null; report_sent_at?: string | null;
  issue_open?: boolean | null; issue_ever?: boolean | null;
};
type BookingEvent = { event: string; detail: Record<string, unknown> | null; created_at: string };
async function latestBookingRow(bookingId: string): Promise<BookingRow | null> {
  if (!dbConfigured()) return null;
  const result = await dbSelectStrict<BookingRow>(
    "gh_visits",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
  );
  if (!result.ok) throw new Error("status_unavailable");
  return result.rows[0] ?? null;
}
async function bookingEvents(bookingId: string): Promise<BookingEvent[]> {
  if (!dbConfigured()) return [];
  const result = await dbSelectStrict<BookingEvent>("gh_events", `booking_id=eq.${encodeURIComponent(bookingId)}&order=created_at.desc&limit=60`);
  if (!result.ok) throw new Error("status_unavailable");
  return result.rows;
}
const latestEvent = (events: BookingEvent[], name: string): BookingEvent | null =>
  events.filter((e) => e.event === name).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
async function findCustomerByEmail(
  secretKey: string,
  email: string,
): Promise<{ id: string; metadata: Record<string, string>; email?: string; name?: string } | null> {
  const query = `email:'${email.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "10" })}`);
  if (!res.ok) throw new Error("stripe_unavailable");
  const list = (res.data["data"] as Array<{ id: string; metadata?: Record<string, string>; email?: string; name?: string }> | undefined) ?? [];
  return list.length > 0
    ? { id: list[0].id, metadata: list[0].metadata ?? {}, email: list[0].email, name: list[0].name }
    : null;
}

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

// v2 booking-link tokens: the payload is AES-256-GCM encrypted, so a link
// carries nothing readable (no name, email or prices) into analytics, server
// logs or a forwarded message. v1 tokens were signed-but-readable JSON;
// verifiers still accept them so links already emailed keep working until
// they expire (60 days). New v2 links live 30 days.
const TOKEN_TTL_V2_SECONDS = 30 * 24 * 3600;

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

function decryptBookingPayload(secret: string, token: string): BookingPayload | null {
  try {
    const raw = Buffer.from(token.slice(3), "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const pt = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(pt.toString("utf8")) as BookingPayload;
  } catch {
    return null;
  }
}

function verifyBooking(
  secret: string,
  token: string,
): { ok: boolean; payload: BookingPayload | null; reason?: string } {
  let payload: BookingPayload | null = null;
  let ttl = TOKEN_TTL_SECONDS;
  if (token.startsWith("v2.")) {
    payload = decryptBookingPayload(secret, token);
    if (!payload) return { ok: false, payload: null, reason: "bad_token" };
    ttl = TOKEN_TTL_V2_SECONDS;
  } else {
    // Legacy v1: HMAC-signed readable payload.
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, payload: null, reason: "bad_format" };
    }
    const [payloadB64, sig] = parts;
    let expected: string;
    try {
      expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    } catch {
      return { ok: false, payload: null, reason: "sign_error" };
    }
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, payload: null, reason: "bad_signature" };
    }
    try {
      payload = JSON.parse(b64urlDecode(payloadB64)) as BookingPayload;
    } catch {
      return { ok: false, payload: null, reason: "bad_payload" };
    }
  }
  if (!payload.bid || !payload.email || !payload.ts) {
    return { ok: false, payload: null, reason: "missing_fields" };
  }
  const age = Math.floor(Date.now() / 1000) - payload.ts;
  if (age < 0 || age > ttl) {
    return { ok: false, payload: null, reason: "expired" };
  }
  return { ok: true, payload };
}

// Booking-link signing key, separate from STRIPE_SECRET_KEY so that a Stripe
// key rotation does not invalidate outstanding booking links. Set
// BOOKING_LINK_SECRET in Vercel; until then it falls back to the Stripe key
// and old links keep working.
const bookingLinkSecret = (stripeKey: string): string =>
  process.env["BOOKING_LINK_SECRET"] || stripeKey;

// Verify with the dedicated key first, then the legacy Stripe key, so links
// issued before the dedicated key was set keep working through rotation.
function verifyBookingLink(
  stripeKey: string,
  token: string,
): { ok: boolean; payload: BookingPayload | null; reason?: string } {
  const dedicated = process.env["BOOKING_LINK_SECRET"];
  if (dedicated) {
    const r = verifyBooking(dedicated, token);
    if (r.ok) return r;
  }
  return verifyBooking(stripeKey, token);
}

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

// GET /api/card-status?session_id=cs_...&bt=...
//
// Server-side verification that a card was actually saved via Stripe.
// The frontend must NEVER trust ?saved=1 alone.
//
// Verification steps:
//  1. If a booking token (bt) is given, verify its HMAC signature.
//  2. Retrieve the Checkout Session from Stripe.
//  3. Require: mode == "setup", status == "complete".
//  4. Retrieve the SetupIntent; require status == "succeeded".
//  5. If a booking token was given, require the session's
//     client_reference_id / metadata.gh_booking_id to match the token's
//     booking_id, and the session customer to own that booking.
//
// Returns { ok, verified, status: "saved"|"pending"|"failed"|"unknown",
//           booking: { first, recurring, service, date } | null }


const STRIPE_API = "https://api.stripe.com/v1";

const ALLOWED_ORIGINS = [
  "https://gatehousehomecleaning.com",
  "https://www.gatehousehomecleaning.com",
  "http://localhost:8080",
];

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

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

const q = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? v[0] ?? "" : v ?? "";

async function stripePost(
  secretKey: string,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
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

// Reconcile the saved-card state with Stripe itself. The webhook normally
// maintains gh_payment_method on the customer, but a missing webhook secret
// or a dropped event must not make the whole site believe there is no card:
// Stripe's own payment-method list is the source of truth. When a card is
// found there, the metadata cache is backfilled so every other reader
// (visit page, operator actions, auto-charge) sees the same truth.
type CardDetails = { id: string; brand: string; last4: string };
async function reconcileCard(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string> },
): Promise<CardDetails | null> {
  const existing = customer.metadata["gh_payment_method"] ?? "";
  const res = await stripeGet(
    secretKey,
    `/customers/${encodeURIComponent(customer.id)}/payment_methods?${new URLSearchParams({ type: "card", limit: "1" })}`,
  );
  if (!res.ok) throw new Error("stripe_unavailable");
  const list = (res.data["data"] as Array<{ id: string; card?: { brand?: string; last4?: string } }> | undefined) ?? [];
  const pm = list[0];
  const pmId = pm?.id;
  if (!pmId) return null;
  if (existing !== pmId) {
    const patch: Record<string, string> = { "metadata[gh_payment_method]": pmId };
    const state = customer.metadata["gh_state"] ?? "";
    if (!state || state === "awaiting_card" || state === "card_failed") {
      patch["metadata[gh_state]"] = "card_ready";
    }
    await stripePost(secretKey, `/customers/${customer.id}`, patch);
    customer.metadata["gh_payment_method"] = pmId;
    if (patch["metadata[gh_state]"]) customer.metadata["gh_state"] = "card_ready";
  }
  return { id: pmId, brand: String(pm?.card?.brand ?? ""), last4: String(pm?.card?.last4 ?? "") };
}

async function ownedCard(secretKey: string, customerId: string, paymentMethod: string): Promise<CardDetails | null> {
  const result = await stripeGet(secretKey, `/payment_methods/${encodeURIComponent(paymentMethod)}`);
  if (result.status === 404) return null;
  if (!result.ok) throw new Error("stripe_unavailable");
  const pm = result.data;
  const owner = typeof pm["customer"] === "string" ? pm["customer"] : (pm["customer"] as { id?: string } | null)?.id;
  if (owner !== customerId) return null;
  const card = pm["card"] as { brand?: string; last4?: string } | undefined;
  if (!card) return null;
  return { id: paymentMethod, brand: String(card.brand ?? ""), last4: String(card.last4 ?? "") };
}

const fmtMoney = (dollars: string): string => {
  const n = parseFloat(dollars);
  if (!Number.isFinite(n)) return dollars ? `$${dollars}` : "";
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
};

// Confirmation deadline promised to the customer: 6:00 PM Atlanta time on
// the next business day (Mon-Fri). Mirrors confirmDeadlineLabel in
// send-contact-email.ts so every surface quotes the same moment.
function confirmDeadlineLabel(from = new Date()): string {
  const tz = "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(from);
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  const y = get("year"), m = get("month"), d = get("day");
  for (let i = 1; i <= 7; i++) {
    const probe = new Date(Date.UTC(y, m - 1, d + i, 12));
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(probe);
    if (wd === "Sat" || wd === "Sun") continue;
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long", month: "long", day: "numeric",
    }).format(probe);
    return `${label} at 6:00 PM ET`;
  }
  return "the end of the next business day";
}



// One-time "card saved" email. Guarded by gh_card_email_sent on the Stripe
// customer: a claim is written before sending and cleared on failure, so
// refreshes, repeat status checks and the webhook cannot duplicate it.
async function maybeSendCardSavedEmail(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string>; email?: string; name?: string },
  payload: BookingPayload | null,
  bookingCtx?: { visitId: string | null; amountCents: number | null },
): Promise<void> {
  const RESEND_API_KEY = process.env["RESEND_API_KEY"];
  if (!RESEND_API_KEY) return;
  // Per-booking guard FIRST: the metadata claim lives on the shared
  // customer, so a card email sent for booking A must not suppress the
  // email for booking B of the same client (and vice versa). The journal
  // decides; the metadata claim below only dedupes within one booking
  // when this customer is currently bound to it.
  if (payload?.bid && dbConfigured()) {
    const prior = await dbSelect<{ id: string }>(
      "gh_events",
      `booking_id=eq.${encodeURIComponent(payload.bid)}&event=eq.card_saved_email&limit=1`,
    );
    if (prior.length > 0) return;
    // M4: the journal used to be written only AFTER the send, so two
    // near-simultaneous status checks could both pass the guard and both
    // send. Claim first: insert a claim event, then verify this call owns
    // the earliest live claim before sending. A claim expires after 10
    // minutes, so a crashed sender never blocks the email forever.
    const claims = await dbSelect<{ id: string; created_at: string }>(
      "gh_events",
      `booking_id=eq.${encodeURIComponent(payload.bid)}&event=eq.card_saved_email_claimed&order=created_at.desc&limit=1`,
    );
    const lastClaim = claims[0];
    if (lastClaim && Date.now() - Date.parse(lastClaim.created_at) < 10 * 60 * 1000) return;
    const mine = await dbInsert<{ id: string; created_at: string }>("gh_events", {
      visit_id: bookingCtx?.visitId ?? null,
      booking_id: payload.bid,
      actor: "system",
      event: "card_saved_email_claimed",
      detail: { at: new Date().toISOString() },
    });
    if (mine) {
      const all = await dbSelect<{ id: string; created_at: string }>(
        "gh_events",
        `booking_id=eq.${encodeURIComponent(payload.bid)}&event=eq.card_saved_email_claimed&order=created_at.asc&limit=5`,
      );
      const earliestLive = all.find(
        (c) => Date.now() - Date.parse(c.created_at) < 10 * 60 * 1000,
      );
      if (earliestLive && earliestLive.id !== mine.id) return;
    }
  }
  // When the booking has a DB row, the journal above is the ONLY guard —
  // the metadata claim may have been inherited from another booking of
  // the same client through hydration. The claim below is the legacy
  // path for bookings without a DB record.
  const hasRow = Boolean(bookingCtx && (bookingCtx.visitId || bookingCtx.amountCents != null));
  if (!hasRow && customer.metadata["gh_card_email_sent"]) return;
  const to = (customer.email ?? payload?.email ?? "").trim();
  if (!to) return;
  const claim = String(Date.now());
  await stripePost(secretKey, `/customers/${customer.id}`, {
    "metadata[gh_card_email_sent]": claim,
  });
  customer.metadata["gh_card_email_sent"] = claim;
  const ownRow = payload?.bid ? await latestBookingRow(payload.bid) : null;
  const ownEvents = payload?.bid ? await bookingEvents(payload.bid) : [];
  const firstName = (ownRow?.client_name || payload?.name || customer.name || "").trim().split(/\s+/)[0] || "there";
  const firstCents = bookingCtx?.amountCents ?? parseInt(customer.metadata["gh_first_price_cents"] ?? "", 10);
  const price = Number.isFinite(firstCents) && firstCents > 0
    ? fmtMoney(String(firstCents / 100))
    : fmtMoney(payload?.first ?? "");
  const service = payload?.service || "Standard cleaning";
  const date = payload?.date ?? "";
  let visitUrl = "https://www.gatehousehomecleaning.com/visit";
  if (payload?.bid) {
    const token = encryptBookingPayload(bookingLinkSecret(secretKey), payload);
    visitUrl = `https://www.gatehousehomecleaning.com/visit?bt=${token}`;
  }
  const created = latestEvent(ownEvents, "visit_created")?.created_at || ownRow?.created_at;
  const deadline = confirmDeadlineLabel(created && !Number.isNaN(Date.parse(created)) ? new Date(created) : new Date());
  const explainer = ownRow?.issue_ever || ownRow?.issue_open ? "Automatic payment is blocked for this visit. Updating your card does not restart it. You choose when to approve the report and pay." : paymentEmailCopy(price).replace(/^Due today: \$0\.\n\n/, "");
  const requestSummary = `Service: ${service}${price ? `\nFirst visit: ${price}` : ""}${date ? `\nRequested date: ${emailDate(date)}` : ""}`;
  const confirmed = ownRow?.status !== "cancelled" && ownEvents.some((e) => e.event === "visit_confirmed");
  const nextStep = ownRow?.report_sent_at ? "Your card is saved for this visit. Open your cleaning report to review the work and payment status." : confirmed ? "Your card is saved for your confirmed visit. View your date, arrival window and cleaner below." : `Your date is awaiting confirmation. We'll email your date, cleaner and arrival window by ${deadline}.`;
  const text = `Hi ${firstName},\n\nYour card is saved. $0 was charged today.\n\n${nextStep}\n\n${requestSummary}\n\n${explainer}\n\nView my visit:\n${visitUrl}\n\nQuestions? Reply to this email.\n\nGatehouse Home Cleaning\n`;
  const html = emailDocument({
    firstName, heading: "Card saved — $0 charged today",
    paragraphs: [nextStep, requestSummary, explainer],
    action: { url: visitUrl, label: "View my visit" },
  });
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
        to: [to],
        reply_to: "hello@gatehousehomecleaning.com",
        subject: "Card saved \u2014 your request is received",
        text,
        html,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const data = (await resp.json().catch(() => ({}))) as { id?: string };
      if (payload?.bid) {
        await logEvent(bookingCtx?.visitId ?? null, payload.bid, "system", "card_saved_email", {
          email_id: data.id ?? null,
        });
      }
      await stripePost(secretKey, `/customers/${customer.id}`, {
        "metadata[gh_card_email_sent]": "1",
        ...(data.id ? { "metadata[gh_card_email_id]": data.id } : {}),
      });
      customer.metadata["gh_card_email_sent"] = "1";
    } else {
      await stripePost(secretKey, `/customers/${customer.id}`, { "metadata[gh_card_email_sent]": "" });
      customer.metadata["gh_card_email_sent"] = "";
    }
  } catch {
    await stripePost(secretKey, `/customers/${customer.id}`, { "metadata[gh_card_email_sent]": "" }).catch(() => undefined);
    customer.metadata["gh_card_email_sent"] = "";
  }
}

// Find the Stripe Customer carrying this booking_id in metadata.
async function findCustomerByBooking(
  secretKey: string,
  bookingId: string,
): Promise<{ id: string; metadata: Record<string, string>; email?: string; name?: string } | null> {
  const query = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "1" })}`);
  if (res.ok) {
    const list = (res.data["data"] as Array<{ id: string; metadata?: Record<string, string>; email?: string; name?: string }> | undefined) ?? [];
    if (list.length > 0) return { id: list[0].id, metadata: list[0].metadata ?? {}, email: list[0].email, name: list[0].name };
    return null;
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) throw new Error("stripe_unavailable");
  const list = (listRes.data["data"] as Array<{ id: string; metadata?: Record<string, string>; email?: string; name?: string }> | undefined) ?? [];
  const found = list.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
  return found ? { id: found.id, metadata: found.metadata ?? {}, email: found.email, name: found.name } : null;
}

export default async function handler(req: Req, res: Res) {
  const origin = req.headers["origin"];
  const headers: Record<string, string> = { Vary: "Origin" };
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    headers["Access-Control-Allow-Origin"] = o;
  }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === "POST") {
    // §3: the client explicitly confirms the saved card FOR THIS booking.
    // A matching email/card in Stripe is never enough on its own — this
    // call is the explicit confirmation, and it logs a per-booking event
    // so every surface can prove the choice instead of assuming it.
    try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const btPost = typeof body["bt"] === "string" ? (body["bt"] as string) : "";
    const action = typeof body["action"] === "string" ? (body["action"] as string) : "";
    if (action !== "confirm_card" || !btPost) {
      res.status(400).json({ ok: false, error: "invalid_action" });
      return;
    }
    const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
    if (!STRIPE_SECRET_KEY) {
      res.status(500).json({ ok: false, error: "server_error" });
      return;
    }
    const verified = verifyBookingLink(STRIPE_SECRET_KEY, btPost);
    if (verified.ok === false || !verified.payload) {
      res.status(403).json({ ok: false, error: "invalid_token" });
      return;
    }
    const bid = verified.payload.bid;
    const cust = (await findCustomerByBooking(STRIPE_SECRET_KEY, bid))
      ?? (verified.payload.email ? await findCustomerByEmail(STRIPE_SECRET_KEY, verified.payload.email) : null);
    if (!cust) {
      res.status(409).json({ ok: false, error: "no_card" });
      return;
    }
    if (cust.email && cust.email.toLowerCase() !== verified.payload.email.toLowerCase()) {
      res.status(403).json({ ok: false, error: "identity_mismatch" }); return;
    }
    const card = await reconcileCard(STRIPE_SECRET_KEY, cust);
    if (!card) {
      res.status(409).json({ ok: false, error: "no_card" });
      return;
    }
    const rowResult = dbConfigured() ? await dbSelectStrict<BookingRow>("gh_visits", `booking_id=eq.${encodeURIComponent(bid)}&order=visit_no.desc&limit=1`) : { ok: true, rows: [] };
    if (!rowResult.ok) { res.status(503).json({ ok: false, error: "status_unavailable" }); return; }
    const row = rowResult.rows[0] ?? null;
    if (row?.status === "cancelled") { res.status(409).json({ ok: false, error: "visit_cancelled" }); return; }
    const events = row ? await bookingEvents(bid) : [];
    const already = latestEvent(events, "card_confirmed")?.detail?.["payment_method_id"] === card.id;
    if (!already) {
      const persisted = await logEventStrict(row?.id ?? null, bid, "client", "card_confirmed", {
        payment_method_id: card.id, brand: card.brand, last4: card.last4,
      });
      if (dbConfigured() && !persisted) { res.status(503).json({ ok: false, error: "card_confirmation_failed" }); return; }
      await maybeSendCardSavedEmail(STRIPE_SECRET_KEY, cust, verified.payload, {
        visitId: row?.id ?? null,
        amountCents: row?.amount_cents ?? null,
      });
    }
    res.status(200).json({ ok: true, card_brand: card.brand, card_last4: card.last4 });
    return;
    } catch { res.status(503).json({ ok: false, error: "status_unavailable" }); return; }
  }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const requestId = Math.random().toString(36).slice(2);
  const logErr = (step: string, err: unknown) =>
    console.error(
      JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }),
    );

  try {
    const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
    if (!STRIPE_SECRET_KEY) {
      logErr("config", "STRIPE_SECRET_KEY is not configured");
      res.status(500).json({ requestId, ok: false, error: "server_error" });
      return;
    }
    if (!rateLimit(clientIp(req.headers), 60)) {
      res.status(429).json({ requestId, ok: false, error: "too_many_requests" });
      return;
    }

    const query = req.query ?? {};
    const sessionId = q(query["session_id"]);
    const bt = q(query["bt"]);

    // Verify the booking token FIRST (before the session branch), so that
    // /save-card?bt=<token> without a session_id still gets its booking
    // summary. The token alone never counts as payment verification.
    let booking: Record<string, string> | null = null;
    let bookingId: string | null = null;
    let tokenPayload: BookingPayload | null = null;
    if (bt) {
      const verified = verifyBookingLink(STRIPE_SECRET_KEY, bt);
      if (verified.ok === false) {
        logErr("booking_token", verified.reason);
        res.status(200).json({ requestId, ok: true, verified: false, status: "unknown", booking: null });
        return;
      }
      const p = verified.payload;
      tokenPayload = p;
      bookingId = p.bid;
      booking = {};
      if (p.first) booking.first = p.first;
      if (p.recurring) booking.recurring = p.recurring;
      if (p.service) booking.service = p.service;
      if (p.date) booking.date = p.date;
      // Revisit state: a client reopening their link must see the truth —
      // card already saved, and/or the owner has confirmed the date — not a
      // fresh "save your card" form. Booking-scoped facts come from
      // gh_visits/gh_events; the shared Stripe customer's metadata is only
      // trusted for THIS booking when it is currently bound to it.
      const revisitKey = process.env["STRIPE_SECRET_KEY"];
      if (revisitKey) {
        try {
          const row = await latestBookingRow(bookingId);
          const events = row ? await bookingEvents(bookingId) : [];
          const cancelled = row?.status === "cancelled" || events.some((e) => e.event === "visit_cancelled");
          if (cancelled) booking.visit_state = "cancelled";
          else if (row?.status) booking.visit_state = row.status;
          booking.auto_charge_blocked = row?.issue_ever || row?.issue_open || events.some((e) => e.event === "issue_opened") ? "1" : "";
          const createdAt = latestEvent(events, "visit_created")?.created_at || row?.created_at;
          if (createdAt && !Number.isNaN(Date.parse(createdAt))) booking.confirm_by = confirmDeadlineLabel(new Date(createdAt));
          if (row) {
            if (row.amount_cents != null && row.amount_cents > 0) booking.first = String(row.amount_cents / 100);
            if (row.service) booking.service = row.service;
            if (row.visit_date) booking.date = row.visit_date;
          }
          const confirmEv = latestEvent(events, "visit_confirmed");
          const boundCust = await findCustomerByBooking(revisitKey, bookingId);
          // The saved card belongs to the client (email), not to whichever
          // booking the shared customer is bound to right now.
          const emailCust = !boundCust && p.email ? await findCustomerByEmail(revisitKey, p.email) : null;
          const cust = boundCust ?? emailCust;
          if (cust) {
            if (cust.email && cust.email.toLowerCase() !== p.email.toLowerCase()) throw new Error("identity_mismatch");
            const selectedId = latestEvent(events, "card_confirmed")?.detail?.["payment_method_id"];
            const card = typeof selectedId === "string" && selectedId.startsWith("pm_")
              ? await ownedCard(revisitKey, cust.id, selectedId)
              : await reconcileCard(revisitKey, cust);
            if (card) {
              booking.has_card = "1";
              booking.card_state = "card_ready";
              if (card.brand) booking.card_brand = card.brand;
              if (card.last4) booking.card_last4 = card.last4;
              // §3: a card on file is NOT a confirmation for this booking.
              // Only a card_confirmed event (explicit choice, or a
              // verified Checkout save for this booking) counts.
              if (events.some((e) => e.event === "card_confirmed")) booking.card_confirmed = "1";
            }
          }
          const vcEv = latestEvent(events, "visit_created");
          if (vcEv?.detail && typeof vcEv.detail["first_service"] === "string" && vcEv.detail["first_service"]) {
            booking.first_service = vcEv.detail["first_service"] as string;
          }
          if (confirmEv && !cancelled) {
            booking.booking_confirmed = "1";
            const d = confirmEv.detail ?? {};
            if (typeof d["date"] === "string" && d["date"]) booking.confirmed_date = d["date"];
            if (typeof d["window"] === "string" && d["window"]) booking.confirmed_window = d["window"];
          } else if (!row && !cancelled && boundCust?.metadata["gh_state"] !== "cancelled" && boundCust?.metadata["gh_booking_confirmed"] === "1") {
            booking.booking_confirmed = "1";
            if (boundCust.metadata["gh_confirmed_date"]) booking.confirmed_date = boundCust.metadata["gh_confirmed_date"];
            if (boundCust.metadata["gh_confirmed_window"]) booking.confirmed_window = boundCust.metadata["gh_confirmed_window"];
          }
          if (!booking.has_card && boundCust?.metadata["gh_state"]) {
            booking.card_state = boundCust.metadata["gh_state"];
          }
        } catch { res.status(503).json({ requestId, ok: false, verified: false, status: "unknown", booking: null }); return; }
      }
    }

    if (booking && !booking.booking_confirmed && !booking.confirm_by) {
      // The same deadline label the emails quote (next business day, 6 PM ET).
      booking.confirm_by = confirmDeadlineLabel();
    }

    if (!sessionId || !/^cs_(test|live)_/.test(sessionId)) {
      // No (valid) session id — nothing to verify. This is the case the old
      // UI got wrong: ?saved=1 without a session must NOT show "Card saved".
      // The booking summary (from bt) is returned so /save-card can render it.
      res.status(200).json({ requestId, ok: true, verified: false, status: "unknown", booking });
      return;
    }

    // 1. Retrieve the Checkout Session.
    const sess = await stripeGet(STRIPE_SECRET_KEY, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (!sess.ok) {
      logErr("session_retrieve", `stripe ${sess.status}`);
      res.status(200).json({ requestId, ok: true, verified: false, status: "unknown", booking });
      return;
    }
    const s = sess.data;

    // 2. Booking binding: the session must belong to this booking.
    if (bookingId) {
      const meta = (s["metadata"] as Record<string, string> | undefined) ?? {};
      const ref = s["client_reference_id"];
      if (ref !== bookingId && meta["gh_booking_id"] !== bookingId) {
        logErr("booking_mismatch", "session does not belong to this booking");
        res.status(200).json({ requestId, ok: true, verified: false, status: "unknown", booking });
        return;
      }
    }

    // 3. Session must be a completed setup session.
    if (s["mode"] !== "setup" || s["status"] !== "complete") {
      res.status(200).json({
        requestId, ok: true, verified: false,
        status: s["status"] === "open" ? "pending" : "failed",
        booking,
      });
      return;
    }

    // 4. The SetupIntent must have succeeded (card actually saved).
    const siRaw = s["setup_intent"];
    const siId = typeof siRaw === "string" ? siRaw : (siRaw as { id?: string } | undefined)?.id;
    if (!siId) {
      logErr("setup_intent", "missing");
      res.status(200).json({ requestId, ok: true, verified: false, status: "unknown", booking });
      return;
    }
    const si = await stripeGet(STRIPE_SECRET_KEY, `/setup_intents/${encodeURIComponent(siId)}`);
    if (!si.ok) {
      logErr("setup_intent_retrieve", `stripe ${si.status}`);
      res.status(503).json({ requestId, ok: false, verified: false, status: "unknown", booking });
      return;
    }
    const setupStatus = si.data["status"];
    if (setupStatus !== "succeeded") {
      const failed = setupStatus === "requires_payment_method" || setupStatus === "canceled";
      res.status(200).json({ requestId, ok: true, verified: false, status: failed ? "failed" : "pending", booking });
      return;
    }

    // A successful Stripe setup is not a successful booking choice until
    // its own journal is durable. Use the SetupIntent's exact card, not
    // the shared customer's most recently added card from another visit.
    try {
      const custId = typeof s["customer"] === "string" ? s["customer"] as string : "";
      const pmRaw = si.data["payment_method"];
      const pmId = typeof pmRaw === "string" ? pmRaw : (pmRaw as { id?: string } | null)?.id;
      if (!custId || !pmId) throw new Error("saved_card_unavailable");
      const card = await ownedCard(STRIPE_SECRET_KEY, custId, pmId);
      if (!card) throw new Error("saved_card_unavailable");
      if (bookingId) {
        const row = await latestBookingRow(bookingId);
        if (row?.status === "cancelled") {
          res.status(409).json({ requestId, ok: false, verified: false, status: "failed", error: "visit_cancelled", booking }); return;
        }
        const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${encodeURIComponent(custId)}`);
        if (!custRes.ok) throw new Error("stripe_unavailable");
        const cust = {
          id: custId,
          metadata: (custRes.data["metadata"] as Record<string, string> | undefined) ?? {},
          email: typeof custRes.data["email"] === "string" ? custRes.data["email"] as string : undefined,
          name: typeof custRes.data["name"] === "string" ? custRes.data["name"] as string : undefined,
        };
        const expectedEmail = row?.client_email || tokenPayload?.email;
        if (expectedEmail && cust.email?.toLowerCase() !== expectedEmail.toLowerCase()) throw new Error("identity_mismatch");
        const evs = await bookingEvents(bookingId);
        if (latestEvent(evs, "card_confirmed")?.detail?.["payment_method_id"] !== card.id) {
          const persisted = await logEventStrict(row?.id ?? null, bookingId, "client", "card_confirmed", {
            payment_method_id: card.id, brand: card.brand, last4: card.last4, via: "checkout_session",
          });
          if (dbConfigured() && !persisted) throw new Error("card_confirmation_failed");
        }
        if (booking) {
          booking.has_card = "1";
          booking.card_confirmed = "1";
          booking.card_brand = card.brand;
          booking.card_last4 = card.last4;
        }
        await maybeSendCardSavedEmail(STRIPE_SECRET_KEY, cust, tokenPayload, {
          visitId: row?.id ?? null, amountCents: row?.amount_cents ?? null,
        });
      }
    } catch (error) {
      logErr("card_confirmation", error);
      res.status(503).json({ requestId, ok: false, verified: false, status: "unknown", booking: null }); return;
    }
    // NOTE: card numbers / CVC never leave Stripe; we only see IDs.
    res.status(200).json({
      requestId,
      ok: true,
      verified: true,
      status: "saved",
      booking,
      customer: typeof s["customer"] === "string" ? s["customer"] : undefined,
    });
  } catch (error: unknown) {
    console.error(JSON.stringify({
      requestId, step: "unexpected",
      error: error instanceof Error ? error.message : String(error),
    }));
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
