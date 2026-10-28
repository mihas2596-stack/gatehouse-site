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
  dbConfigured, dbSelect, dbSelectStrict, dbInsert, dbDelete, dbUpdate, dbUpdateCount, dbUpsert, logEvent, logEventStrict,
  newCleanerToken, hashToken, tokenHashEquals, storageSignDownload,
  storageSignUpload, storageObjectInfo, storageRemove, ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES,
} from "./_db.js";
import { isOwnerAuth } from "./_owner_auth.js";
import { paymentBasis, issueStateFrom, clientApprovedEvent } from "./_payment_basis.js";
import { reconcileIntent, confirmIntent, getIntent, searchIntents, verifyIntentForObligation } from "./_payment_intent.js";
import { chargeVisit } from "./_payment_obligation.js";
import { deleteAccess, revokeAccessForCleanerChange, saveAccessNote } from "./_visit_access.js";
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
  action: z.enum(["approve", "dispute", "resolve", "charge", "status", "confirm", "assign_confirm", "approve_request", "resend_confirmation", "send_report", "decline_date", "set_cleaner", "set_access_notes", "charge_fee", "delete_card", "cleaner_link", "get_cleaner_link", "client_link", "return_report", "preview_link", "owner_photo_sign", "owner_photo_register", "owner_photo_delete", "roster_add", "roster_update", "roster_import"]),
  // Roster actions carry no booking; the handler enforces booking_id
  // for every other action after the roster branch.
  booking_id: z.string().min(1).max(100).optional(),
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
  // assign_confirm / set_cleaner / roster_update: stable roster ID.
  cleaner_id: z.string().max(50).optional(),
  // roster_update: active flag; roster_import: pasted CSV text.
  active: z.boolean().optional(),
  csv: z.string().max(20000).optional(),
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
): Promise<{ id: string; metadata: Record<string, string>; email?: string; name?: string } | null> {
  const q = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query: q, limit: "1" })}`);
  if (res.ok) {
    const list = (res.data["data"] as Array<{ id: string; metadata?: Record<string, string>; email?: string; name?: string }> | undefined) ?? [];
    if (list.length > 0) return { id: list[0].id, metadata: list[0].metadata ?? {}, email: list[0].email, name: list[0].name };
    return null;
  }
  // Fallback: list recent customers and filter client-side (restricted keys
  // may not allow /customers/search).
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return null;
  const list = (listRes.data["data"] as Array<{ id: string; metadata?: Record<string, string>; email?: string; name?: string }> | undefined) ?? [];
  const found = list.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
  return found ? { id: found.id, metadata: found.metadata ?? {}, email: found.email, name: found.name } : null;
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
  // P10: the sent flag is per-booking, never shared customer metadata —
  // another booking's receipt id must not suppress this booking's
  // receipt. The row carries receipt_email_id (written below on send).
  //
  // RA18: the old check-then-send raced — two concurrent calls both
  // saw an empty marker and both emailed. The row is now claimed
  // BEFORE sending, with a leased placeholder:
  //   * claim: receipt_email_id null -> "claim:<ms>" (atomic CAS on
  //     the row id; only the winner sends);
  //   * a loser whose re-read shows a real id returns true (sent);
  //   * a loser seeing a FRESH placeholder returns false (the winner
  //     is in flight; a later call sees the real id and returns true);
  //   * a STALE placeholder (>5 min, longer than any Resend call plus
  //     a serverless timeout) means the winner died mid-send: the
  //     lease is stolen and the send retried — with the SAME Resend
  //     idempotency key, so a retry after an ambiguous Resend outcome
  //     returns the original message instead of a second receipt.
  //   * a DB error anywhere in the claim fails closed (no send).
  // Legacy bookings with no row, and the no-DB path, keep the old
  // meta check-then-send: there is nothing atomic to claim on.
  const CLAIM_TTL_MS = 5 * 60 * 1000;
  const claimValue = () => `claim:${Date.now()}`;
  const isClaim = (v: string | null | undefined) => typeof v === "string" && v.startsWith("claim:");
  const claimAgeMs = (v: string) => Date.now() - (parseInt(v.slice("claim:".length), 10) || 0);
  if (dbConfigured()) {
    // N13: an unreadable DB must fail closed (no send), never degrade
    // to a claim-less send — dbSelect hides errors as "no rows", so
    // the strict variant is the only one that can tell the two apart.
    const strict = await dbSelectStrict<{ id: string; receipt_email_id?: string | null }>(
      "gh_visits",
      `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
    );
    if (!strict.ok) return false;
    const row = strict.rows[0];
    if (row) {
      const current = row.receipt_email_id ?? null;
      if (current && !isClaim(current)) return true;
      let won = false;
      if (current === null) {
        const claimed = await dbUpdateCount(
          "gh_visits",
          `id=eq.${row.id}&receipt_email_id=is.null`,
          { receipt_email_id: claimValue() },
        );
        if (claimed === 1) won = true;
        else if (claimed < 0) return false;
      }
      if (!won) {
        // Re-read: the winner may have finished, or hold a lease.
        const fresh = await dbSelect<{ id: string; receipt_email_id?: string | null }>(
          "gh_visits",
          `id=eq.${row.id}`,
        );
        const now = fresh[0]?.receipt_email_id ?? null;
        if (now && !isClaim(now)) return true;
        if (now && isClaim(now) && claimAgeMs(now) > CLAIM_TTL_MS) {
          const stolen = await dbUpdateCount(
            "gh_visits",
            `id=eq.${row.id}&receipt_email_id=eq.${encodeURIComponent(now)}`,
            { receipt_email_id: claimValue() },
          );
          if (stolen === 1) won = true;
          else if (stolen < 0) return false;
        } else if (now === "") {
          // Defensive: no code writes "", but an empty marker is not
          // a sent receipt — claim it rather than blocking forever.
          const claimedEmpty = await dbUpdateCount(
            "gh_visits",
            `id=eq.${row.id}&receipt_email_id=eq.`,
            { receipt_email_id: claimValue() },
          );
          if (claimedEmpty === 1) won = true;
          else if (claimedEmpty < 0) return false;
        }
      }
      if (!won) return false;
      // Winner continues below; the row id is remembered for the
      // final write so the placeholder is replaced precisely.
      return await sendReceiptAfterClaim(secretKey, customerId, meta, bookingId, row.id);
    }
  } else if (meta["gh_receipt_email_id"]) {
    return true;
  }
  return await sendReceiptAfterClaim(secretKey, customerId, meta, bookingId, null);
}

