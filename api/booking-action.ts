// POST /api/booking-action
//
// Operator actions for a booking: approve | dispute | resolve | charge | status.
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
  action: z.enum(["approve", "dispute", "resolve", "charge", "status"]),
  booking_id: z.string().min(1).max(100),
  // charge only:
  amount_cents: z.number().int().positive().max(200000).optional(), // sanity cap $2000
  report_version: z.number().int().positive().max(1000).optional(),
  reason: z.string().max(500).optional(),
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
      });
      log("resolve", { booking: bookingId });
      return json(200, { ok: true, state: "approved" });
    }

    if (action === "approve") {
      if (issueOpen) {
        logErr("approve", "blocked: issue open");
        return json(409, { ok: false, error: "issue_open" });
      }
      if (state !== "card_ready") {
        logErr("approve", `blocked: state=${state}, need card_ready`);
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
      // Server-side amount check: the charge must equal the server-quoted
      // first-visit price stored on the customer at card-save time. The
      // request amount is never trusted on its own (fail-closed).
      const quotedCents = parseInt(meta["gh_first_price_cents"] ?? "", 10);
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

    return json(400, { ok: false, error: "invalid_request" });
  } catch (error: unknown) {
    console.error(JSON.stringify({
      requestId, step: "unexpected",
      error: error instanceof Error ? error.message : String(error),
    }));
    return res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
