// /api/report — client-facing photo-report portal endpoint.
//
// The client reaches /report?bt=<booking token> from the "your report is
// ready" email. The token (same v2 AES-256-GCM booking link as /save-card)
// is the only credential: it identifies the booking, nothing more.
//
//   GET  /api/report?bt=...        → report state + photos + deadline
//   POST /api/report {bt, action: "approve"|"issue", reason?}
//
// State lives in Stripe Customer metadata (written by booking-action's
// send_report and by this endpoint):
//   gh_state: ... → report_sent → approved → payment_pending → paid
//             report_sent → issue_open (blocks any charge until resolved)
//   gh_report_sent_at (ISO), gh_report_version, gh_rp_0..3 (photo URL JSON
//   chunks, 450 chars each — Stripe metadata values cap at 500 chars),
//   gh_report_client_action, gh_report_responded_at.
// Safety: approve/issue require a sent report; issue after paid is refused
// (a paid visit needs the refund flow, not a state flip); approve while an
// issue is open is the client withdrawing their own issue — allowed, and it
// re-checks happen server-side at charge time anyway.

import { createHmac, timingSafeEqual, createDecipheriv, createHash } from "crypto";

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
const TOKEN_TTL_V2_SECONDS = 30 * 24 * 3600;

const b64urlDecode = (s: string): string =>
  Buffer.from(s, "base64url").toString("utf8");

