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
import {
  dbConfigured, dbSelect, dbInsert, dbDelete, dbUpdate, dbUpsert, logEvent,
  newCleanerToken, hashToken, tokenHashEquals, storageSignDownload,
  storageSignUpload, storageObjectInfo, storageRemove, ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES,
} from "./_db.js";
import { isOwnerAuth } from "./_owner_auth.js";
import {
  cleanerLinkExpiry, cleanerLinkSecretCandidates, cleanerLinkPrimarySecret,
  cleanerLinkUrl, mintCleanerLinkV2, newIssuanceId,
} from "./_cleaner_link.js";

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
  action: z.enum(["approve", "dispute", "resolve", "charge", "status", "confirm", "resend_confirmation", "send_report", "decline_date", "set_cleaner", "set_access_notes", "charge_fee", "delete_card", "cleaner_link", "get_cleaner_link", "client_link", "return_report", "preview_link", "owner_photo_sign", "owner_photo_register", "owner_photo_delete"]),
  booking_id: z.string().min(1).max(100),
  // charge only:
  amount_cents: z.number().int().positive().max(200000).optional(), // sanity cap $2000
  report_version: z.number().int().positive().max(1000).optional(),
  reason: z.string().max(500).optional(),
  // confirm / decline_date:
  confirmed_date: z.string().max(20).optional(),
  confirmed_window: z.string().max(80).optional(),
  // confirm: explicit repair of a visit whose report was submitted
  // without confirmation (the "Needs review" case).
  repair: z.boolean().optional(),
  alt_dates: z.array(z.string().min(1).max(20)).max(3).optional(),
  // resolve: agreed re-clean date (YYYY-MM-DD)
  reclean_date: z.string().max(20).optional(),
  // return_report: owner's note back to the cleaner.
  note: z.string().max(1000).optional(),
  // set_cleaner: name as the client should see it; photo only with the
  // cleaner's permission — the operator supplies it, we store the URL.
  cleaner_name: z.string().max(80).optional(),
  // set_cleaner: optional per-visit contact for the assigned cleaner.
  // Stored on the visit row only (never mirrored to Stripe metadata).
  cleaner_phone: z.string().max(40).optional(),
  // set_access_notes: owner's correction of the visit's entry instructions.
  access_notes: z.string().max(1000).optional(),
  // send_report: explicit owner decision to resolve an open customer
  // issue together with the re-send (C3 — never silently).
  resolve_issue: z.boolean().optional(),
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

// Receipt email — sent ONCE per paid visit (guarded by gh_receipt_email_id).
// A failed receipt send never touches the payment: it only leaves the
// marker unset, and the auto-charge cron retries the EMAIL later.
function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:#8B5E3C;border-radius:8px;"><a href="${href}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;">${label}</a></td></tr></table>`;
}

const escHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Short event email (§12): one thing happened, one action, one button.
// The HTML body never prints the raw token URL — the button carries it;
// the plain-text body keeps the full URL for text-only clients.
export async function sendShortClientEmail(opts: {
  secretKey: string;
  customer: { email?: string; name?: string };
  bookingId: string;
  subject: string;
  heading: string;
  lines: string[];
  buttonLabel: string;
  buttonAnchor?: string;
}): Promise<boolean> {
  const key = process.env["RESEND_API_KEY"];
  const email = (opts.customer.email ?? "").trim();
  if (!key || !email) return false;
  const firstName = (opts.customer.name ?? "").trim().split(/\s+/)[0] || "there";
  const visitToken = encryptBookingPayload(bookingLinkSecret(opts.secretKey), {
    bid: opts.bookingId,
    email,
    name: opts.customer.name ?? "",
    ts: Math.floor(Date.now() / 1000),
  });
  const link = `https://www.gatehousehomecleaning.com/visit?bt=${visitToken}${opts.buttonAnchor ?? ""}`;
  const bodyText = opts.lines.join("\n\n");
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
        to: [email],
        reply_to: "hello@gatehousehomecleaning.com",
        subject: opts.subject,
        text:
          `Hi ${firstName},\n\n${opts.heading}.\n\n${bodyText}\n\n${opts.buttonLabel}:\n${link}\n\n` +
          `Questions? Email hello@gatehousehomecleaning.com.\n\nNick\nGatehouse Home Cleaning\n`,
        html:
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;line-height:1.6;font-size:16px;">` +
          `<p>Hi ${escHtml(firstName)},</p>` +
          `<p><strong>${escHtml(opts.heading)}.</strong></p>` +
          opts.lines.map((l) => `<p>${escHtml(l)}</p>`).join("") +
          emailButton(link, opts.buttonLabel) +
          `<p>Questions? Email <a href="mailto:hello@gatehousehomecleaning.com">hello@gatehousehomecleaning.com</a>.</p>` +
          `<p>Nick<br>Gatehouse Home Cleaning</p></div>`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// Payment-failed notice (§12/§13): short, with the retry path. Guarded by
// a journal event so a retry storm cannot spam the client.
export async function sendPaymentFailedEmailOnce(
  secretKey: string,
  customerId: string,
  bookingId: string,
  visitId: string | null,
): Promise<boolean> {
  const key = process.env["RESEND_API_KEY"];
  if (!key || !dbConfigured()) return false;
  const prior = await dbSelect<{ id: string }>(
    "gh_events",
    `booking_id=eq.${encodeURIComponent(bookingId)}&event=eq.payment_failed_email&limit=1`,
  );
  if (prior.length > 0) return true;
  const custRes = await stripeGet(secretKey, `/customers/${customerId}`);
  const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
  const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
  if (!custEmail) return false;
  const ok = await sendShortClientEmail({
    secretKey,
    customer: { email: custEmail, name: custName },
    bookingId,
    subject: "Payment didn't go through — Gatehouse Home Cleaning",
    heading: "Payment didn't go through",
    lines: [
      "We couldn't charge your saved card for your cleaning. Nothing was charged.",
      "Open your visit page and try again, or save a different card there.",
    ],
    buttonLabel: "View my visit",
    buttonAnchor: "#report",
  });
  if (ok) await logEvent(visitId, bookingId, "system", "payment_failed_email", {});
  return ok;
}

export async function sendReceiptEmailOnce(
  secretKey: string,
  customerId: string,
  meta: Record<string, string>,
  bookingId: string,
): Promise<boolean> {
  if (meta["gh_receipt_email_id"]) return true;
  const key = process.env["RESEND_API_KEY"];
  const amountCents = parseInt(meta["gh_report_amount_cents"] ?? meta["gh_first_price_cents"] ?? "", 10);
  if (!key || !Number.isFinite(amountCents) || amountCents <= 0) return false;
  const custRes = await stripeGet(secretKey, `/customers/${customerId}`);
  const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
  const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
  if (!custEmail) return false;
  const firstName = custName.trim().split(/\s+/)[0] || "there";
  const dollars = (amountCents / 100).toFixed(2).replace(/\.00$/, "");
  const dateLine = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  }).format(new Date());
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
        to: [custEmail],
        reply_to: "hello@gatehousehomecleaning.com",
        subject: `Your Gatehouse receipt — $${dollars}`,
        text:
          `Hi ${firstName},\n\nThank you — your cleaning is paid.\n\n` +
          `Amount paid: $${dollars}\nDate: ${dateLine} (Atlanta time)\nBooking: ${bookingId.slice(0, 8)}\n\n` +
          `Your card on file was charged after your photo report, as agreed. ` +
          `If anything about the visit isn't right, just reply to this email — we'll review it.\n\n` +
          `Gatehouse Home Cleaning\n`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return false;
    const j = (await resp.json()) as { id?: string };
    if (typeof j.id === "string" && j.id) {
      await stripePost(secretKey, `/customers/${customerId}`, {
        "metadata[gh_receipt_email_id]": j.id,
      });
      if (dbConfigured()) {
        await dbUpdate("gh_visits", `booking_id=eq.${bookingId}`, { receipt_email_id: j.id });
      }
    }
    return true;
  } catch {
    return false;
  }
}

