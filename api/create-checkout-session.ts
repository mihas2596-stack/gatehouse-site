import { z } from "zod";
import { createHmac, timingSafeEqual, randomUUID, createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

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

export function signBooking(
  secret: string,
  payload: Omit<BookingPayload, "bid" | "ts"> & { bid?: string; ts?: number },
): { token: string; bid: string } {
  const full: BookingPayload = {
    ...payload,
    bid: payload.bid ?? randomUUID(),
    ts: payload.ts ?? Math.floor(Date.now() / 1000),
  };
  return { token: encryptBookingPayload(secret, full), bid: full.bid };
}

export function verifyBooking(
  secret: string,
  token: string,
): { ok: true; payload: BookingPayload } | { ok: false; reason: string } {
  let payload: BookingPayload | null = null;
  let ttl = TOKEN_TTL_SECONDS;
  if (token.startsWith("v2.")) {
    payload = decryptBookingPayload(secret, token);
    if (!payload) return { ok: false, reason: "bad_token" };
    ttl = TOKEN_TTL_V2_SECONDS;
  } else {
    // Legacy v1: HMAC-signed readable payload.
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, reason: "bad_format" };
    }
    const [payloadB64, sig] = parts;
    let expected: string;
    try {
      expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    } catch {
      return { ok: false, reason: "sign_error" };
    }
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad_signature" };
    }
    try {
      payload = JSON.parse(b64urlDecode(payloadB64)) as BookingPayload;
    } catch {
      return { ok: false, reason: "bad_payload" };
    }
  }
  if (!payload.bid || !payload.email || !payload.ts) {
    return { ok: false, reason: "missing_fields" };
  }
  const age = Math.floor(Date.now() / 1000) - payload.ts;
  if (age < 0 || age > ttl) {
    return { ok: false, reason: "expired" };
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
): { ok: true; payload: BookingPayload } | { ok: false; reason: string } {
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


// Vercel serverless function — creates a Stripe Checkout Session in `setup`
// mode so the client can save a card ($0 today, no charge). The saved card is
// attached to the Stripe Customer and used later for off-session charges
// after the client approves the photo report ("approve, then pay").
//
// Every card save is tied to a server-issued booking_id (HMAC-signed token).
// The Checkout Session carries the booking_id in client_reference_id and
// metadata; success_url includes {CHECKOUT_SESSION_ID} so /save-card can
// verify the session server-side instead of trusting ?saved=1.
//
// Env required: STRIPE_SECRET_KEY (live secret key, set in Vercel dashboard)
// The same key signs booking tokens (inlined below, stateless).

const STRIPE_API = "https://api.stripe.com/v1";

const ALLOWED_ORIGINS = [
  "https://gatehousehomecleaning.com",
  "https://www.gatehousehomecleaning.com",
  "http://localhost:8080",
];

// Minimal structural types so the function compiles without @vercel/node.
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

const SessionRequestSchema = z.object({
  request_id: z.string().uuid().optional(),
  website: z.string().max(300).optional(),
  // Either a signed booking token (preferred — from the booking flow) ...
  bt: z.string().max(2000).optional(),
  // ... or raw name/email (standalone /save-card visit; a booking_id is
  // generated server-side and returned as a token).
  name: z.string().trim().min(1).max(255).optional(),
  email: z.string().trim().min(1).max(255).optional(),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const corsHeaders = (origin: string | string[] | undefined): Record<string, string> => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    headers["Access-Control-Allow-Origin"] = o;
  }
  return headers;
};

const siteBase = (origin: string | string[] | undefined): string => {
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o && ALLOWED_ORIGINS.includes(o)) return o;
  return "https://www.gatehousehomecleaning.com";
};

type StripeError = { error?: { message?: string; type?: string; code?: string } };

async function stripePost(
  secretKey: string,
  path: string,
  params: Record<string, string>,
  idempotencyKey?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const body = new URLSearchParams(params);
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
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

const stripeErrMsg = (data: Record<string, unknown>): string => {
  const err = (data as StripeError).error;
  return err?.message ? `${err.type ?? "api_error"}: ${err.message}` : "unknown stripe error";
};

/** Parse a "$188"-style quoted price into integer cents. Null when unusable. */
const toCents = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
};

