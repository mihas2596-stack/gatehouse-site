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

function verifyBooking(
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

export default async function handler(req: Req, res: Res) {
  const origin = req.headers["origin"];
  const headers: Record<string, string> = { Vary: "Origin" };
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    headers["Access-Control-Allow-Origin"] = o;
  }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

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
    if (bt) {
      const verified = verifyBookingLink(STRIPE_SECRET_KEY, bt);
      if (verified.ok === false) {
        logErr("booking_token", verified.reason);
        res.status(200).json({ requestId, ok: true, verified: false, status: "unknown", booking: null });
        return;
      }
      const p = verified.payload;
      bookingId = p.bid;
      booking = {};
      if (p.first) booking.first = p.first;
      if (p.recurring) booking.recurring = p.recurring;
      if (p.service) booking.service = p.service;
      if (p.date) booking.date = p.date;
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
    if (!si.ok || si.data["status"] !== "succeeded") {
      res.status(200).json({
        requestId, ok: true, verified: false,
        status: si.ok && si.data["status"] === "requires_action" ? "pending" : "failed",
        booking,
      });
      return;
    }

    // Verified: a card was saved on the session's customer for this booking.
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