function tokenKey(secret: string): Buffer {
  return createHash("sha256").update(`gatehouse-booking-link:${secret}`).digest();
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

async function findCustomerByBooking(
  secretKey: string,
  bookingId: string,
): Promise<{ id: string; metadata: Record<string, string> } | null> {
  const query = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "1" })}`);
  if (res.ok) {
    const list = (res.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
    if (list.length > 0) return { id: list[0].id, metadata: list[0].metadata ?? {} };
    return null;
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return null;
  const list = (listRes.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
  const found = list.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
  return found ? { id: found.id, metadata: found.metadata ?? {} } : null;
}

type ReportState = "not_ready" | "awaiting" | "approved" | "issue_open" | "paid" | "payment_issue";

function deriveState(meta: Record<string, string>): ReportState {
  const state = meta["gh_state"] ?? "";
  if (state === "paid") return "paid";
  if (state === "payment_failed") return "payment_issue";
  if (meta["gh_issue_open"] === "1" || state === "issue_open") return "issue_open";
  if (state === "approved" || state === "payment_pending") {
    return "approved";
  }
  if (meta["gh_report_sent_at"]) return "awaiting";
  return "not_ready";
}

function readPhotos(meta: Record<string, string>): string[] {
  let json = "";
  for (let i = 0; i < 4; i++) {
    const part = meta[`gh_rp_${i}`];
    if (!part) break;
    json += part;
  }
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((u): u is string => typeof u === "string" && u.startsWith("https://"));
  } catch {
    return [];
  }
}

function money(centsRaw: string | undefined): string | null {
  const cents = parseInt(centsRaw ?? "", 10);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

const q = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? v[0] ?? "" : v ?? "";

export default async function handler(req: Req, res: Res) {
  const origin = req.headers["origin"];
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
  }
  if (req.method !== "GET" && req.method !== "POST") {
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

    let bt = "";
    let action = "";
    let reason = "";
    if (req.method === "GET") {
      bt = q((req.query ?? {})["bt"]);
    } else {
      const body = (req.body ?? {}) as Record<string, unknown>;
      bt = typeof body["bt"] === "string" ? body["bt"] : "";
      action = typeof body["action"] === "string" ? body["action"] : "";
      reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 500) : "";
    }
    if (!bt) {
      res.status(200).json({ requestId, ok: false, state: "invalid_link" });
      return;
    }
    const verified = verifyBookingLink(STRIPE_SECRET_KEY, bt);
    if (verified.ok === false) {
      logErr("booking_token", verified.reason);
      res.status(200).json({ requestId, ok: false, state: "invalid_link" });
      return;
    }
    const payload = verified.payload;
    const customer = await findCustomerByBooking(STRIPE_SECRET_KEY, payload.bid);

    const payloadBooking: Record<string, string> = {};
    if (payload.service) payloadBooking.service = payload.service;
    if (payload.date) payloadBooking.date = payload.date;
    if (payload.first) payloadBooking.first = payload.first;

    if (!customer) {
      // No Stripe customer yet (card never saved): a report cannot exist.
      if (req.method === "POST") {
        res.status(404).json({ requestId, ok: false, error: "booking_not_found" });
        return;
      }
      res.status(200).json({
        requestId, ok: true, state: "not_ready" as ReportState,
        booking: payloadBooking, photos: [], report_sent_at: null, deadline: null,
      });
      return;
    }

    const meta = customer.metadata;
    const booking: Record<string, string> = { ...payloadBooking };
    const firstPrice = money(meta["gh_first_price_cents"]);
    if (firstPrice) booking.first = firstPrice;
    if (meta["gh_confirmed_date"]) booking.date = meta["gh_confirmed_date"];

    const view = () => {
      const sentAt = meta["gh_report_sent_at"] ?? null;
      const deadline = sentAt
        ? new Date(Date.parse(sentAt) + 24 * 3600 * 1000).toISOString()
        : null;
      return {
        requestId,
        ok: true,
        state: deriveState(meta),
        booking,
        photos: readPhotos(meta),
        report_sent_at: sentAt,
        deadline,
        delivery_failed: meta["gh_report_bounced"] === "1",
        issue_reason: meta["gh_issue_open"] === "1" ? meta["gh_issue_reason"] ?? "" : "",
      };
    };

    if (req.method === "GET") {
      res.status(200).json(view());
      return;
    }

    // POST actions.
    if (action !== "approve" && action !== "issue") {
      res.status(400).json({ requestId, ok: false, error: "invalid_action" });
      return;
    }
    const state = deriveState(meta);
    if (state === "paid") {
      res.status(409).json({ requestId, ok: false, error: "already_paid" });
      return;
    }
    if (!meta["gh_report_sent_at"]) {
      res.status(409).json({ requestId, ok: false, error: "report_not_sent" });
      return;
    }
    const nowIso = new Date().toISOString();

    if (action === "approve") {
      if (state === "approved") {
        res.status(200).json({ ...view(), already: true });
        return;
      }
      const upd = await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "approved",
        "metadata[gh_issue_open]": "",
        "metadata[gh_issue_reason]": "",
        "metadata[gh_report_client_action]": "approved",
        "metadata[gh_report_responded_at]": nowIso,
      });
      if (!upd.ok) {
        logErr("approve", `stripe ${upd.status}`);
        res.status(502).json({ requestId, ok: false, error: "stripe_error" });
        return;
      }
      Object.assign(meta, {
        gh_state: "approved", gh_issue_open: "", gh_issue_reason: "",
      });
      res.status(200).json(view());
      return;
    }

    // action === "issue"
    if (state === "issue_open") {
      res.status(200).json({ ...view(), already: true });
      return;
    }
    const upd = await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
      "metadata[gh_state]": "issue_open",
      "metadata[gh_issue_open]": "1",
      "metadata[gh_issue_ever]": "1",
      "metadata[gh_issue_reason]": reason.slice(0, 200),
      "metadata[gh_report_client_action]": "issue",
      "metadata[gh_report_responded_at]": nowIso,
    });
    if (!upd.ok) {
      logErr("issue", `stripe ${upd.status}`);
      res.status(502).json({ requestId, ok: false, error: "stripe_error" });
      return;
    }
    Object.assign(meta, {
      gh_state: "issue_open", gh_issue_open: "1", gh_issue_reason: reason.slice(0, 200),
    });
    res.status(200).json(view());
  } catch (error: unknown) {
    console.error(JSON.stringify({
      requestId, step: "unexpected",
      error: error instanceof Error ? error.message : String(error),
    }));
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