async function sendReceiptAfterClaim(
  secretKey: string,
  customerId: string,
  meta: Record<string, string>,
  bookingId: string,
  rowId: string | null,
): Promise<boolean> {
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
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Stable per booking: a retry after an ambiguous outcome
        // (request sent, response lost) replays the original message
        // instead of emailing a second receipt.
        "Idempotency-Key": `gh-receipt-${bookingId}`,
      },
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
        // Replace the placeholder with the real id. Retried a few
        // times: if this write never lands, the lease ages out and a
        // later call re-sends — with the same idempotency key, so
        // Resend still delivers only one receipt.
        for (let attempt = 0; attempt < 3; attempt++) {
          const ok = rowId
            ? await dbUpdate("gh_visits", `id=eq.${rowId}`, { receipt_email_id: j.id })
            : await dbUpdate("gh_visits", `booking_id=eq.${bookingId}`, { receipt_email_id: j.id });
          if (ok) break;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

// RA10: receipt for a late-cancellation FEE — a separate obligation
// from the cleaning. The amount is the fee intent's own amount, the
// wording names the fee, and dedupe is per booking + intent (journal
// event), never the cleaning receipt marker. The shared-meta marker
// is only the legacy fallback when no DB is configured.
export async function sendFeeReceiptEmailOnce(
  secretKey: string,
  customerId: string,
  bookingId: string,
  piId: string,
  amountCents: number,
): Promise<boolean> {
  if (!Number.isFinite(amountCents) || amountCents <= 0 || !piId) return false;
  const key = process.env["RESEND_API_KEY"];
  if (!key) return false;
  const custRes = await stripeGet(secretKey, `/customers/${customerId}`);
  const custEmail = typeof custRes.data["email"] === "string" ? custRes.data["email"] : "";
  const custName = typeof custRes.data["name"] === "string" ? custRes.data["name"] : "";
  if (!custEmail) return false;
  if (dbConfigured()) {
    const prior = await dbSelect<{ event?: string; detail?: Record<string, unknown> | null }>(
      "gh_events",
      `booking_id=eq.${encodeURIComponent(bookingId)}&event=eq.cancellation_fee_receipt_sent&limit=60`,
    );
    // Check the event name too, not just the intent: the query is the
    // primary filter, but the dedupe must not mistake the fee-paid
    // event itself (same intent) for the receipt event.
    if (prior.some((e) => e.event === "cancellation_fee_receipt_sent" && e.detail?.["payment_intent"] === piId)) return true;
  } else if ((custRes.data["metadata"] as Record<string, string> | undefined)?.["gh_fee_receipt_email_id"]) {
    return true;
  }
  const firstName = custName.trim().split(/\s+/)[0] || "there";
  const dollars = (amountCents / 100).toFixed(2).replace(/\.00$/, "");
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
        to: [custEmail],
        reply_to: "hello@gatehousehomecleaning.com",
        subject: `Your Gatehouse receipt — late-cancellation fee $${dollars}`,
        text:
          `Hi ${firstName},\n\nThank you — your late-cancellation fee is paid.\n\n` +
          `Amount paid: $${dollars}\nBooking: ${bookingId.slice(0, 8)}\n\n` +
          `This fee applies because the visit was cancelled within 48 hours, as agreed. ` +
          `It is separate from the cleaning itself — no cleaning charge was made for this booking.\n\n` +
          `If anything looks wrong, just reply to this email — we'll review it.\n\n` +
          `Gatehouse Home Cleaning\n`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return false;
    const j = (await resp.json()) as { id?: string };
    if (dbConfigured()) {
      const rows = await dbSelect<{ id: string }>(
        "gh_visits",
        `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
      );
      if (rows[0]) {
        await logEvent(rows[0].id, bookingId, "system", "cancellation_fee_receipt_sent", {
          payment_intent: piId, amount_cents: amountCents, email_id: j.id ?? "",
        });
      }
    } else if (typeof j.id === "string" && j.id) {
      await stripePost(secretKey, `/customers/${customerId}`, {
        "metadata[gh_fee_receipt_email_id]": j.id,
      });
    }
    return true;
  } catch {
    return false;
  }
}

type VisitRowLite = {
  id: string;
  status: string;
  report_status: string;
  report_sent_at: string | null;
  issue_open?: boolean | null;
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
  service?: string | null;
  // Synced on every issue transition (client issue, dispute, resolve,
  // resend, client approval); PostgREST returns them even though the
  // lite type used to omit them.
  issue_open?: boolean | null; issue_ever?: boolean | null;
};
type BookingEvent = { event: string; detail: Record<string, unknown> | null; created_at: string };
// RA04: strict loaders that tell "no row" apart from "the DB could
// not be read". A state-changing action must fail closed on a read
// error, never silently fall back to shared customer metadata.
async function latestBookingRowStrict(bookingId: string): Promise<{ ok: boolean; row: BookingRow | null }> {
  if (!dbConfigured()) return { ok: true, row: null };
  const r = await dbSelectStrict<BookingRow>(
    "gh_visits",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=visit_no.desc&limit=1`,
  );
  if (!r.ok) return { ok: false, row: null };
  return { ok: true, row: r.rows[0] ?? null };
}
async function bookingEventsStrict(bookingId: string): Promise<{ ok: boolean; events: BookingEvent[] }> {
  if (!dbConfigured()) return { ok: true, events: [] };
  const r = await dbSelectStrict<BookingEvent>(
    "gh_events",
    `booking_id=eq.${encodeURIComponent(bookingId)}&order=created_at.desc&limit=60`,
  );
  if (!r.ok) return { ok: false, events: [] };
  return { ok: true, events: r.rows };
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
  // An operator approval is not client consent: a stale operator event
  // must not re-arm "approved" when this booking is hydrated (G3).
  // P01: an approval superseded by a later republication is not consent
  // for the new report either.
  const approvedEv = clientApprovedEvent(events);
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

/** The owner's "Approve request" step (distinct from confirming the
 * visit): recorded as a journal event, never as a claim that a cleaner
 * is assigned or the date is final. */
async function hasRequestApproved(visitId: string): Promise<boolean> {
  const rows = await dbSelect<{ id: number }>(
    "gh_events",
    `visit_id=eq.${visitId}&event=eq.request_approved&limit=1`,
  );
  return rows.length > 0;
}

type RosterRow = {
  id: string;
  name: string;
  phone: string | null;
  photo_url: string | null;
  active: boolean;
};

async function findRosterCleaner(cleanerId: string): Promise<RosterRow | null> {
  const rows = await dbSelect<RosterRow>(
    "gh_cleaners",
    `id=eq.${encodeURIComponent(cleanerId)}&limit=1`,
  );
  return rows[0] ?? null;
}

/** Parse a pasted roster CSV (the Indeed transfer path: the employer
 * dashboard export pasted into the panel). Columns: name, phone,
 * photo URL, active. A header row is skipped when its first cell reads
 * "name". Returns valid rows plus per-line errors; callers import only
 * the valid rows. */
function parseRosterCsv(csv: string): {
  rows: { name: string; phone: string | null; photo_url: string | null; active: boolean }[];
  errors: { line: number; error: string }[];
} {
  const rows: { name: string; phone: string | null; photo_url: string | null; active: boolean }[] = [];
  const errors: { line: number; error: string }[] = [];
  const lines = csv.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;
    const cells = raw.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && cells[0]?.toLowerCase() === "name") continue;
    const name = cells[0] ?? "";
    const phone = cells[1] ?? "";
    const photo = cells[2] ?? "";
    const activeRaw = (cells[3] ?? "").toLowerCase();
    if (!name) {
      errors.push({ line: i + 1, error: "missing_name" });
      continue;
    }
    if (phone && !validCleanerPhone(phone)) {
      errors.push({ line: i + 1, error: "invalid_phone" });
      continue;
    }
    if (photo && !photo.startsWith("https://")) {
      errors.push({ line: i + 1, error: "invalid_photo_url" });
      continue;
    }
    rows.push({
      name: name.slice(0, 80),
      phone: phone || null,
      photo_url: photo || null,
      active: !(activeRaw === "false" || activeRaw === "no" || activeRaw === "0"),
    });
  }
  return { rows, errors };
}

/** The owner confirmation email, shared by confirm and resend. Returns
 * true only when Resend accepted the message — acceptance is not proof
 * of inbox delivery, and callers must never claim otherwise. */
async function sendConfirmationEmail(args: {
  to: string; firstName: string; date: string; win: string;
  service: string; cleaner: string; cents: number | null; visitLink: string;
  entryMethod?: string | null;
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
  // The booking entry choice (row column, pre-migration rows read null
  // and keep the generic paragraph). Never includes codes or details.
  const entryLine = args.entryMethod === "home"
    ? `\nEntry: you'll be home to let the cleaner in — no codes needed.\n\n`
    : args.entryMethod === "other_person"
      ? `\nEntry: someone else will meet the cleaner — no codes needed.\n\n`
      : args.entryMethod === "arrange_before"
        ? `\nEntry: you chose to arrange entry before the visit — please add your private entry details on your visit page (link below). No entry details are in this email.\n\n`
        : args.entryMethod === "decide_later"
          ? `\nEntry: you asked us to contact you about entry — we'll be in touch before the visit. You can also choose on your visit page (link below).\n\n`
          : `\nArrange entry for your visit: on your visit page, choose how your cleaner gets in — you can be home, have someone meet them, or arrange entry before the visit. No entry details are in this email.\n\n`;
  const entryHtml = args.entryMethod === "home"
    ? `<p><strong>Entry:</strong> you'll be home to let the cleaner in — no codes needed.</p>`
    : args.entryMethod === "other_person"
      ? `<p><strong>Entry:</strong> someone else will meet the cleaner — no codes needed.</p>`
      : args.entryMethod === "arrange_before"
        ? `<p><strong>Entry:</strong> you chose to arrange entry before the visit — please add your private entry details on your visit page (link below). No entry details are in this email.</p>`
        : args.entryMethod === "decide_later"
          ? `<p><strong>Entry:</strong> you asked us to contact you about entry — we'll be in touch before the visit. You can also choose on your visit page (link below).</p>`
          : `<p><strong>Arrange entry for your visit:</strong> on your visit page, choose how your cleaner gets in — you can be home, have someone meet them, or arrange entry before the visit. No entry details are in this email.</p>`;
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
          entryLine +
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
          entryHtml +
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

    // Roster actions carry no booking: they run before the per-booking
    // customer/row resolution below (which would 404 without a booking).
    if (action === "roster_add" || action === "roster_update" || action === "roster_import") {
      if (action === "roster_add") {
        const name = (parsed.data.cleaner_name ?? "").trim();
        if (!name) return json(400, { ok: false, error: "cleaner_name_required" });
        const phone = (parsed.data.cleaner_phone ?? "").trim();
        if (phone && !validCleanerPhone(phone)) return json(400, { ok: false, error: "invalid_phone" });
        const photo = (parsed.data.cleaner_photo ?? "").trim();
        if (photo && !photo.startsWith("https://")) return json(400, { ok: false, error: "invalid_photo_url" });
        const created = await dbInsert<RosterRow>("gh_cleaners", {
          name: name.slice(0, 80),
          phone: phone || null,
          photo_url: photo || null,
          active: parsed.data.active !== false,
        });
        if (!created) return json(502, { ok: false, error: "db_error" });
        return json(200, { ok: true, cleaner: created });
      }
      if (action === "roster_update") {
        const cleanerId = (parsed.data.cleaner_id ?? "").trim();
        if (!cleanerId) return json(400, { ok: false, error: "cleaner_id_required" });
        const existing = await findRosterCleaner(cleanerId);
        if (!existing) return json(404, { ok: false, error: "cleaner_not_found" });
        const patch: Record<string, unknown> = {};
        if (parsed.data.cleaner_name !== undefined) {
          const name = parsed.data.cleaner_name.trim();
          if (!name) return json(400, { ok: false, error: "cleaner_name_required" });
          patch["name"] = name.slice(0, 80);
        }
        if (parsed.data.cleaner_phone !== undefined) {
          const phone = parsed.data.cleaner_phone.trim();
          if (phone && !validCleanerPhone(phone)) return json(400, { ok: false, error: "invalid_phone" });
          patch["phone"] = phone || null;
        }
        if (parsed.data.cleaner_photo !== undefined) {
          const photo = parsed.data.cleaner_photo.trim();
          if (photo && !photo.startsWith("https://")) return json(400, { ok: false, error: "invalid_photo_url" });
          patch["photo_url"] = photo || null;
        }
        if (parsed.data.active !== undefined) patch["active"] = parsed.data.active;
        if (Object.keys(patch).length === 0) return json(400, { ok: false, error: "nothing_to_update" });
        const ok = await dbUpdate("gh_cleaners", `id=eq.${encodeURIComponent(cleanerId)}`, patch);
        if (!ok) return json(502, { ok: false, error: "db_error" });
        return json(200, { ok: true, cleaner: { ...existing, ...patch } });
      }
      // roster_import
      const csv = (parsed.data.csv ?? "").trim();
      if (!csv) return json(400, { ok: false, error: "csv_required" });
      const { rows: importRows, errors } = parseRosterCsv(csv);
      if (importRows.length > 50) return json(400, { ok: false, error: "too_many_rows" });
      let imported = 0;
      for (const r of importRows) {
        const created = await dbInsert("gh_cleaners", r);
        if (created) imported++;
        else errors.push({ line: 0, error: "db_error" });
      }
      return json(200, { ok: true, imported, errors });
    }
    if (!bookingId) return json(400, { ok: false, error: "invalid_request" });

    const boundCustomer = await findCustomerByBooking(STRIPE_SECRET_KEY, bookingId);
    const rowRes = await latestBookingRowStrict(bookingId);
    if (!rowRes.ok) {
      logErr("lookup", "visit row unreadable");
      return json(502, { ok: false, error: "db_unreadable" });
    }
    const row = rowRes.row;
    let events: BookingEvent[] = [];
    if (row) {
      const evRes = await bookingEventsStrict(bookingId);
      if (!evRes.ok) {
        logErr("lookup", "visit journal unreadable");
        return json(502, { ok: false, error: "db_unreadable" });
      }
      events = evRes.events;
    }
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
          // access_notes intentionally absent: the legacy shared-
          // metadata channel is closed; entry lives in gh_visit_access.
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
            entryMethod: (row as unknown as { entry_method?: string | null } | null)?.entry_method ?? null,
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

    if (action === "assign_confirm") {
      // One step: assign a roster cleaner AND confirm the visit. The
      // assignment runs on the roster's stable ID (never free text for a
      // new assignment), and the confirmation email carries the roster
      // cleaner's name. Repeat clicks with the same cleaner/date/window
      // are a no-op — no duplicate email, no link rotation.
      if (!row) return json(404, { ok: false, error: "visit_not_found" });
      const cleanerId = (parsed.data.cleaner_id ?? "").trim();
      if (!cleanerId) return json(400, { ok: false, error: "cleaner_id_required" });
      const date = (parsed.data.confirmed_date ?? "").trim();
      const win = (parsed.data.confirmed_window ?? "").trim();
      const repair = parsed.data.repair === true;
      if (!date) return json(400, { ok: false, error: "confirmed_date_required" });
      if (!win) return json(400, { ok: false, error: "confirmed_window_required" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { ok: false, error: "invalid_date" });
      const roster = await findRosterCleaner(cleanerId);
      if (!roster) return json(404, { ok: false, error: "cleaner_not_found" });
      if (!roster.active) return json(409, { ok: false, error: "cleaner_inactive" });
      const name = roster.name;
      const rowStatus = row.status ?? "";
      if (rowStatus === "cancelled" || rowStatus === "paid") {
        return json(409, { ok: false, error: "invalid_transition", status: rowStatus });
      }
      const wasConfirmed = await hasVisitConfirmed(row.id);
      const reportStatus = row.report_status ?? "";
      const needsRepair = !wasConfirmed && (reportStatus === "submitted" || reportStatus === "sent");
      if (needsRepair && !repair) {
        return json(409, { ok: false, error: "needs_review" });
      }
      const prevCleaner = row.cleaner_name ?? "";
      const rowCleanerId = (row as unknown as { cleaner_id?: string | null }).cleaner_id ?? null;
      // G4: a change of person is decided by the stable roster ID, not
      // the name — two roster cleaners can share a name, and the second
      // one must still revoke the first one's link. Rows minted before
      // cleaner_id existed fall back to the name comparison.
      const changed = Boolean(prevCleaner) && (rowCleanerId ? rowCleanerId !== cleanerId : prevCleaner !== name);
      const firstAssignment = !prevCleaner;
      const already =
        rowStatus === "confirmed" &&
        row.visit_date === date &&
        (row.window ?? "") === win &&
        (rowCleanerId === cleanerId || (!rowCleanerId && prevCleaner === name));
      // Metadata refresh (idempotent): the client page reads
      // confirmation from metadata, and the shared customer record may
      // currently carry another booking's values.
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_booking_confirmed]": "1",
        "metadata[gh_confirmed_date]": date,
        "metadata[gh_confirmed_window]": win,
        "metadata[gh_cleaner_name]": name.slice(0, 80),
        "metadata[gh_cleaner_photo]": roster.photo_url ?? "",
      });
      if (already) {
        return json(200, {
          ok: true,
          booking_confirmed: true,
          confirmed_date: date,
          confirmed_window: win,
          cleaner_id: cleanerId,
          cleaner_name: name,
          email_sent: false,
          already_confirmed: true,
        });
      }
      // N09: revoke BEFORE the assignment lands, verified. The old
      // order (assign first, revoke best-effort after) let an A→B
      // change with a failed revoke keep the old secret bound to A —
      // and a later A reassignment re-exposed it. A failed revoke now
      // aborts the assignment entirely.
      if (changed) {
        const revoked = await revokeAccessForCleanerChange(row.id, cleanerId);
        if (!revoked) {
          logErr("assign_confirm", "entry revoke failed — assignment aborted");
          return json(502, { ok: false, error: "entry_revoke_failed" });
        }
      }
      // Save FIRST: one patch for assignment + confirmation, so the
      // record can never show one without the other. Report state is
      // untouched: a repair keeps a submitted report in review.
      const rowOk = await dbUpdate("gh_visits", `id=eq.${row.id}`, {
        cleaner_id: cleanerId,
        cleaner_name: name.slice(0, 80),
        cleaner_profile: { phone: roster.phone, photo: roster.photo_url },
        status: "confirmed",
        visit_date: date,
        window: win,
      });
      if (!rowOk) {
        logErr("assign_confirm", "visit row update failed");
        return json(502, { ok: false, error: "db_error" });
      }
      if (changed) {
        await logEvent(row.id, bookingId, "owner", "entry_revoked");
      }
      // Link: a new or changed person gets a fresh v2 link (old one
      // dies); the same person keeps the current link.
      let linkOut: { url: string; expires: string; reusable: boolean } | null = null;
      if (changed || firstAssignment) {
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
          // The old code fell back silently: a mint failure and a DB
          // write failure looked identical afterwards. Log the reason
          // so the next legacy link is diagnosable.
          await logEvent(row.id, bookingId, "owner", "cleaner_link_legacy_fallback", {
            reason: !v2 ? "v2_mint_null" : "v2_write_failed",
            legacy_saved: Boolean(okLeg),
          });
        }
        if (linkOut) {
          await logEvent(row.id, bookingId, "owner", "cleaner_link_rotated", { reason: "cleaner_changed", expires: linkOut.expires });
        }
      } else {
        const recomputed = recomputeV2Link(row as unknown as CleanerRow);
        if (recomputed) linkOut = { url: recomputed.url, expires: recomputed.expires, reusable: true };
      }
      if (changed || firstAssignment) {
        await logEvent(row.id, bookingId, "owner", "cleaner_assigned", { cleaner_id: cleanerId, cleaner_name: name });
      }
      // Email second: a failed send keeps the assignment + confirmation
      // and surfaces as notification status, never as a rollback.
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
            service: row.service ?? "",
            cleaner: name,
            cents: Number.isFinite(cents) && cents > 0 ? cents : null,
            visitLink: `https://www.gatehousehomecleaning.com/visit?bt=${visitToken}`,
            entryMethod: (row as unknown as { entry_method?: string | null }).entry_method ?? null,
          });
        }
      }
      await logEvent(row.id, bookingId, "owner", "visit_confirmed", { date, window: win, ...(repair ? { repair: true } : {}) });
      await logEvent(row.id, bookingId, "system", emailSent ? "confirmation_email_sent" : "confirmation_email_failed", {});
      log("assign_confirm", { booking: bookingId, cleaner: name, emailSent, already: false });
      return json(200, {
        ok: true,
        booking_confirmed: true,
        confirmed_date: date,
        confirmed_window: win,
        cleaner_id: cleanerId,
        cleaner_name: name,
        email_sent: emailSent,
        already_confirmed: false,
        ...(linkOut ? { url: linkOut.url, expires: linkOut.expires, reusable: linkOut.reusable } : {}),
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
            entryMethod: (row as unknown as { entry_method?: string | null } | null)?.entry_method ?? null,
          });
        }
      }
      if (row) {
        await logEvent(row.id, bookingId, "system", emailSent ? "confirmation_email_sent" : "confirmation_email_failed", {});
      }
      log("resend_confirmation", { booking: bookingId, emailSent });
      return json(200, { ok: true, email_sent: emailSent });
    }

    if (action === "approve_request") {
      // The owner accepts the request into the pipeline. This is NOT a
      // confirmation: it claims neither an assigned cleaner nor a final
      // date. The client page keeps showing "awaiting confirmation"
      // until Assign & confirm runs — approval alone must never imply
      // the visit is settled.
      if (!row) return json(404, { ok: false, error: "visit_not_found" });
      const rowStatus = row.status ?? "";
      if (rowStatus === "cancelled" || rowStatus === "paid") {
        return json(409, { ok: false, error: "invalid_transition", status: rowStatus });
      }
      if (await hasRequestApproved(row.id)) {
        return json(200, { ok: true, request_approved: true, already: true });
      }
      await logEvent(row.id, bookingId, "owner", "request_approved", {});
      return json(200, { ok: true, request_approved: true, already: false });
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
      // charging for an already-settled visit. The gate is booking-scoped
      // (row + journal) for row-backed bookings: shared customer metadata
      // may describe another booking of this email (O1).
      const issueIsOpen = row
        ? issueStateFrom(events, row.issue_open ?? null, row.issue_ever ?? null).open
        : state === "issue_open";
      if (!issueIsOpen) {
        logErr("resolve", `blocked: no open issue (shared state=${state})`);
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
      // CLOSED (G3): an operator approval used to write gh_state=approved
      // and a report_approved journal event, which the charge action then
      // treated as client consent — so a booking with a card but no sent
      // report could be charged without the client ever seeing a report.
      // Payment approval comes only from the client's own Approve on
      // /report, or from the 24h timer rule; the charge action checks
      // that basis directly, so no operator "arming" step exists anymore.
      // Request acceptance stays approve_request; issue handling stays
      // resolve. (A client who approves by email presses Approve on the
      // report link; after 24h of silence the timer rule applies.)
      logErr("approve", "blocked: operator approve is not client payment approval");
      return json(409, { ok: false, error: "operator_approve_disabled" });
    }

    if (action === "charge") {
      const amountCents = parsed.data.amount_cents;
      if (!amountCents) {
        return json(400, { ok: false, error: "amount_required" });
      }
      // Row-backed bookings charge through the single shared flow
      // (RA01-RA13): the row's pinned amount, the journal's publication,
      // an atomic claim, reconcile-before-create, a verified paid write.
      // An operator charge never pays a draft, submitted or returned
      // report (RA05) and never reuses consent voided by a later
      // dispute (RA09).
      if (row) {
        if (row.status === "paid") {
          logErr("charge", "blocked: already paid");
          return json(409, { ok: false, error: "already_paid" });
        }
        if (row.status === "cancelled") {
          logErr("charge", "blocked: already cancelled");
          return json(409, { ok: false, error: "already_cancelled" });
        }
        const paymentMethod = meta["gh_payment_method"];
        if (!paymentMethod) {
          logErr("charge", "blocked: no saved payment method");
          return json(409, { ok: false, error: "no_payment_method" });
        }
        const outcome = await chargeVisit({
          secretKey: STRIPE_SECRET_KEY,
          bookingId,
          customerId: customer.id,
          customerEmail: customer.email ?? null,
          paymentMethod,
          source: "owner_charge",
          allowedBases: ["client_approved", "timer_rule"],
          requestedAmountCents: amountCents,
          nowMs: Date.now(),
          deps: {
            setCustomerMeta: async (patch) => {
              const params: Record<string, string> = {};
              for (const [k, v] of Object.entries(patch)) params[`metadata[${k}]`] = v;
              await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, params);
            },
            sendReceipt: (cents) => sendReceiptEmailOnce(
              STRIPE_SECRET_KEY, customer.id,
              { ...meta, gh_report_amount_cents: String(cents) },
              bookingId,
            ),
            sendPaymentFailedEmail: async (visitId) => {
              await sendPaymentFailedEmailOnce(
                STRIPE_SECRET_KEY, customer.id, bookingId, visitId,
              );
            },
          },
        });
        if (outcome.outcome === "paid") {
          log("charge", { booking: bookingId, status: outcome.adopted ? "adopted" : "succeeded", payment_intent: outcome.payment_intent });
          return json(200, { ok: true, state: "paid", payment_intent: outcome.payment_intent, receipt_sent: outcome.receipt_sent, ...(outcome.adopted ? { adopted: true } : {}) });
        }
        if (outcome.outcome === "blocked") {
          if (outcome.error === "visit_not_chargeable") return json(409, { ok: false, error: "already_cancelled" });
          if (outcome.error === "price_review_required") return json(409, { ok: false, error: "price_review_required", pinned_cents: outcome.pinned_cents });
          return json(409, { ok: false, error: outcome.error });
        }
        if (outcome.outcome === "processing") return json(409, { ok: false, error: "payment_processing" });
        if (outcome.outcome === "mismatch") return json(409, { ok: false, error: "payment_intent_mismatch" });
        if (outcome.outcome === "failed") {
          return json(402, { ok: false, error: outcome.error === "payment_requires_action" ? "payment_requires_action" : "payment_failed", detail: outcome.detail });
        }
        return json(502, { ok: false, error: outcome.error });
      }
      // No visit row: there is no durable obligation to charge
      // (N08/RA01). Shared customer metadata is not proof of amount,
      // consent, payment or absence of a dispute, so a booking without
      // a row is NOT chargeable here — it needs an explicit migration
      // record first, not a metadata charge. A DB read failure would
      // have produced the same shape, so it fails closed too.
      logErr("charge", "blocked: no visit row for booking");
      return json(409, { ok: false, error: "no_visit_row" });
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
        // A re-send must not land while a charge is in flight: its CAS
        // would overwrite the claim's payment_pending status back to
        // report_sent, orphaning a succeeded intent (payment_unconfirmed
        // with money moved, unadoptable until the timer). The window is
        // seconds wide; the owner retries after the charge settles.
        if (visitRow.status === "payment_pending") {
          return json(409, {
            ok: false, error: "payment_in_flight",
            hint: "A payment for this visit is in progress. Wait for it to settle, then re-send if still needed.",
          });
        }
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
      // Pin the agreed amount for THIS visit's report. A visit's price is
      // fixed at submission (gh_visits.amount_cents): a (re-)send never
      // re-prices it — the old "recurring price after the first report"
      // rule charged resends at the recurring rate (G2). The operator
      // may pass amount_cents, but for a row-backed booking it must
      // equal the pinned price. Legacy bookings without a row keep the
      // agreed-order validation (first or recurring price).
      const firstCents = parseInt(meta["gh_first_price_cents"] ?? "", 10);
      const recurringCents = parseInt(meta["gh_recurring_price_cents"] ?? "", 10);
      let amountCents = parsed.data.amount_cents;
      if (row?.amount_cents) {
        if (amountCents !== undefined && amountCents !== row.amount_cents) {
          return json(400, { ok: false, error: "amount_not_agreed" });
        }
        amountCents = row.amount_cents;
      } else if (amountCents !== undefined) {
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
      // A failed (bounced) send is always retryable: without this, a
      // re-send within 10 minutes of a failed send would no-op and the
      // client would never get the report email.
      if (
        meta["gh_report_bounced"] !== "1" &&
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
      // R01: claim the publication BEFORE sending the email. Two
      // concurrent (re-)sends both pass the sequential 10-minute guard
      // above (same old metadata read); only the CAS winner sends.
      // First publish: submitted→sent. Resend: the row's current
      // report_sent_at is the expected value — only send_report writes
      // it, so a changed value means another send already claimed this
      // slot. The loser returns the existing result, no second email,
      // no second report_sent event. Legacy (no row) keeps the guard.
      // N07 journal repair: a previous send emailed the report and
      // claimed the row, but its report_sent journal event was lost.
      // The timer requires that event, so repair it WITHOUT re-emailing
      // (the Resend message id in metadata proves the email went out).
      if (visitRow && visitRow.report_status === "sent" && meta["gh_report_email_id"]
        && !events.some((e) => e.event === "report_sent")) {
        const repaired = await logEventStrict(visitRow.id, bookingId, "owner", "report_sent", {
          version: parseInt(meta["gh_report_version"] ?? "1", 10) || 1,
          email_sent: true, photos: 0, journal_repaired: true,
        });
        if (repaired) {
          return json(200, { ok: true, state: "report_sent", already_sent: true, email_sent: true, journal_repaired: true });
        }
        return json(502, { ok: false, error: "journal_failed" });
      }
      if (visitRow) {
        // N01: the CAS must check the PAYMENT status too, atomically.
        // The old resend CAS matched only report_sent_at, so a resend
        // that read the pre-charge state could overwrite a charge's
        // payment_pending claim back to report_sent — orphaning the
        // in-flight intent while a new Approve minted a second one
        // (the audit's $200 × 2). A first publish additionally
        // requires the row NOT to be payment_pending.
        const casMatch = visitRow.report_status === "submitted"
          ? `id=eq.${visitRow.id}&report_status=eq.submitted&status=neq.payment_pending`
          : visitRow.report_sent_at
            ? `id=eq.${visitRow.id}&report_sent_at=eq.${encodeURIComponent(visitRow.report_sent_at)}&status=eq.report_sent`
            : `id=eq.${visitRow.id}&report_status=eq.sent&status=eq.report_sent`;
        const claimed = await dbUpdateCount("gh_visits", casMatch, {
          report_status: "sent",
          report_sent_at: sentAt,
          status: "report_sent",
          // Publishing a fresh report supersedes any earlier issue
          // (matches the metadata, which send_report clears below).
          issue_open: false,
        });
        if (claimed === 0) {
          // N01: a lost CAS is not automatically "already sent". If a
          // payment is in flight, say so honestly; only a row that is
          // already sent (and not pending) is an existing result.
          const freshVisit = await latestVisit(bookingId);
          if (freshVisit?.status === "payment_pending") {
            return json(409, {
              ok: false, error: "payment_in_flight",
              hint: "A payment for this visit is in progress. Wait for it to settle, then re-send if still needed.",
            });
          }
          return json(200, { ok: true, state: "report_sent", already_sent: true, email_sent: false });
        }
        // RA15: claimed === -1 means the DB could not be read for the
        // claim. Fail closed: no email, no metadata write, no
        // report_sent event. The row stays submitted, so a retry
        // after recovery completes the same publication exactly once.
        // (Falling through to the legacy path here used to send the
        // email and mark the report sent while the row stayed
        // submitted — a phantom publication.)
        if (claimed < 0) {
          return json(502, { ok: false, error: "db_error" });
        }
      }
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
      if (!emailSent && visitRow) {
        // N07: the report email did not go out, so the 24h clock must
        // NOT run on this publication. The bounce block is a VERIFIED
        // row write; if even that fails, the publication itself is
        // rolled back to its pre-CAS state (no report_sent journal
        // event is written either way) and the operator gets an error
        // to retry — never a silent "sent" row the client never saw.
        const bounced = await dbUpdateCount("gh_visits", `id=eq.${visitRow.id}`, {
          report_bounced: true,
        });
        if (bounced !== 1) {
          await dbUpdateCount(
            "gh_visits",
            `id=eq.${visitRow.id}&report_sent_at=eq.${encodeURIComponent(sentAt)}&status=eq.report_sent`,
            {
              report_status: visitRow.report_status,
              report_sent_at: visitRow.report_sent_at,
              status: visitRow.status,
              issue_open: visitRow.issue_open === true,
            },
          );
          await logEvent(visitRow.id, bookingId, "system", "report_delivery_failed", {
            version, reason: "email_failed_bounce_write_failed",
          });
          logErr("send_report", "email not sent and bounce write failed — publication rolled back");
          return json(502, { ok: false, error: "db_error" });
        }
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_report_bounced]": "1",
        });
        await logEvent(visitRow.id, bookingId, "system", "report_delivery_failed", {
          version, reason: "email_not_sent",
        });
        logErr("send_report", "email not sent — auto-charge clock blocked, publication not journaled");
        return json(502, {
          ok: false, error: "report_email_failed",
          hint: "The report email did not go out, so the 24h clock is blocked. Re-send the report.",
        });
      }
      if (!emailSent && !visitRow) {
        // Legacy (no row): nothing durable to block the clock on, so
        // the metadata bounce flag is the only block — set it and
        // report the failure honestly instead of a silent success.
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_report_bounced]": "1",
        });
        logErr("send_report", "email not sent (legacy, no row)");
        return json(502, { ok: false, error: "report_email_failed" });
      }
      if (visitRow) {
        // The publication itself was already claimed by the CAS above;
        // this only records the email outcome of the winning send.
        // Email success is proven here (emailSent true), so the
        // journal event carries email_sent: true — the timer's
        // delivery proof (N07). If the journal write fails, the
        // operator retries and the repair path above heals it
        // without a duplicate email.
        await dbUpdate("gh_visits", `id=eq.${visitRow.id}`, {
          report_email_id: reportEmailId || null,
          report_bounced: false,
        });
        const journaled = await logEventStrict(visitRow.id, bookingId, "owner", "report_sent", {
          version, email_sent: true, photos: finalPhotos.length,
        });
        if (!journaled) {
          logErr("send_report", "email sent but report_sent journal failed — retry repairs it");
          return json(502, { ok: false, error: "journal_failed", email_sent: true });
        }
        if (issueIsOpen) {
          await logEvent(visitRow.id, bookingId, "owner", "issue_resolved", {
            via: "report_resend", note: "Resolved by owner decision together with the re-sent report.",
          });
        }
      }
      if (visitRow) {
        // Entry cleanup after a successful publish: the cleaner no
        // longer needs access. A cleanup failure is journaled but
        // does not fail the publish — the sent report_status itself
        // gates the cleaner view, so a leftover row cannot re-expose
        // the secret (N09).
        const accessDeleted = await deleteAccess(visitRow.id);
        if (!accessDeleted) {
          await logEvent(visitRow.id, bookingId, "system", "entry_revoke_failed", { via: "send_report" });
        } else {
          await logEvent(visitRow.id, bookingId, "system", "entry_revoked");
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
      // Roster-first: a cleaner_id resolves name/phone/photo from the
      // roster (the stable ID is the assignment). A new person by free
      // text alone is refused — the owner picks from the roster instead.
      // Same-person detail edits without an ID keep working.
      const rosterId = (parsed.data.cleaner_id ?? "").trim();
      const prevCleaner = row?.cleaner_name ?? "";
      let name = (parsed.data.cleaner_name ?? "").trim();
      let photo = (parsed.data.cleaner_photo ?? "").trim();
      let rosterPhone: string | null | undefined;
      if (rosterId) {
        const roster = await findRosterCleaner(rosterId);
        if (!roster) return json(404, { ok: false, error: "cleaner_not_found" });
        if (!roster.active) return json(409, { ok: false, error: "cleaner_inactive" });
        name = roster.name;
        photo = roster.photo_url ?? "";
        rosterPhone = roster.phone;
      } else if (prevCleaner && name && prevCleaner !== name) {
        return json(400, { ok: false, error: "cleaner_id_required" });
      }
      if (!name) return json(400, { ok: false, error: "cleaner_name_required" });
      if (photo && !photo.startsWith("https://")) {
        return json(400, { ok: false, error: "invalid_photo_url" });
      }
      const phoneRaw = rosterPhone !== undefined
        ? rosterPhone
        : (parsed.data.cleaner_phone !== undefined ? parsed.data.cleaner_phone.trim() : null);
      if (phoneRaw !== null && !validCleanerPhone(phoneRaw)) {
        return json(400, { ok: false, error: "invalid_phone" });
      }
      const wasConfirmed = row?.status === "confirmed";
      // G4: same rule as assign_confirm — the stable roster ID decides
      // a change of person; the name is only the fallback for rows
      // minted before cleaner_id existed.
      const rowCleanerId = (row as unknown as { cleaner_id?: string | null } | null)?.cleaner_id ?? null;
      const changed = Boolean(prevCleaner) && (rosterId && rowCleanerId ? rowCleanerId !== rosterId : prevCleaner !== name);
      const firstAssignment = !prevCleaner;
      // N09: revoke BEFORE any cleaner change lands (profile, name,
      // link). A failed revoke aborts the whole assignment, so a
      // failed A→B change can never leave A's secret re-exposable.
      if (row && changed) {
        const revoked = await revokeAccessForCleanerChange(row.id, rosterId || null);
        if (!revoked) {
          logErr("set_cleaner", "entry revoke failed — assignment aborted");
          return json(502, { ok: false, error: "entry_revoke_failed" });
        }
      }
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
      if (row && (changed || rosterId || parsed.data.cleaner_phone !== undefined || parsed.data.cleaner_photo !== undefined)) {
        const base = changed ? { phone: null, photo: null } : parseCleanerProfile((row as unknown as CleanerRow).cleaner_profile);
        nextProfile = rosterId
          ? { phone: rosterPhone ?? null, photo: photo || null }
          : {
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
        await dbUpdate("gh_visits", `id=eq.${row.id}`, {
          cleaner_name: name.slice(0, 80),
          ...(rosterId ? { cleaner_id: rosterId } : {}),
        });
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
            // The old code fell back silently: a mint failure and a DB
            // write failure looked identical afterwards. Log the reason
            // so the next legacy link is diagnosable.
            await logEvent(row.id, bookingId, "owner", "cleaner_link_legacy_fallback", {
              reason: !v2 ? "v2_mint_null" : "v2_write_failed",
              legacy_saved: Boolean(okLeg),
            });
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
      if (row && changed) {
        await logEvent(row.id, bookingId, "owner", "entry_revoked");
      }
      if (row && (changed || (!prevCleaner && wasConfirmed))) {
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
      // Owner correction of the visit's entry note. Stored ONLY in
      // gh_visit_access — never in Stripe metadata or the visit row —
      // so a later hydration cannot resurrect stale text, and secrets
      // never enter the shared customer record.
      if (!row) return json(404, { ok: false, error: "visit_not_found" });
      const value = (parsed.data.access_notes ?? "").trim().slice(0, 1000);
      const okUpd = await saveAccessNote(row.id, bookingId, value);
      if (!okUpd) return json(500, { ok: false, error: "update_failed" });
      await logEvent(row.id, bookingId, "owner", "access_notes_updated", { length: value.length });
      log("set_access_notes", { booking: bookingId });
      return json(200, { ok: true, access_notes: value });
    }

    if (action === "charge_fee") {
      // Cancellation fee as its OWN durable obligation (RA, N08):
      // own pinned amount, own state, own intent, own recovery.
      // It never shares the cleaning payment's idempotency key, its
      // journal events, or gh_last_payment — writing a fee intent id
      // into gh_last_payment was exactly how the timer sync once
      // marked an unpaid cleaning "paid" from another booking's fee.
      // A card decline or an unknown outcome is never "fixed" by
      // blindly creating a new fee payment: decline is an established
      // failure (fee_failed, retry allowed), unknown keeps the claim
      // (fee_pending) and the next attempt reconciles first.
      const cancelled = row ? row.status === "cancelled" : state === "cancelled";
      if (!cancelled) {
        return json(409, { ok: false, error: "not_cancelled" });
      }
      if (!row) {
        // No row, no durable fee record: shared metadata alone never
        // authorizes a fee charge (same rule as the cleaning charge).
        return json(409, { ok: false, error: "no_fee_record" });
      }
      const cancelEv = events.find((e) => e.event === "visit_cancelled");
      const feeCents = typeof cancelEv?.detail?.["fee_cents"] === "number"
        ? (cancelEv.detail["fee_cents"] as number)
        : NaN;
      if (!Number.isFinite(feeCents) || feeCents <= 0) {
        return json(409, { ok: false, error: "no_fee_due" });
      }
      const feeRowRes = await dbSelectStrict<{ fee_status: string | null; fee_intent_id: string | null }>(
        "gh_visits",
        `id=eq.${row.id}&limit=1`,
      );
      if (!feeRowRes.ok) return json(502, { ok: false, error: "db_error" });
      const feeRow = feeRowRes.rows[0] ?? null;
      if (feeRow?.fee_status === "fee_paid"
        || events.some((e) => e.event === "fee_charged" || e.event === "cancellation_fee_paid")) {
        return json(200, { ok: true, already: true, fee_cents: feeCents });
      }
      const pm = meta["gh_payment_method"] ?? "";
      if (!pm) return json(409, { ok: false, error: "no_payment_method" });
      // Claim the fee obligation: only an unpaid or previously-failed
      // fee can be claimed; a pending fee is someone else's in-flight
      // attempt and must not be double-claimed.
      const claimed = await dbUpdateCount(
        "gh_visits",
        `id=eq.${row.id}&or=(fee_status.is.null,fee_status.eq.fee_failed)`,
        { fee_status: "fee_pending", fee_amount_cents: feeCents },
      );
      if (claimed === 0) {
        const fresh = await dbSelectStrict<{ fee_status: string | null }>(
          "gh_visits", `id=eq.${row.id}&limit=1`,
        );
        if (fresh.ok && fresh.rows[0]?.fee_status === "fee_paid") {
          return json(200, { ok: true, already: true, fee_cents: feeCents });
        }
        return json(409, { ok: false, error: "fee_processing" });
      }
      if (claimed < 0) return json(502, { ok: false, error: "db_error" });
      const markFeePaid = async (piId: string): Promise<boolean> => {
        const n = await dbUpdateCount(
          "gh_visits",
          `id=eq.${row.id}&fee_status=eq.fee_pending`,
          { fee_status: "fee_paid", fee_intent_id: piId },
        );
        if (n === 1) return true;
        const fresh = await dbSelectStrict<{ fee_status: string | null; fee_intent_id: string | null }>(
          "gh_visits", `id=eq.${row.id}&limit=1`,
        );
        return Boolean(fresh.ok && fresh.rows[0]?.fee_status === "fee_paid" && fresh.rows[0]?.fee_intent_id === piId);
      };
      const markFeeFailed = async (): Promise<void> => {
        await dbUpdate("gh_visits", `id=eq.${row.id}`, { fee_status: "fee_failed" });
      };
      // Reconcile the fee obligation first: a known fee intent, or a
      // search for fee intents of this booking, decides everything.
      // Any failed read is UNKNOWN — the claim stays pending.
      let feeIntent: { id: string; status: string; amount: number } | null = null;
      let feeUnknown = false;
      const knownFeeId = feeRow?.fee_intent_id ?? null;
      if (knownFeeId) {
        const got = await getIntent(STRIPE_SECRET_KEY, knownFeeId);
        if (got.status === "error") {
          feeUnknown = true;
        } else {
          const mismatch = verifyIntentForObligation(got.intent, {
            amountCents: feeCents, currency: "usd", customerId: customer.id, bookingId,
          });
          if (mismatch && got.intent.metadata?.["gh_kind"] !== "cancellation_fee") {
            // A non-fee intent id on the fee row is corrupt data, not
            // a fee payment: refuse, do not adopt it as the fee.
            await markFeeFailed();
            return json(409, { ok: false, error: "payment_intent_mismatch" });
          }
          if (!mismatch) feeIntent = got.intent;
        }
      }
      if (!feeIntent && !feeUnknown) {
        const searched = await searchIntents(STRIPE_SECRET_KEY, bookingId);
        if (searched.status === "error") {
          feeUnknown = true;
        } else {
          const fee = searched.intents
            .filter((pi) => pi.metadata?.["gh_kind"] === "cancellation_fee")
            .sort((a, b) => b.created - a.created)[0] ?? null;
          if (fee) {
            const mismatch = verifyIntentForObligation(fee, {
              amountCents: feeCents, currency: "usd", customerId: customer.id, bookingId,
            });
            if (!mismatch) feeIntent = fee;
          }
        }
      }
      if (feeUnknown) {
        return json(502, { ok: false, error: "payment_unknown" });
      }
      if (feeIntent?.status === "succeeded") {
        if (await markFeePaid(feeIntent.id)) {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
            "metadata[gh_fee_charged]": "1",
          });
          await logEvent(row.id, bookingId, "system", "fee_charged", {
            fee_cents: feeCents, payment_intent: feeIntent.id, adopted: true,
          });
          try {
            await sendFeeReceiptEmailOnce(
              STRIPE_SECRET_KEY, customer.id, bookingId, feeIntent.id, feeCents,
            );
          } catch { /* best-effort */ }
          return json(200, { ok: true, fee_cents: feeCents, payment_intent: feeIntent.id, adopted: true });
        }
        return json(502, { ok: false, error: "payment_unconfirmed" });
      }
      if (feeIntent && feeIntent.status === "processing") {
        return json(409, { ok: false, error: "fee_processing" });
      }
      let piId = feeIntent?.id ?? "";
      let piStatus = "";
      let piOk = false;
      if (feeIntent && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(feeIntent.status)) {
        // Confirm the live fee intent with the CURRENT card. The key
        // is bound to (booking, intent, card): a card change is a new
        // attempt, the same card replays the unknown outcome.
        const methodHash = createHash("sha256").update(pm).digest("hex").slice(0, 12);
        const feeConfirmKey = `fee_${bookingId}_confirm_${feeIntent.id}_${methodHash}`;
        await logEvent(row.id, bookingId, "system", "fee_confirm_started", {
          payment_intent: feeIntent.id, key: feeConfirmKey,
        });
        let res: { ok: boolean; status: number; data: Record<string, unknown> };
        try {
          res = await confirmIntent(STRIPE_SECRET_KEY, feeIntent.id, pm, feeConfirmKey);
        } catch {
          await logEvent(row.id, bookingId, "system", "fee_confirm_attempt", {
            payment_intent: feeIntent.id, outcome: "unknown",
          });
          return json(502, { ok: false, error: "payment_unknown" });
        }
        piOk = res.ok;
        piStatus = String(res.data["status"] ?? "");
        piId = feeIntent.id;
        await logEvent(row.id, bookingId, "system", "fee_confirm_attempt", {
          payment_intent: feeIntent.id, outcome: piOk ? piStatus : "failed",
        });
      } else if (!feeIntent) {
        // No fee intent yet: create exactly one, under the fee's own
        // idempotency key. A retry after an unknown create finds the
        // intent by search above instead of creating a second one.
        let pi: { ok: boolean; status: number; data: Record<string, unknown> };
        try {
          pi = await stripePost(
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
        } catch {
          await logEvent(row.id, bookingId, "system", "fee_create_unknown", { key: `fee_${bookingId}` });
          return json(502, { ok: false, error: "payment_unknown" });
        }
        piOk = pi.ok;
        piStatus = String(pi.data["status"] ?? "");
        piId = String(pi.data["id"] ?? "");
        if (piId) {
          await dbUpdate("gh_visits", `id=eq.${row.id}`, { fee_intent_id: piId });
        }
      }
      if (piOk && piStatus === "succeeded" && piId) {
        if (await markFeePaid(piId)) {
          await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
            "metadata[gh_fee_charged]": "1",
          });
          await logEvent(row.id, bookingId, "system", "fee_charged", {
            fee_cents: feeCents, payment_intent: piId,
          });
          try {
            await sendFeeReceiptEmailOnce(
              STRIPE_SECRET_KEY, customer.id, bookingId, piId, feeCents,
            );
          } catch { /* best-effort */ }
          log("charge_fee", { booking: bookingId, feeCents });
          return json(200, { ok: true, fee_cents: feeCents, payment_intent: piId });
        }
        return json(502, { ok: false, error: "payment_unconfirmed" });
      }
      const errMsg = piStatus || "fee charge failed";
      await markFeeFailed();
      await logEvent(row.id, bookingId, "system", "fee_failed", { detail: errMsg.slice(0, 200) });
      logErr("charge_fee", errMsg);
      return json(402, {
        ok: false,
        error: piStatus === "requires_action" ? "payment_requires_action" : "fee_charge_failed",
        detail: errMsg,
      });
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
        // Insert-or-read (same rule as send-contact): a concurrent
        // cleaner_link must never merge-overwrite an existing row.
        const created = await dbInsert<VisitRowLite & { id: string }>(
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
        );
        visit = created ?? (await latestVisit(bookingId));
        if (!visit) return json(502, { ok: false, error: "db_error" });
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
      // O1: a PUBLISHED report can also be returned — but only while a
      // customer issue is open. That is exactly the fix flow: the charge
      // is already blocked by the open issue, the published report stays
      // visible to the client (report_sent_at is kept), and the cleaner
      // fixes + resubmits; the owner's resend (optionally with
      // resolve_issue) supersedes it. Returning a sent report with no
      // open issue is refused: the 24h clock would keep running mid-fix.
      if (!dbConfigured()) {
        return json(501, { ok: false, error: "db_not_configured" });
      }
      const visit = await latestVisit(bookingId);
      if (!visit) return json(404, { ok: false, error: "visit_not_found" });
      const issueIsOpen = row
        ? issueStateFrom(events, row.issue_open ?? null, row.issue_ever ?? null).open
        : false;
      const returnable = visit.report_status === "submitted"
        || (visit.report_status === "sent" && issueIsOpen);
      if (!returnable) {
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