type VisitRowLite = {
  id: string;
  report_status: string;
  checklist: unknown;
  visit_date: string | null;
};

async function latestVisit(bookingId: string): Promise<VisitRowLite | null> {
  if (!dbConfigured()) return null;
  const rows = await dbSelect<VisitRowLite>(
    "gh_visits",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
  );
  return rows[0] ?? null;
}

// ---------- Cleaner access links (v2 reusable + legacy fallback) ----------
// The row type above is deliberately lite; at runtime PostgREST returns
// every column, so v2/profile fields are read through this wider view.
type CleanerRow = VisitRowLite & {
  cleaner_name?: string | null;
  cleaner_token_hash?: string | null;
  cleaner_token_expires?: string | null;
  cleaner_link_version?: string | null;
  cleaner_link_issuance?: string | null;
  cleaner_profile?: unknown;
};

type IssuedLink = { token: string; url: string; expires: string; issuance?: string };

const cleanerSecret = (): string => cleanerLinkPrimarySecret();

/** Mint a fresh v2 link (no DB write). Null when the server secret is missing. */
function mintV2Link(visitId: string, visitDate: string | null): IssuedLink | null {
  const secret = cleanerSecret();
  if (!secret) return null;
  const issuance = newIssuanceId();
  const token = mintCleanerLinkV2(secret, visitId, issuance);
  return { token, url: cleanerLinkUrl(token), expires: cleanerLinkExpiry(visitDate), issuance };
}

/** Mint a legacy random link (no DB write). */
function mintLegacyLink(visitDate: string | null): IssuedLink {
  const token = newCleanerToken();
  return { token, url: cleanerLinkUrl(token), expires: cleanerLinkExpiry(visitDate) };
}

/** Single atomic write of a v2 issuance. False when the v2 columns are
 *  absent (migration not applied yet) or the DB errors — the caller then
 *  falls back to the legacy path instead of failing the action. */
async function writeV2Link(visitId: string, issued: IssuedLink): Promise<boolean> {
  return dbUpdate("gh_visits", `id=eq.${visitId}`, {
    cleaner_token_hash: hashToken(issued.token),
    cleaner_token_expires: issued.expires,
    cleaner_link_version: "v2",
    cleaner_link_issuance: issued.issuance ?? null,
  });
}

/** Best-effort clear of v2 metadata when falling back to a legacy link,
 *  so a stale issuance can never shadow the legacy hash. Failures (e.g.
 *  columns absent) are safe: get_cleaner_link treats a hash mismatch as
 *  "not reusable" and the panel shows the legacy state. */
async function clearV2Fields(visitId: string): Promise<void> {
  await dbUpdate("gh_visits", `id=eq.${visitId}`, {
    cleaner_link_version: null,
    cleaner_link_issuance: null,
  });
}

/**
 * Recompute the current v2 link for a row WITHOUT changing anything:
 * no new issuance, no expiry/hash/opened_at change, no event. Returns
 * null when the row is not a live v2 link (legacy, missing secret,
 * hash mismatch, or expired — the caller maps null to the right error).
 */
function recomputeV2Link(row: CleanerRow): { url: string; expires: string } | null {
  if (row.cleaner_link_version !== "v2") return null;
  if (typeof row.cleaner_link_issuance !== "string" || !row.cleaner_link_issuance) return null;
  if (typeof row.cleaner_token_hash !== "string" || !row.cleaner_token_hash) return null;
  const expires = typeof row.cleaner_token_expires === "string" ? row.cleaner_token_expires : null;
  if (expires && Date.parse(expires) < Date.now()) return null;
  // Try every candidate secret (env first, derived fallback): links minted
  // under the fallback keep working after the env secret is added later.
  for (const secret of cleanerLinkSecretCandidates()) {
    const token = mintCleanerLinkV2(secret, row.id, row.cleaner_link_issuance);
    if (tokenHashEquals(hashToken(token), row.cleaner_token_hash)) {
      return { url: cleanerLinkUrl(token), expires: expires ?? "" };
    }
  }
  return null;
}

export type CleanerProfile = { phone: string | null; photo: string | null };

/** Tolerant parse of the cleaner_profile jsonb column (object, string, or absent). */
function parseCleanerProfile(raw: unknown): CleanerProfile {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") obj = raw as Record<string, unknown>;
  else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  return {
    phone: typeof obj?.["phone"] === "string" ? (obj["phone"] as string) : null,
    photo: typeof obj?.["photo"] === "string" ? (obj["photo"] as string) : null,
  };
}

/** Phone validation: empty = none; otherwise digits with + ( ) - . spaces, max 40. */
function validCleanerPhone(raw: string): boolean {
  const t = raw.trim();
  return t.length === 0 || (t.length <= 40 && /^[+()\-.\s\d]+$/.test(t) && /\d/.test(t));
}

const DEFAULT_CHECKLIST = {
  rooms: [
    { name: "Kitchen", items: [
      { label: "Counters and sink cleaned", done: false },
      { label: "Appliance exteriors wiped", done: false },
      { label: "Floor vacuumed and mopped", done: false },
      { label: "Trash emptied", done: false },
    ] },
    { name: "Bathrooms", items: [
      { label: "Toilet, shower/tub and sink cleaned", done: false },
      { label: "Mirrors polished", done: false },
      { label: "Floor cleaned", done: false },
      { label: "Trash emptied", done: false },
    ] },
    { name: "Bedrooms", items: [
      { label: "Surfaces dusted", done: false },
      { label: "Floor vacuumed / cleaned", done: false },
      { label: "Bed made (if requested)", done: false },
    ] },
    { name: "Living room", items: [
      { label: "Surfaces dusted", done: false },
      { label: "Floor vacuumed / cleaned", done: false },
      { label: "Cushions straightened", done: false },
    ] },
  ],
};

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