export default async function handler(req: Req, res: Res) {
  const origin = req.headers["origin"];
  if (origin && (typeof origin !== "string" || !ALLOWED_ORIGINS.includes(origin))) {
    res.status(403).json({ ok: false, error: "origin_not_allowed" });
    return;
  }
  const headers = corsHeaders(origin);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.status(204).end();
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
    if (!STRIPE_SECRET_KEY) {
      logErr("config", "STRIPE_SECRET_KEY is not configured");
      return json(500, { ok: false, error: "server_error" });
    }

    // Best-effort rate limit: 20 session creations per IP per minute.
    if (!rateLimit(clientIp(req.headers), 20)) {
      logErr("rate_limit", "too many requests");
      return json(429, { ok: false, error: "too_many_requests" });
    }

    const body: unknown = req.body ?? null;
    if (!body || typeof body !== "object") {
      return json(400, { ok: false, errors: { form: "The request could not be read. Please try again." } });
    }
    if ((body as { website?: string }).website) {
      return json(400, { ok: false, error: "invalid_request" });
    }

    const parsed = SessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        errors[k] = (v && v[0]) || "This field is not valid.";
      }
      return json(400, { ok: false, errors });
    }

    // Resolve booking identity. A signed token (from the booking flow) is
    // trusted; raw name/email creates a fresh server-side booking_id.
    // The email used for the Stripe Customer ALWAYS comes from server-verified
    // data — never from an unverified client field alone.
    let bookingId: string;
    let email: string;
    let name: string;
    const bookingSummary: Record<string, string> = {};
    let bt: string;

    if (parsed.data.bt) {
      const verified = verifyBookingLink(STRIPE_SECRET_KEY, parsed.data.bt);
      if (!verified.ok) {
        logErr("booking_token", verified.reason);
        return json(400, { ok: false, error: "invalid_booking" });
      }
      const p = verified.payload;
      bookingId = p.bid;
      email = p.email;
      name = p.name;
      bt = parsed.data.bt;
      if (p.first) bookingSummary.first = p.first;
      if (p.recurring) bookingSummary.recurring = p.recurring;
      if (p.service) bookingSummary.service = p.service;
      if (p.date) bookingSummary.date = p.date;
      log("booking_token", "ok");
    } else {
      const rawEmail = (parsed.data.email ?? "").trim();
      const rawName = (parsed.data.name ?? "").trim();
      if (!EMAIL_RE.test(rawEmail)) {
        return json(400, { ok: false, errors: { email: "Enter a valid email, like name@example.com." } });
      }
      if (rawName.length < 2) {
        return json(400, { ok: false, errors: { name: "Enter your name." } });
      }
      email = rawEmail;
      name = rawName;
      const signed = signBooking(bookingLinkSecret(STRIPE_SECRET_KEY), { email, name });
      bt = signed.token;
      bookingId = signed.bid;
      log("booking_token", "issued_standalone");
    }
    log("validate", "ok");

    // Step: reuse an existing customer when the email is already known,
    // so repeat visits don't create duplicates. Uses the list endpoint with
    // an email filter (not /customers/search) so restricted API keys work.
    //
    // SECURITY: reuse is allowed ONLY when the email came from a verified
    // booking token (bt). In standalone mode (typed email, no token) we MUST
    // NOT look up an existing customer: the typed email is unverified, and
    // reusing would let anyone attach to — and overwrite metadata of —
    // someone else's Stripe Customer. Standalone always creates a fresh
    // customer.
    const hasVerifiedBooking = bt !== "";
    let customerId: string | null = null;
    if (hasVerifiedBooking) {
    try {
      const found = await stripeGet(
        STRIPE_SECRET_KEY,
        `/customers?${new URLSearchParams({ email, limit: "1" }).toString()}`,
      );
      if (!found.ok) {
        logErr("customer_lookup", `stripe ${found.status}: ${stripeErrMsg(found.data)}`);
        return json(500, { ok: false, error: "server_error" });
      }
      const list = (found.data["data"] as Array<{ id?: string }> | undefined) ?? [];
      if (list.length > 0 && typeof list[0]?.id === "string") {
        customerId = list[0].id as string;
        log("customer_lookup", "reused");
      }
    } catch (err) {
      logErr("customer_lookup", err);
      return json(500, { ok: false, error: "server_error" });
    }
    } else {
      log("customer_lookup", "skipped_standalone");
    }

    if (!customerId) {
      try {
        const created = await stripePost(STRIPE_SECRET_KEY, "/customers", {
          email,
          name,
          "metadata[source]": "gatehouse_save_card",
          "metadata[gh_booking_id]": bookingId,
          // Server-quoted prices (cents) from the verified booking token.
          // booking-action/charge will only ever charge gh_first_price_cents.
          ...(toCents(bookingSummary.first) !== null
            ? { "metadata[gh_first_price_cents]": String(toCents(bookingSummary.first)) }
            : {}),
          ...(toCents(bookingSummary.recurring) !== null
            ? { "metadata[gh_recurring_price_cents]": String(toCents(bookingSummary.recurring)) }
            : {}),
        }, `customer_${bookingId}`);
        if (!created.ok || typeof created.data["id"] !== "string") {
          logErr("customer_create", `stripe ${created.status}: ${stripeErrMsg(created.data)}`);
          return json(500, { ok: false, error: "server_error" });
        }
        customerId = created.data["id"] as string;
        log("customer_create", "ok");
      } catch (err) {
        logErr("customer_create", err);
        return json(500, { ok: false, error: "server_error" });
      }
    } else {
      // Link the existing customer to this booking (server-verified email only).
      // The customer is shared by every booking of this email, and its
      // metadata doubles as the lifecycle record — so rebinding MUST clear
      // the previous booking's lifecycle keys. Anything left behind (a
      // confirmed date, a sent report, a cleaner, an amount) would leak
      // into THIS booking's pages and charges. Booking-scoped truth lives
      // in gh_visits/gh_events and is re-hydrated on demand; clearing here
      // loses nothing.
      const clearStale: Record<string, string> = {};
      for (const k of [
        "gh_booking_confirmed", "gh_confirmed_date", "gh_confirmed_window",
        "gh_proposed_date", "gh_alt_dates", "gh_cleaner_name", "gh_cleaner_photo",
        "gh_report_sent_at", "gh_report_version", "gh_report_amount_cents",
        "gh_report_bounced", "gh_report_email_id", "gh_rp_source",
        "gh_rp_0", "gh_rp_1", "gh_rp_2", "gh_rp_3",
        "gh_issue_open", "gh_issue_ever", "gh_issue_reason", "gh_issue_room",
        "gh_issue_resolved_at", "gh_reclean_date",
        "gh_cancel_scope", "gh_cancel_fee_cents", "gh_cancelled_at",
        "gh_receipt_email_id", "gh_charge_id", "gh_last_payment",
        "gh_reminded_at", "gh_card_email_sent",
        "gh_postpay_issue", "gh_postpay_issue_reason", "gh_postpay_issue_room", "gh_postpay_issue_at",
        "gh_report_client_action", "gh_report_responded_at", "gh_access_notes", "gh_no_photo_zones",
      ]) clearStale[`metadata[${k}]`] = "";
      try {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
          ...clearStale,
          "metadata[gh_booking_id]": bookingId,
          "metadata[gh_state]": "awaiting_card",
          ...(toCents(bookingSummary.first) !== null
            ? { "metadata[gh_first_price_cents]": String(toCents(bookingSummary.first)) }
            : { "metadata[gh_first_price_cents]": "" }),
          ...(toCents(bookingSummary.recurring) !== null
            ? { "metadata[gh_recurring_price_cents]": String(toCents(bookingSummary.recurring)) }
            : { "metadata[gh_recurring_price_cents]": "" }),
        }, `customer_meta_${bookingId}`);
      } catch (err) {
        logErr("customer_meta", err);
        // Non-fatal: the session below carries the booking linkage too.
      }
    }

    // Step: Checkout Session in setup mode — $0 today, card saved on the
    // customer for future off-session charges after photo-report approval.
    // The session is bound to the booking via client_reference_id + metadata.
    // success_url carries the Stripe session id so /save-card verifies it
    // server-side (never trusts ?saved=1 alone).
    const base = siteBase(origin);
    try {
      const session = await stripePost(STRIPE_SECRET_KEY, "/checkout/sessions", {
        mode: "setup",
        currency: "usd",
        // Always English: Stripe otherwise follows the visitor's browser
        // locale, which confused owner-testing and would confuse clients
        // whose browsers are set to another language.
        locale: "en",
        // Cards only: Klarna / Cash App / bank debit make no sense for a
        // card-on-file setup and confuse clients on the save-card page.
        "payment_method_types[0]": "card",
        customer: customerId,
        client_reference_id: bookingId,
        success_url: `${base}/save-card?saved=1&session_id={CHECKOUT_SESSION_ID}&bt=${encodeURIComponent(bt)}`,
        cancel_url: `${base}/save-card?canceled=1&bt=${encodeURIComponent(bt)}`,
        "metadata[source]": "gatehouse_save_card",
        "metadata[gh_booking_id]": bookingId,
      }, `setup_${bookingId}`);
      if (!session.ok || typeof session.data["url"] !== "string") {
        logErr("checkout_session", `stripe ${session.status}: ${stripeErrMsg(session.data)}`);
        return json(500, { ok: false, error: "server_error" });
      }
      log("checkout_session", "ok");
      return json(200, { ok: true, url: session.data["url"] as string, bt, booking_id: bookingId });
    } catch (err) {
      logErr("checkout_session", err);
      return json(500, { ok: false, error: "server_error" });
    }
  } catch (error: unknown) {
    console.error(JSON.stringify({ requestId, step: "unexpected", error: error instanceof Error ? error.message : String(error) }));
    return res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
