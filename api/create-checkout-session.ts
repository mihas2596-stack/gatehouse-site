import { z } from "zod";
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

function signBooking(
  secret: string,
  payload: Omit<BookingPayload, "bid" | "ts"> & { bid?: string; ts?: number },
): { token: string; bid: string } {
  const full: BookingPayload = {
    ...payload,
    bid: payload.bid ?? randomUUID(),
    ts: payload.ts ?? Math.floor(Date.now() / 1000),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(full));
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return { token: `${payloadB64}.${sig}`, bid: full.bid };
}

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
    let bookingSummary: Record<string, string> = {};
    let bt: string;

    if (parsed.data.bt) {
      const verified = verifyBooking(STRIPE_SECRET_KEY, parsed.data.bt);
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
      const signed = signBooking(STRIPE_SECRET_KEY, { email, name });
      bt = signed.token;
      bookingId = signed.bid;
      log("booking_token", "issued_standalone");
    }
    log("validate", "ok");

    // Step: reuse an existing customer when the email is already known,
    // so repeat visits don't create duplicates. Uses the list endpoint with
    // an email filter (not /customers/search) so restricted API keys work.
    let customerId: string | null = null;
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

    if (!customerId) {
      try {
        const created = await stripePost(STRIPE_SECRET_KEY, "/customers", {
          email,
          name,
          "metadata[source]": "gatehouse_save_card",
          "metadata[gh_booking_id]": bookingId,
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
      try {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customerId}`, {
          "metadata[gh_booking_id]": bookingId,
          "metadata[gh_state]": "awaiting_card",
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