// Booking-scoped truth: the Stripe customer is shared by every booking of
// one email, so its metadata may describe a different booking. gh_visits
// (pinned at submission) and gh_events (per-booking journal) win for any
// booking the customer is not currently bound to; before acting on such a
// booking we hydrate the metadata from its own record.
type BookingRow = {
  id: string; booking_id: string; status: string | null;
  amount_cents: number | null; cleaner_name: string | null;
  client_email: string | null; report_sent_at: string | null;
  report_bounced: boolean | null; report_status: string | null;
  visit_date: string | null; window: string | null;
};
type BookingEvent = { event: string; detail: Record<string, unknown> | null; created_at: string };
async function latestBookingRow(bookingId: string): Promise<BookingRow | null> {
  if (!dbConfigured()) return null;
  const rows = await dbSelect<BookingRow>(
    "gh_visits",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
  );
  return rows[0] ?? null;
}
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
  const cardEmailEv = latestEvent(events, "card_saved_email");
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
    gh_issue_reason: issueOpen ? evStr(opened, "reason") : "",
    gh_issue_room: issueOpen ? evStr(opened, "room") : "",
    gh_reminded_at: remindedEv ? remindedEv.created_at : "",
    gh_card_email_sent: cardEmailEv ? "1" : "",
  };
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) params[`metadata[${k}]`] = v;
  await stripePost(secretKey, `/customers/${customer.id}`, params);
  Object.assign(customer.metadata, values);
}


/** A visit counts as confirmed only when the owner confirmed it: the
 * visit_confirmed journal event is the proof. Row status alone cannot
 * prove it — submit overwrites status to report_submitted, so a
 * submitted row may or may not have been confirmed first. */
async function hasVisitConfirmed(visitId: string): Promise<boolean> {
  const rows = await dbSelect<{ id: number }>(
    "gh_events",
    `visit_id=eq.${visitId}&event=eq.visit_confirmed&limit=1`,
  );
  return rows.length > 0;
}

/** The owner confirmation email, shared by confirm and resend. Returns
 * true only when Resend accepted the message — acceptance is not proof
 * of inbox delivery, and callers must never claim otherwise. */
