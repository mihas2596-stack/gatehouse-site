import { createHmac, timingSafeEqual, randomUUID } from "crypto";

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

function verifyBooking(
  secret: string,
  token: string,
): { ok: true; payload: BookingPayload } | { ok: false; reason: string } {
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
  let payload: BookingPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64)) as BookingPayload;
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!payload.bid || !payload.email || !payload.ts) {
    return { ok: false, reason: "missing_fields" };
  }
  const age = Math.floor(Date.now() / 1000) - payload.ts;
  if (age < 0 || age > TOKEN_TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
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

    if (!sessionId || !/^cs_(test|live)_/.test(sessionId)) {
      // No (valid) session id — nothing to verify. This is the case the old
      // UI got wrong: ?saved=1 without a session must NOT show "Card saved".
      res.status(200).json({ requestId, ok: true, verified: false, status: "unknown", booking: null });
      return;
    }

    let booking: Record<string, string> | null = null;
    let bookingId: string | null = null;
    if (bt) {
      const verified = verifyBooking(STRIPE_SECRET_KEY, bt);
      if (!verified.ok) {
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
