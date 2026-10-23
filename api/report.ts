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
import { dbConfigured, dbSelect, logEvent, storageSignDownload } from "./_db.js";

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
): Promise<{ id: string; email: string; name: string; metadata: Record<string, string> } | null> {
  const query = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "1" })}`);
  type RawCust = { id: string; email?: string; name?: string; metadata?: Record<string, string> };
  const shape = (c: RawCust) => ({
    id: c.id,
    email: typeof c.email === "string" ? c.email : "",
    name: typeof c.name === "string" ? c.name : "",
    metadata: c.metadata ?? {},
  });
  if (res.ok) {
    const list = (res.data["data"] as RawCust[] | undefined) ?? [];
    if (list.length > 0) return shape(list[0]);
    return null;
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return null;
  const list = (listRes.data["data"] as RawCust[] | undefined) ?? [];
  const found = list.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
  return found ? shape(found) : null;
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

export type PhotoItem = { url: string; room?: string; note?: string };

function readPhotoItems(meta: Record<string, string>): PhotoItem[] {
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
    const out: PhotoItem[] = [];
    for (const it of arr) {
      if (typeof it === "string" && it.startsWith("https://")) {
        out.push({ url: it });
      } else if (it && typeof it === "object") {
        const o = it as Record<string, unknown>;
        if (typeof o["url"] === "string" && (o["url"] as string).startsWith("https://")) {
          out.push({
            url: o["url"] as string,
            ...(typeof o["room"] === "string" ? { room: (o["room"] as string).slice(0, 40) } : {}),
            ...(typeof o["note"] === "string" ? { note: (o["note"] as string).slice(0, 120) } : {}),
          });
        }
      }
    }
    return out;
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
    let room = "";
    let photoB64 = "";
    if (req.method === "GET") {
      bt = q((req.query ?? {})["bt"]);
    } else {
      const body = (req.body ?? {}) as Record<string, unknown>;
      bt = typeof body["bt"] === "string" ? body["bt"] : "";
      action = typeof body["action"] === "string" ? body["action"] : "";
      reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 500) : "";
      room = typeof body["room"] === "string" ? body["room"].slice(0, 60) : "";
      // Optional photo from the client (data URL or raw base64, ~1MB cap).
      // A failed or oversized photo NEVER blocks the issue itself.
      if (typeof body["photo"] === "string" && body["photo"].length <= 1_400_000) {
        photoB64 = body["photo"].replace(/^data:image\/[a-zA-Z]+;base64,/, "");
        if (!/^[A-Za-z0-9+/=\s]+$/.test(photoB64)) photoB64 = "";
      }
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
    // DB-sourced report photos: send_report no longer stores signed URLs
    // in Stripe metadata (they overflow it). Re-read the visit's photos
    // and sign fresh download URLs on every view — a link from an old
    // email keeps working for the whole 90-day retention window.
    let dbPhotoItems: PhotoItem[] | null = null;
    if (meta["gh_rp_source"] === "db" && dbConfigured()) {
      try {
        const vrows = await dbSelect<{ id: string }>(
          "gh_visits",
          `booking_id=eq.${encodeURIComponent(payload.bid)}&order=visit_no.desc&limit=1`,
        );
        const vid = vrows[0]?.id;
        if (vid) {
          const rows = await dbSelect<{ room: string; storage_path: string; note: string | null }>(
            "gh_photos",
            `visit_id=eq.${vid}&order=created_at.asc&limit=60`,
          );
          const items: PhotoItem[] = [];
          for (const r of rows) {
            const url = await storageSignDownload(r.storage_path, 24 * 3600);
            if (url) {
              items.push({
                url,
                room: r.room,
                ...(r.note ? { note: r.note } : {}),
              });
            }
          }
          dbPhotoItems = items;
        }
      } catch {
        dbPhotoItems = null;
      }
    }
    const booking: Record<string, string> = { ...payloadBooking };
    const firstPrice = money(meta["gh_first_price_cents"]);
    if (firstPrice) booking.first = firstPrice;
    if (meta["gh_confirmed_date"]) booking.date = meta["gh_confirmed_date"];

    const view = () => {
      const sentAt = meta["gh_report_sent_at"] ?? null;
      const deadline = sentAt
        ? new Date(Date.parse(sentAt) + 24 * 3600 * 1000).toISOString()
        : null;
      const items = dbPhotoItems ?? readPhotoItems(meta);
      const amountCents = parseInt(
        meta["gh_report_amount_cents"] ? meta["gh_report_amount_cents"] : meta["gh_first_price_cents"] ?? "",
        10,
      );
      return {
        requestId,
        ok: true,
        state: deriveState(meta),
        booking,
        photos: items.map((p) => p.url),
        photo_items: items,
        amount: Number.isFinite(amountCents) && amountCents > 0 ? money(String(amountCents)) : null,
        amount_cents: Number.isFinite(amountCents) && amountCents > 0 ? amountCents : null,
        report_sent_at: sentAt,
        deadline,
        delivery_failed: meta["gh_report_bounced"] === "1",
        receipt_sent: Boolean(meta["gh_receipt_email_id"]),
        postpay_issue: meta["gh_postpay_issue"] === "1",
        issue_reason: meta["gh_issue_open"] === "1" ? meta["gh_issue_reason"] ?? "" : "",
        issue_room: meta["gh_issue_open"] === "1" ? meta["gh_issue_room"] ?? "" : "",
        resolution: meta["gh_issue_resolved_at"]
          ? {
              resolved_at: meta["gh_issue_resolved_at"],
              reclean_date: meta["gh_reclean_date"] ?? "",
            }
          : null,
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
    if (state === "paid" && action === "approve") {
      res.status(409).json({ requestId, ok: false, error: "already_paid" });
      return;
    }
    if (state === "paid" && action === "issue") {
      // Post-payment issue: the visit is already paid, so this does NOT
      // pause or reverse anything automatically. The issue is recorded,
      // the owner is notified, and the owner decides on a re-clean or a
      // refund. The client is told exactly that.
      if (meta["gh_postpay_issue"] === "1") {
        res.status(200).json({ ...view(), already: true });
        return;
      }
      const updPost = await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_postpay_issue]": "1",
        "metadata[gh_postpay_issue_reason]": reason.slice(0, 200),
        "metadata[gh_postpay_issue_room]": room.slice(0, 60),
        "metadata[gh_postpay_issue_at]": new Date().toISOString(),
      });
      if (!updPost.ok) {
        res.status(502).json({ requestId, ok: false, error: "stripe_error" });
        return;
      }
      meta["gh_postpay_issue"] = "1";
      if (dbConfigured()) {
        const vrows = await dbSelect<{ id: string }>(
          "gh_visits",
          `booking_id=eq.${encodeURIComponent(payload.bid)}&order=visit_no.desc&limit=1`,
        );
        if (vrows[0]) {
          await logEvent(vrows[0].id, payload.bid, "client", "postpay_issue", {
            room: room.slice(0, 60), reason: reason.slice(0, 200),
          });
        }
      }
      const RESEND_PP = process.env["RESEND_API_KEY"];
      if (RESEND_PP) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_PP}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
              to: ["nikolajmihasenok@gmail.com"],
              subject: `POST-PAYMENT issue reported — ${customer.name ?? payload.bid}`,
              text:
                `A client reported an issue AFTER the visit was paid.\n\n` +
                `Booking: ${payload.bid}\nRoom: ${room}\nWhat they said: ${reason}\n\n` +
                `The payment is complete — nothing was reversed automatically. ` +
                `Review and decide: offer a re-clean or a refund, and reply to the client.`,
            }),
            signal: AbortSignal.timeout(15000),
          });
        } catch { /* the issue is recorded server-side regardless */ }
      }
      res.status(200).json({ ...view(), postpay: true });
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
      "metadata[gh_issue_room]": room.slice(0, 60),
      "metadata[gh_report_client_action]": "issue",
      "metadata[gh_report_responded_at]": nowIso,
    });
    if (!upd.ok) {
      logErr("issue", `stripe ${upd.status}`);
      res.status(502).json({ requestId, ok: false, error: "stripe_error" });
      return;
    }
    Object.assign(meta, {
      gh_state: "issue_open", gh_issue_open: "1",
      gh_issue_reason: reason.slice(0, 200), gh_issue_room: room.slice(0, 60),
    });

    // Best-effort notifications — the issue is already recorded on the
    // server at this point; an email failure changes nothing for the
    // client (the charge stays paused either way).
    const RESEND_API_KEY = process.env["RESEND_API_KEY"];
    if (RESEND_API_KEY) {
      const firstName = (customer.name || "").trim().split(/\s+/)[0] || "there";
      const sendMail = async (payload: Record<string, unknown>) => {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
          });
        } catch {
          /* best-effort */
        }
      };
      // Owner: full detail + the client's photo when one was attached.
      await sendMail({
        from: "Gatehouse site <info@gatehousehomecleaning.com>",
        to: ["nikolajmihasenok@gmail.com"],
        reply_to: "hello@gatehousehomecleaning.com",
        subject: `Issue reported — booking ${payload.bid}`,
        text:
          `A client reported an issue from the photo report. The charge is PAUSED.\n\n` +
          `Booking: ${payload.bid}\nClient: ${customer.name} <${customer.email}>\n` +
          `Room: ${room || "(not specified)"}\nWhat they said: ${reason || "(no description)"}\n` +
          (photoB64 ? `A photo from the client is attached.\n` : `No photo attached.\n`),
        ...(photoB64
          ? { attachments: [{ filename: "client-issue-photo.jpg", content: photoB64 }] }
          : {}),
      });
      // Client: the confirmation promised on the page.
      if (customer.email) {
        await sendMail({
          from: "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
          to: [customer.email],
          reply_to: "hello@gatehousehomecleaning.com",
          subject: "We received your report — the charge is paused",
          text:
            `Hi ${firstName},\n\nRequest received. The charge is paused — nothing will be charged while we look into it.\n` +
            `We'll reply within one business day.\n\n` +
            (room ? `Room: ${room}\n` : "") +
            (reason ? `What you told us: ${reason}\n\n` : "\n") +
            `You can check the status any time on your report page — the same link as before.\n\nNick\n\nGatehouse Home Cleaning\n`,
        });
      }
    }
    res.status(200).json(view());
  } catch (error: unknown) {
    console.error(JSON.stringify({
      requestId, step: "unexpected",
      error: error instanceof Error ? error.message : String(error),
    }));
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