async function sendConfirmationEmail(args: {
  to: string; firstName: string; date: string; win: string;
  service: string; cleaner: string; cents: number | null; visitLink: string;
}): Promise<boolean> {
  const RESEND_API_KEY = process.env["RESEND_API_KEY"];
  if (!RESEND_API_KEY) return false;
  const priceLine = args.cents !== null
    ? `\nAgreed price: $${(args.cents / 100).toFixed(2).replace(/\.00$/, "")} for the first visit.`
    : "";
  const serviceLine = args.service ? `\nService: ${args.service}.` : "";
  const cleanerLine = args.cleaner ? `\nCleaner: ${args.cleaner}.` : "";
  const amountLine = args.cents !== null
    ? ` of $${(args.cents / 100).toFixed(2).replace(/\.00$/, "")}`
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
        to: [args.to],
        reply_to: "hello@gatehousehomecleaning.com",
        subject: `Your cleaning is confirmed — ${args.date}`,
        text:
          `Hi ${args.firstName},\n\nYour cleaning is confirmed.\n\nDate: ${args.date}\nArrival window: ${args.win}.${serviceLine}${cleanerLine}${priceLine}\n\n` +
          `How payment works: $0 charged today. After your cleaning, we'll email you a link to your photo report. You can review the photos and approve payment${amountLine}. If you don't report a problem, your saved card will be charged automatically after the stated 24-hour review period.\n\n` +
          `Your visit page — status, your cleaner, reschedule or cancel:\n${args.visitLink}\n\n` +
          "Need to change or cancel? Email hello@gatehousehomecleaning.com — free up to 48 hours before your visit, $25 after that.\n\nNick\n\nGatehouse Home Cleaning\n",
        html:
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;line-height:1.55;">` +
          `<p>Hi ${escHtml(args.firstName)},</p>` +
          `<p><strong>Your cleaning is confirmed.</strong></p>` +
          `<p>Date: ${escHtml(args.date)}<br>Arrival window: ${escHtml(args.win)}${serviceLine ? `<br>${escHtml(serviceLine.replace(/^\n/, ""))}` : ""}${cleanerLine ? `<br>${escHtml(cleanerLine.replace(/^\n/, ""))}` : ""}${priceLine ? `<br>${escHtml(priceLine.replace(/^\n/, ""))}` : ""}</p>` +
          `<p><strong>How payment works:</strong> $0 charged today. After your cleaning, we'll email you a link to your photo report. You can review the photos and approve payment${amountLine}. If you don't report a problem, your saved card will be charged automatically after the stated 24-hour review period.</p>` +
          emailButton(args.visitLink, "View my visit") +
          `<p style="font-size:13px;color:#555;">If the button doesn&apos;t work, use the link in the plain-text version of this email.</p>` +
          `<p>Need to change or cancel? Email hello@gatehousehomecleaning.com — free up to 48 hours before your visit, $25 after that.</p>` +
          `<p>Nick<br>Gatehouse Home Cleaning</p></div>`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    return resp.ok;
  } catch {
    return false;
  }
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
    if (!isOwnerAuth(auth, ADMIN_TOKEN, Math.floor(Date.now() / 1000))) {
      logErr("auth", "unauthorized");
      return json(401, { ok: false, error: "unauthorized" });
    }

    const parsed = ActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return json(400, { ok: false, error: "invalid_request" });
    }
    const { action, booking_id: bookingId } = parsed.data;

    const boundCustomer = await findCustomerByBooking(STRIPE_SECRET_KEY, bookingId);
    const row = await latestBookingRow(bookingId);
    const events = row ? await bookingEvents(bookingId) : [];
    let customer = boundCustomer;
    if (!customer && row?.client_email) {
      customer = await findCustomerByEmail(STRIPE_SECRET_KEY, row.client_email);
    }
    if (!customer) {
      logErr("lookup", "booking not found");
      return json(404, { ok: false, error: "booking_not_found" });
    }
    const bound = Boolean(boundCustomer);
    if (row && !bound) {
      try {
        await hydrateCustomerMeta(STRIPE_SECRET_KEY, customer, row, events);
      } catch {
        /* actions below re-check state before writing */
      }
    }
    try {
      await reconcileCard(STRIPE_SECRET_KEY, customer);
    } catch {
      /* cached metadata still applies */
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
        // Everything the operator needs to work the booking in one call:
        ops: {
          proposed_date: meta["gh_proposed_date"] ?? "",
          alt_dates: meta["gh_alt_dates"] ?? "",
          cleaner_name: meta["gh_cleaner_name"] ?? "",
          access_notes: meta["gh_access_notes"] ?? "",
          no_photo_zones: meta["gh_no_photo_zones"] ?? "",
          issue_room: meta["gh_issue_room"] ?? "",
          issue_reason: meta["gh_issue_reason"] ?? "",
          issue_resolved_at: meta["gh_issue_resolved_at"] ?? "",
          reclean_date: meta["gh_reclean_date"] ?? "",
          report_version: meta["gh_report_version"] ?? "",
          report_sent_at: meta["gh_report_sent_at"] ?? "",
          report_amount_cents: meta["gh_report_amount_cents"] ?? "",
          report_bounced: meta["gh_report_bounced"] === "1",
          cancel_scope: meta["gh_cancel_scope"] ?? "",
          cancel_fee_cents: meta["gh_cancel_fee_cents"] ?? "",
          fee_charged: meta["gh_fee_charged"] === "1",
          last_payment: meta["gh_last_payment"] ?? "",
          first_price_cents: meta["gh_first_price_cents"] ?? "",
          recurring_price_cents: meta["gh_recurring_price_cents"] ?? "",
        },
      });
    }

    if (action === "confirm") {
      // Owner confirms the visit date/window with the client. Confirmation
      // and email delivery are separate results: the saved record decides
      // success, the email only decides the notification status.
      const date = (parsed.data.confirmed_date ?? "").trim();
      const win = (parsed.data.confirmed_window ?? "").trim();
      const repair = parsed.data.repair === true;
      if (!date) {
        return json(400, { ok: false, error: "confirmed_date_required" });
      }
      if (!win) {
        return json(400, { ok: false, error: "confirmed_window_required" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json(400, { ok: false, error: "invalid_date" });
      }
      const cleanerName = (row?.cleaner_name ?? meta["gh_cleaner_name"] ?? "").trim();
      if (!cleanerName) {
        return json(400, { ok: false, error: "cleaner_required" });
      }
      // Transition guard: confirmation is for requested visits, plus the
      // explicit repair of a visit whose report was submitted without
      // confirmation (the "Needs review" case). Cancelled/paid visits
      // never come back through confirm.
      const rowStatus = row?.status ?? "";
      if (rowStatus === "cancelled" || rowStatus === "paid") {
        return json(409, { ok: false, error: "invalid_transition", status: rowStatus });
      }
      const wasConfirmed = row
        ? await hasVisitConfirmed(row.id)
        : meta["gh_booking_confirmed"] === "1";
      const reportStatus = row?.report_status ?? "";
      const needsRepair = !wasConfirmed && (reportStatus === "submitted" || reportStatus === "sent");
      if (needsRepair && !repair) {
        return json(409, { ok: false, error: "needs_review" });
      }
      // §7/§8: "already" is per-booking, from the visit ROW. The shared
      // Stripe customer metadata follows the LAST booking for the email,
      // so a metadata-only check wrongly suppresses the row update (and
      // the journal event) when a different booking for the same email is
      // confirmed with the same date/window. Row-less legacy bookings
      // keep the metadata check.
      const metaAlready =
        meta["gh_booking_confirmed"] === "1" &&
        meta["gh_confirmed_date"] === date &&
        (meta["gh_confirmed_window"] ?? "") === win;
      const already = row
        ? row.status === "confirmed" && row.visit_date === date && (row.window ?? "") === win
        : metaAlready;
      // Metadata refresh (idempotent): the client page reads confirmation
      // from metadata, and the shared customer record may currently carry
      // another booking's values.
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_booking_confirmed]": "1",
        "metadata[gh_confirmed_date]": date,
        "metadata[gh_confirmed_window]": win,
      });
      if (already) {
        // Repeating the same confirmation sends no second email.
        return json(200, {
          ok: true,
          booking_confirmed: true,
          confirmed_date: date,
          confirmed_window: win,
          email_sent: false,
          already_confirmed: true,
        });
      }
      // Save FIRST: never report success when the record did not persist.
      // Only EXISTING columns: gh_visits has no confirmed_date /
      // confirmed_window columns, and a PATCH naming one fails as a
      // whole. The confirmed date/window become the row's operative
      // visit_date / window; the requested date stays in the journal.
      // Report state is untouched: a repair confirmation keeps a
      // submitted report in review instead of silently dropping it.
      if (row) {
        const rowOk = await dbUpdate("gh_visits", `id=eq.${row.id}`, {
          status: "confirmed",
          visit_date: date,
          window: win,
        });
        if (!rowOk) {
          logErr("confirm", "visit row update failed");
          return json(502, { ok: false, error: "db_error" });
        }
      }
      // Email second: a failed send keeps the confirmation and surfaces
      // as notification status, never as a rolled-back confirmation.
      const RESEND_API_KEY = process.env["RESEND_API_KEY"];
      let emailSent = false;
      if (RESEND_API_KEY) {
        const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
        const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
        const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
        if (custEmail) {
          const firstName = custName.trim().split(/\s+/)[0] || "there";
          const visitToken = encryptBookingPayload(bookingLinkSecret(STRIPE_SECRET_KEY), {
            bid: bookingId,
            email: custEmail,
            name: custName,
            ts: Math.floor(Date.now() / 1000),
          });
          const cents = parseInt(meta["gh_first_price_cents"] ?? "", 10);
          emailSent = await sendConfirmationEmail({
            to: custEmail,
            firstName,
            date,
            win,
            service: row?.service ?? "",
            cleaner: cleanerName,
            cents: Number.isFinite(cents) && cents > 0 ? cents : null,
            visitLink: `https://www.gatehousehomecleaning.com/visit?bt=${visitToken}`,
          });
        }
      }
      if (row) {
        await logEvent(row.id, bookingId, "owner", "visit_confirmed", { date, window: win, ...(repair ? { repair: true } : {}) });
        await logEvent(row.id, bookingId, "system", emailSent ? "confirmation_email_sent" : "confirmation_email_failed", {});
      }
      log("confirm", { booking: bookingId, emailSent, already: false });
      return json(200, {
        ok: true,
        booking_confirmed: true,
        confirmed_date: date,
        confirmed_window: win,
        email_sent: emailSent,
        already_confirmed: false,
      });
    }

    if (action === "resend_confirmation") {
      // Explicit owner retry of the confirmation email. It never changes
      // the booking itself and never re-creates the confirmation: one
      // call sends one email, and only for a visit that was confirmed.
      const wasConfirmed = row
        ? await hasVisitConfirmed(row.id)
        : meta["gh_booking_confirmed"] === "1";
      if (!wasConfirmed) {
        return json(409, { ok: false, error: "not_confirmed" });
      }
      const RESEND_API_KEY = process.env["RESEND_API_KEY"];
      let emailSent = false;
      if (RESEND_API_KEY) {
        const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
        const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
        const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
        if (custEmail) {
          const firstName = custName.trim().split(/\s+/)[0] || "there";
          const visitToken = encryptBookingPayload(bookingLinkSecret(STRIPE_SECRET_KEY), {
            bid: bookingId,
            email: custEmail,
            name: custName,
            ts: Math.floor(Date.now() / 1000),
          });
          const cents = parseInt(meta["gh_first_price_cents"] ?? "", 10);
          emailSent = await sendConfirmationEmail({
            to: custEmail,
            firstName,
            date: row?.visit_date ?? meta["gh_confirmed_date"] ?? "",
            win: row?.window ?? meta["gh_confirmed_window"] ?? "",
            service: row?.service ?? "",
            cleaner: (row?.cleaner_name ?? meta["gh_cleaner_name"] ?? "").trim(),
            cents: Number.isFinite(cents) && cents > 0 ? cents : null,
            visitLink: `https://www.gatehousehomecleaning.com/visit?bt=${visitToken}`,
          });
        }
      }
      if (row) {
        await logEvent(row.id, bookingId, "system", emailSent ? "confirmation_email_sent" : "confirmation_email_failed", {});
      }
      log("resend_confirmation", { booking: bookingId, emailSent });
      return json(200, { ok: true, email_sent: emailSent });
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
      if (row) {
        await logEvent(row.id, bookingId, "owner", "issue_opened", { reason: (parsed.data.reason ?? "").slice(0, 200) });
        await dbUpdate("gh_visits", `id=eq.${row.id}`, { issue_open: true, issue_ever: true });
      }
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
      if (row) {
        await logEvent(row.id, bookingId, "owner", "issue_resolved", { reclean_date: parsed.data.reclean_date ?? "" });
        await dbUpdate("gh_visits", `id=eq.${row.id}`, { issue_open: false });
      }
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
      if (row) await logEvent(row.id, bookingId, "owner", "report_approved", { via: "operator_approve" });
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
      // Agreed-price invariant: the amount must be THIS booking's pinned
      // price (gh_visits.amount_cents, fixed server-side at submission) —
      // or, for a bound booking, its own recurring price. Anything else
      // means the surfaces disagree: flag the booking for a price review
      // and stop the payment instead of picking a number.
      if (row?.amount_cents) {
        const recurringCents = bound ? parseInt(meta["gh_recurring_price_cents"] ?? "", 10) : NaN;
        if (amountCents !== row.amount_cents && amountCents !== recurringCents) {
          await logEvent(row.id, bookingId, "system", "price_review_flagged", {
            amount_cents: amountCents, pinned_cents: row.amount_cents,
          });
          logErr("charge", `blocked: price review — amount ${amountCents} vs pinned ${row.amount_cents}`);
          return json(409, { ok: false, error: "price_review_required", pinned_cents: row.amount_cents });
        }
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
          "metadata[gh_paid_at]": new Date().toISOString(),
          "metadata[gh_last_payment]": String(pi.data["id"] ?? ""),
        });
        const receiptSent = await sendReceiptEmailOnce(
          STRIPE_SECRET_KEY, customer.id,
          { ...meta, gh_report_amount_cents: String(amountCents) },
          bookingId,
        );
        const paidVisit = await latestVisit(bookingId);
        if (paidVisit) {
          await dbUpdate("gh_visits", `id=eq.${paidVisit.id}`, {
            status: "paid",
            paid_at: new Date().toISOString(),
            payment_intent_id: String(pi.data["id"] ?? ""),
          });
          await logEvent(paidVisit.id, bookingId, "system", "payment_succeeded", {
            payment_intent: String(pi.data["id"] ?? ""),
            receipt_sent: receiptSent,
          });
        }
        log("charge", { booking: bookingId, status: "succeeded", receiptSent });
        return json(200, { ok: true, state: "paid", payment_intent: pi.data["id"], receipt_sent: receiptSent });
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
      // Visit-pipeline gate: when the booking has a visit record, the
      // cleaner must have submitted the report and the owner sends THAT
      // report (photos come from private storage as long-lived signed
      // URLs, valid for the 90-day report retention window). A draft or
      // returned report cannot be sent to the client from here.
      let finalPhotos = photos;
      const visitRow = await latestVisit(bookingId);
      if (visitRow) {
        if (visitRow.report_status !== "submitted" && visitRow.report_status !== "sent") {
          return json(409, { ok: false, error: "report_not_ready", report_status: visitRow.report_status });
        }
        // First publish requires a confirmed visit: a report submitted
        // without confirmation is a "Needs review" record, and publishing
        // it would show the client a report for a visit that was never
        // agreed. Re-sends of an already-published report are exempt.
        if (visitRow.report_status === "submitted" && !(await hasVisitConfirmed(visitRow.id))) {
          return json(409, { ok: false, error: "needs_confirmation" });
        }
        if (visitRow.report_status === "submitted" || visitRow.report_status === "sent") {
          // Also for an already-sent report: the photo set must be
          // rebuilt from storage so the double-send guard hashes the
          // same stable paths and can recognize a duplicate publish.
          const dbPhotos = await dbSelect<{ room: string; storage_path: string; note: string | null }>(
            "gh_photos",
            `visit_id=eq.${visitRow.id}&order=created_at.asc&limit=60`,
          );
          if (dbPhotos.length === 0) {
            return json(409, { ok: false, error: "report_has_no_photos" });
          }
          const signed: { url: string; room?: string; note?: string }[] = [];
          for (const dp of dbPhotos) {
            const url = await storageSignDownload(dp.storage_path, 95 * 24 * 3600);
            if (url) signed.push({ url, room: dp.room, ...(dp.note ? { note: dp.note } : {}) });
          }
          if (signed.length === 0) {
            return json(502, { ok: false, error: "photo_signing_failed" });
          }
          finalPhotos = signed;
        }
      }
      const photosJson = JSON.stringify(finalPhotos);
      // DB-sourced photos (the visit pipeline) are NOT stored in Stripe
      // metadata: signed URLs are long, and 4+ photos overflow the
      // 4 x 450-char chunk budget. /api/report re-reads them from the
      // database and signs fresh URLs at view time (gh_rp_source=db).
      // Only the legacy path (operator-passed URLs, no visit record)
      // still chunks URLs into metadata and keeps the size guard.
      const rpSource = visitRow ? "db" : "";
      if (!rpSource && photosJson.length > 450 * 4) {
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
      // For DB photos the signed URLs change on every send, so the
      // double-send guard hashes the stable storage paths instead.
      const hashInput = rpSource
        ? finalPhotos.map((p) => p.url.split("?")[0]).join("|")
        : photosJson;
      const photoHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
      const prevSentMs = Date.parse(meta["gh_report_sent_at"] ?? "");
      if (
        meta["gh_state"] === "report_sent" &&
        meta["gh_rp_hash"] === photoHash &&
        Number.isFinite(prevSentMs) &&
        Date.now() - prevSentMs < 10 * 60 * 1000
      ) {
        return json(200, { ok: true, state: "report_sent", already_sent: true, email_sent: false });
      }
      // C3: an open customer issue freezes the clock. Re-sending must
      // never silently clear it — the owner either resolves the issue
      // first, or explicitly resolves it together with this re-send, so
      // metadata, the gh_visits column and the event journal move as one.
      const issueIsOpen = meta["gh_issue_open"] === "1";
      if (issueIsOpen && parsed.data.resolve_issue !== true) {
        return json(409, {
          ok: false,
          error: "issue_open",
          hint: "Resolve the customer issue first, or re-send with resolve_issue to resolve it together with the new report.",
        });
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
      params["metadata[gh_rp_source]"] = rpSource;
      for (let i = 0; i < 4; i++) {
        params[`metadata[gh_rp_${i}]`] = rpSource ? "" : photosJson.slice(i * 450, (i + 1) * 450);
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, params);
      let emailSent = false;
      let reportEmailId = "";
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
          const link = `https://www.gatehousehomecleaning.com/visit?bt=${token}#report`;
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
                html:
                  `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;line-height:1.55;">` +
                  `<p>Hi ${escHtml(firstName)},</p>` +
                  `<p><strong>Your cleaning is done — your photo report is ready.</strong></p>` +
                  `<p>Open it to check every room.${escHtml(priceLine)} If something isn't right, tap "Report an issue" on that page — the charge stays paused while we make it right.</p>` +
                  `<p>If we don't hear from you by <strong>${escHtml(deadline)}</strong>, your card is charged automatically, as agreed in the Terms.</p>` +
                  emailButton(link, "View report") +
                  `<p style="font-size:13px;color:#555;">If the button doesn&apos;t work, use the link in the plain-text version of this email.</p>` +
                  `<p>Nick<br>Gatehouse Home Cleaning</p></div>`,
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
                  reportEmailId = j.id;
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
      if (!emailSent) {
        // The report email did not go out: the client cannot see the
        // report, so the 24h auto-charge clock must NOT run on it.
        // Reuse the bounce block flag — auto-charge and the reminder
        // pass both skip blocked reports; the operator re-sends.
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_report_bounced]": "1",
        });
        logErr("send_report", "email not sent — auto-charge clock blocked");
      }
      if (visitRow) {
        await dbUpdate("gh_visits", `id=eq.${visitRow.id}`, {
          report_status: "sent",
          report_sent_at: sentAt,
          report_email_id: reportEmailId || null,
          report_bounced: !emailSent,
          status: "report_sent",
          // Publishing a fresh report supersedes any earlier issue
          // (matches the metadata, which send_report clears).
          issue_open: false,
        });
        await logEvent(visitRow.id, bookingId, "owner", "report_sent", {
          version, email_sent: emailSent, photos: finalPhotos.length,
        });
        if (issueIsOpen) {
          await logEvent(visitRow.id, bookingId, "owner", "issue_resolved", {
            via: "report_resend", note: "Resolved by owner decision together with the re-sent report.",
          });
        }
      }
      log("send_report", { booking: bookingId, version, photos: finalPhotos.length, emailSent });
      return json(200, {
        ok: true,
        state: "report_sent",
        report_version: version,
        report_sent_at: sentAt,
        photos: finalPhotos.length,
        email_sent: emailSent,
        ...(emailSent ? {} : { warning: "report_email_not_sent_clock_blocked" }),
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
                  `Your card stays on file, and nothing is charged. If none of the dates work and you cancel, there is no fee for cancelling now.\n\nNick\n\nGatehouse Home Cleaning\n`,
              }),
              signal: AbortSignal.timeout(15000),
            });
            emailed = resp.ok;
          } catch {
            emailed = false;
          }
        }
      }
      if (row) {
        await logEvent(row.id, bookingId, "owner", "date_proposed", { alt_dates: alts.join(",") });
      }
      log("decline_date", { booking: bookingId, alts: alts.length, emailed });
      return json(200, { ok: true, state: "date_declined", alt_dates: alts, email_sent: emailed });
    }

    if (action === "set_cleaner") {
      // Assign (or replace) the cleaner the client will see. The photo
      // URL is stored only when the operator supplies one — by house
      // rule that means the cleaner agreed to be shown. Phone + photo
      // live in cleaner_profile on THIS visit row only: changing the
      // person resets them instead of carrying the previous person's
      // contact over, and editing the same person's details keeps the
      // current link (re-saving a name must not kill a link already
      // handed out — only a real change or an explicit Replace does).
      const name = (parsed.data.cleaner_name ?? "").trim();
      if (!name) return json(400, { ok: false, error: "cleaner_name_required" });
      const photo = (parsed.data.cleaner_photo ?? "").trim();
      if (photo && !photo.startsWith("https://")) {
        return json(400, { ok: false, error: "invalid_photo_url" });
      }
      const phoneRaw = parsed.data.cleaner_phone !== undefined ? parsed.data.cleaner_phone.trim() : null;
      if (phoneRaw !== null && !validCleanerPhone(phoneRaw)) {
        return json(400, { ok: false, error: "invalid_phone" });
      }
      const prevCleaner = row?.cleaner_name ?? "";
      const wasConfirmed = row?.status === "confirmed";
      const changed = Boolean(prevCleaner) && prevCleaner !== name;
      const firstAssignment = !prevCleaner;
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_cleaner_name]": name.slice(0, 80),
        "metadata[gh_cleaner_photo]": photo,
      });
      // Per-visit profile: present key = set (empty = clear); on a
      // same-person edit an absent key leaves the value untouched — but
      // a CHANGE of person always resets the profile, so the new cleaner
      // never silently inherits the previous person's phone or photo.
      let nextProfile: CleanerProfile | null = null;
      let profileSaved = true;
      if (row && (changed || parsed.data.cleaner_phone !== undefined || parsed.data.cleaner_photo !== undefined)) {
        const base = changed ? { phone: null, photo: null } : parseCleanerProfile((row as unknown as CleanerRow).cleaner_profile);
        nextProfile = {
          phone: parsed.data.cleaner_phone !== undefined ? (phoneRaw && phoneRaw.length > 0 ? phoneRaw : null) : base.phone,
          photo: parsed.data.cleaner_photo !== undefined ? (photo ? photo : null) : base.photo,
        };
        // Separate PATCH on purpose: if the profile columns are absent
        // (migration not applied), this fails alone and must not take
        // the name assignment or the link down with it.
        profileSaved = await dbUpdate("gh_visits", `id=eq.${row.id}`, { cleaner_profile: nextProfile });
      }
      let linkOut: { url: string; expires: string; reusable: boolean } | null = null;
      if (row) {
        await dbUpdate("gh_visits", `id=eq.${row.id}`, { cleaner_name: name.slice(0, 80) });
        const visitRow = row as unknown as CleanerRow;
        if (changed || firstAssignment) {
          // A different person (or the first assignment) revokes the
          // previous access: issue a fresh link and return it at once.
          const v2 = mintV2Link(row.id, row.visit_date);
          if (v2 && (await writeV2Link(row.id, v2))) {
            linkOut = { url: v2.url, expires: v2.expires, reusable: true };
          } else {
            const leg = mintLegacyLink(row.visit_date);
            const okLeg = await dbUpdate("gh_visits", `id=eq.${row.id}`, {
              cleaner_token_hash: hashToken(leg.token),
              cleaner_token_expires: leg.expires,
            });
            if (okLeg) {
              await clearV2Fields(row.id);
              linkOut = { url: leg.url, expires: leg.expires, reusable: false };
            }
          }
          if (linkOut) {
            await logEvent(row.id, bookingId, "owner", "cleaner_link_rotated", { reason: "cleaner_changed", expires: linkOut.expires });
          }
        } else {
          // Same person, details edit only: keep the current link. A v2
          // link is recomputed so the panel can show the result at once;
          // a legacy link cannot be re-shown (hash only) — the panel then
          // offers the explicit reusable upgrade instead.
          const recomputed = recomputeV2Link(visitRow);
          if (recomputed) linkOut = { url: recomputed.url, expires: recomputed.expires, reusable: true };
        }
      }
      // §8: the client learns about a cleaner change in advance. A
      // replacement, or a first assignment after confirmation, emails the
      // client (a first assignment before confirmation is covered by the
      // confirmation email itself).
      let cleanerEmailSent = false;
      if (row && ((prevCleaner && prevCleaner !== name) || (!prevCleaner && wasConfirmed))) {
        await logEvent(row.id, bookingId, "owner", "cleaner_changed", { from: prevCleaner || null, to: name });
        cleanerEmailSent = await sendShortClientEmail({
          secretKey: STRIPE_SECRET_KEY,
          customer,
          bookingId,
          subject: "Your cleaner has changed — Gatehouse Home Cleaning",
          heading: "Your cleaner has changed",
          lines: [
            `Your cleaning will now be done by ${name}.`,
            "Nothing else about your visit changes — same date, same price.",
          ],
          buttonLabel: "View my visit",
        });
      }
      log("set_cleaner", { booking: bookingId, cleanerEmailSent });
      return json(200, {
        ok: true,
        cleaner_name: name,
        cleaner_email_sent: cleanerEmailSent,
        cleaner_profile: nextProfile,
        cleaner_profile_saved: profileSaved,
        ...(linkOut ? { url: linkOut.url, expires: linkOut.expires, reusable: linkOut.reusable } : { reusable: false }),
      });
    }

    if (action === "set_access_notes") {
      // Correct the entry instructions the assigned cleaner will see. The
      // Stripe customer metadata mirror is updated too, so a later
      // hydration cannot resurrect stale text from the shared customer.
      if (!row) return json(404, { ok: false, error: "visit_not_found" });
      const value = (parsed.data.access_notes ?? "").trim().slice(0, 1000);
      const okUpd = await dbUpdate("gh_visits", `id=eq.${row.id}`, {
        access_notes: value || null,
      });
      if (!okUpd) return json(500, { ok: false, error: "update_failed" });
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_access_notes]": value,
      }).catch(() => undefined);
      await logEvent(row.id, bookingId, "owner", "access_notes_updated", { length: value.length });
      log("set_access_notes", { booking: bookingId });
      return json(200, { ok: true, access_notes: value });
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

    if (action === "cleaner_link") {
      // Issue (or rotate) the cleaner's token link for this booking's
      // current visit. The owner passes the raw link to the cleaner out
      // of band (e.g. WhatsApp). Prefer a v2 reusable link; when the
      // server secret or the v2 columns are missing, fall back to the
      // legacy random link so the action never breaks pre-migration.
      // This is the ONLY path that replaces a link — reading a visit
      // never rotates anything.
      if (!dbConfigured()) {
        return json(501, { ok: false, error: "db_not_configured" });
      }
      let visit = await latestVisit(bookingId);
      if (!visit) {
        const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
        const created = await dbUpsert<VisitRowLite & { id: string }>(
          "gh_visits",
          {
            booking_id: bookingId,
            visit_no: 1,
            stripe_customer_id: customer.id,
            client_name: typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : null,
            client_email: typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : null,
            service: meta["gh_service"] ?? null,
            amount_cents: parseInt(meta["gh_first_price_cents"] ?? "", 10) || null,
            cleaner_name: meta["gh_cleaner_name"] ?? null,
            checklist: DEFAULT_CHECKLIST,
            status: "scheduled",
          },
          "booking_id,visit_no",
        );
        if (!created) return json(502, { ok: false, error: "db_error" });
        visit = created;
      }
      const v2 = mintV2Link(visit.id, visit.visit_date);
      if (v2 && (await writeV2Link(visit.id, v2))) {
        await logEvent(visit.id, bookingId, "owner", "cleaner_link_issued", { expires: v2.expires, version: "v2" });
        log("cleaner_link", { booking: bookingId, expires: v2.expires, version: "v2" });
        return json(200, { ok: true, url: v2.url, expires: v2.expires, reusable: true });
      }
      const leg = mintLegacyLink(visit.visit_date);
      const okUpd = await dbUpdate("gh_visits", `id=eq.${visit.id}`, {
        cleaner_token_hash: hashToken(leg.token),
        cleaner_token_expires: leg.expires,
      });
      if (!okUpd) return json(502, { ok: false, error: "db_error" });
      await clearV2Fields(visit.id);
      await logEvent(visit.id, bookingId, "owner", "cleaner_link_issued", { expires: leg.expires, version: "legacy" });
      log("cleaner_link", { booking: bookingId, expires: leg.expires, version: "legacy" });
      return json(200, { ok: true, url: leg.url, expires: leg.expires, reusable: false });
    }

    if (action === "get_cleaner_link") {
      // Re-fetch the CURRENT reusable (v2) link for the owner panel.
      // Read-only by construction: no new issuance, no expiry/hash/
      // opened_at change, no event, no-store response. Anything that is
      // not a live v2 link (legacy token, missing secret, hash mismatch,
      // expired) is reported as such — the panel then offers the
      // explicit Replace/Create path instead of silently rotating.
      if (!dbConfigured()) {
        return json(501, { ok: false, error: "db_not_configured" });
      }
      const visit = (await latestVisit(bookingId)) as CleanerRow | null;
      if (!visit) return json(404, { ok: false, error: "visit_not_found" });
      if (
        visit.cleaner_link_version !== "v2" ||
        typeof visit.cleaner_link_issuance !== "string" ||
        !visit.cleaner_link_issuance ||
        typeof visit.cleaner_token_hash !== "string" ||
        !visit.cleaner_token_hash
      ) {
        return json(409, { ok: false, error: "link_not_reusable" });
      }
      if (!cleanerSecret()) {
        return json(503, { ok: false, error: "reusable_unavailable" });
      }
      const recomputed = recomputeV2Link(visit);
      if (!recomputed) {
        // Either the stored hash no longer matches the v2 derivation
        // (e.g. a legacy link overwrote it) or the link expired. An
        // expired link must NOT come back to life on a plain read.
        const expires = typeof visit.cleaner_token_expires === "string" ? visit.cleaner_token_expires : null;
        if (expires && Date.parse(expires) < Date.now()) {
          return json(410, { ok: false, error: "link_expired" });
        }
        return json(409, { ok: false, error: "link_not_reusable" });
      }
      res.setHeader("Cache-Control", "no-store");
      log("get_cleaner_link", { booking: bookingId });
      return json(200, { ok: true, url: recomputed.url, expires: recomputed.expires, reusable: true });
    }

    if (action === "client_link") {
      // Owner copy of the client's cabinet link: mint a fresh bt token for
      // this booking (same v2 construction the quote flow uses) so the
      // owner can send the cabinet link personally instead of relying on
      // the auto-emails. The visit row carries no email (VisitRowLite has
      // no email field), so the address comes from the Stripe customer
      // record, exactly like cleaner_link's create path does.
      const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
      const email = custRes.ok && typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : null;
      const name = custRes.ok && typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : null;
      if (!email) return json(502, { ok: false, error: "no_client_email" });
      const token = encryptBookingPayload(bookingLinkSecret(STRIPE_SECRET_KEY), {
        bid: bookingId,
        email,
        name: name ?? "",
        ts: Math.floor(Date.now() / 1000),
      });
      await logEvent(null, bookingId, "owner", "client_link_issued");
      return json(200, {
        ok: true,
        url: `https://www.gatehousehomecleaning.com/visit?bt=${encodeURIComponent(token)}`,
      });
    }

    if (action === "return_report") {
      // Owner sends the cleaner's report back with a note. The cleaner
      // sees the note when they reopen their link; nothing reaches the
      // client and no clock or charge state changes.
      if (!dbConfigured()) {
        return json(501, { ok: false, error: "db_not_configured" });
      }
      const visit = await latestVisit(bookingId);
      if (!visit) return json(404, { ok: false, error: "visit_not_found" });
      if (visit.report_status !== "submitted") {
        return json(409, { ok: false, error: "report_not_submitted", report_status: visit.report_status });
      }
      const noteText = (parsed.data.note ?? "").trim();
      const okUpd = await dbUpdate("gh_visits", `id=eq.${visit.id}`, { report_status: "returned" });
      if (!okUpd) return json(502, { ok: false, error: "db_error" });
      await logEvent(visit.id, bookingId, "owner", "report_returned", { note: noteText });
      log("return_report", { booking: bookingId });
      return json(200, { ok: true, report_status: "returned" });
    }

    if (action === "preview_link") {
      // Fresh personal links so the owner can preview exactly what the
      // customer sees (report + visit pages) before publishing.
      const email = row?.client_email || (typeof customer.email === "string" ? customer.email : "");
      const name = typeof customer.name === "string" ? customer.name : "";
      if (!email) return json(400, { ok: false, error: "no_client_email" });
      const token = encryptBookingPayload(bookingLinkSecret(STRIPE_SECRET_KEY), {
        bid: bookingId, email, name, ts: Math.floor(Date.now() / 1000),
      });
      return json(200, {
        ok: true,
        report_url: `https://www.gatehousehomecleaning.com/report?bt=${token}`,
        visit_url: `https://www.gatehousehomecleaning.com/visit?bt=${token}`,
      });
    }

    if (action === "owner_photo_sign" || action === "owner_photo_register" || action === "owner_photo_delete") {
      // Owner fallback: photos the cleaner sent another way (text/email)
      // can be uploaded into the same visit by the owner.
      if (!row) return json(404, { ok: false, error: "visit_not_found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (action === "owner_photo_sign") {
        const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
        if (!room) return json(400, { ok: false, error: "invalid_room" });
        const slug = room.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";
        const objectPath = `visits/${row.id}/${slug}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
        const signed = await storageSignUpload(objectPath);
        if (!signed) return json(502, { ok: false, error: "storage_error" });
        return json(200, { ok: true, upload_url: signed.signedUrl, storage_path: objectPath });
      }
      if (action === "owner_photo_register") {
        const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
        const kind = body["kind"] === "before" ? "before" : "after";
        const storagePath = typeof body["storage_path"] === "string" ? (body["storage_path"] as string) : "";
        if (!room || !storagePath.startsWith(`visits/${row.id}/`)) {
          return json(400, { ok: false, error: "invalid_photo" });
        }
        const info = await storageObjectInfo(storagePath);
        if (!info) return json(502, { ok: false, error: "storage_error" });
        if (!ALLOWED_PHOTO_TYPES.includes(info.contentType) || info.size <= 0 || info.size > MAX_PHOTO_BYTES) {
          await storageRemove(storagePath);
          return json(400, { ok: false, error: "invalid_photo_file" });
        }
        const inserted = await dbInsert("gh_photos", {
          visit_id: row.id, room, storage_path: storagePath, kind, note: "Added by the owner",
        });
        if (!inserted) return json(502, { ok: false, error: "db_error" });
        await logEvent(row.id, bookingId, "owner", "owner_photo_added", { room, kind });
        return json(200, { ok: true });
      }
      const photoId = typeof body["photo_id"] === "string" ? (body["photo_id"] as string) : "";
      const photos = await dbSelect<{ id: string; storage_path: string }>(
        "gh_photos", `visit_id=eq.${row.id}&id=eq.${encodeURIComponent(photoId)}&limit=1`,
      );
      const target = photos[0];
      if (!target) return json(404, { ok: false, error: "photo_not_found" });
      await dbDelete("gh_photos", `id=eq.${target.id}&visit_id=eq.${row.id}`);
      await storageRemove(target.storage_path);
      await logEvent(row.id, bookingId, "owner", "owner_photo_deleted", {});
      return json(200, { ok: true });
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
