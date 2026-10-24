// Cleaner cabinet API — one token-scoped visit per link.
//   GET  /api/cleaner?ct=...            → visit view (scope, checklist, photos)
//   POST /api/cleaner {ct, action}     → checklist | photo_sign | photo_register
//                                         | photo_delete | submit
//
// Legacy tokens are random (32 bytes); v2 tokens are deterministic HMAC
// derivations (see api/_cleaner_link.ts). Either way only the SHA-256 hash
// is stored on the visit row, with an expiry. A link opens exactly one visit: the cleaner
// cannot see other bookings, prices beyond the visit scope, or any payment
// data. Photos live in a private Supabase bucket; the page receives
// short-lived signed URLs, and uploads go straight to Storage with a
// signed upload URL (bytes never pass through this function).

import {
  dbConfigured,
  dbSelect,
  dbInsert,
  dbUpdate,
  dbDelete,
  logEvent,
  storageSignUpload,
  storageSignDownload,
  storageRemove,
  storageObjectInfo,
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  hashToken,
  tokenHashEquals,
} from "./_db.js";
import { cleanerLinkSecretCandidates, verifyCleanerLinkV2 } from "./_cleaner_link.js";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body: unknown;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

type ChecklistItem = { label: string; done: boolean };
type ChecklistRoom = { name: string; items: ChecklistItem[]; skip_reason?: string };
type Checklist = { rooms: ChecklistRoom[]; problem_note?: string; submitted_at?: string };

type VisitRow = {
  id: string;
  booking_id: string;
  client_name: string | null;
  service: string | null;
  visit_date: string | null;
  window: string | null;
  address: string | null;
  access_notes: string | null;
  no_photo_zones: string | null;
  checklist: Checklist;
  report_status: string;
  issue_open?: boolean | null;
  amount_cents?: number | null;
  client_email?: string | null;
  cleaner_token_hash: string | null;
  cleaner_token_expires: string | null;
  cleaner_link_version?: string | null;
  cleaner_link_issuance?: string | null;
  status: string;
};

type PhotoRow = {
  id: string;
  room: string;
  storage_path: string;
  kind: string;
  note: string | null;
  created_at: string;
};

const OWNER_EMAIL = "nikolajmihasenok@gmail.com";
const FROM_EMAIL = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const EDITABLE = new Set(["none", "draft", "returned"]);

const roomSlug = (room: string): string =>
  room.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";

export function sanitizeChecklist(raw: unknown): Checklist | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { rooms?: unknown; problem_note?: unknown };
  if (!Array.isArray(c.rooms) || c.rooms.length === 0 || c.rooms.length > 20) return null;
  const rooms: ChecklistRoom[] = [];
  for (const r of c.rooms as Array<Record<string, unknown>>) {
    if (!r || typeof r.name !== "string" || !Array.isArray(r.items) || r.items.length > 40) return null;
    const items: ChecklistItem[] = [];
    for (const it of r.items as Array<Record<string, unknown>>) {
      if (!it || typeof it.label !== "string") return null;
      items.push({ label: it.label.slice(0, 120), done: it.done === true });
    }
    const room: ChecklistRoom = { name: r.name.slice(0, 60), items };
    if (typeof r.skip_reason === "string" && r.skip_reason.trim()) {
      room.skip_reason = r.skip_reason.slice(0, 200);
    }
    rooms.push(room);
  }
  const out: Checklist = { rooms };
  if (typeof c.problem_note === "string") out.problem_note = c.problem_note.slice(0, 1000);
  if (JSON.stringify(out).length > 64_000) return null;
  return out;
}

async function resolveVisit(
  token: string,
): Promise<{ visit: VisitRow } | { error: string; status: number }> {
  if (!dbConfigured()) return { error: "db_not_configured", status: 501 };
  if (!token || token.length < 20 || token.length > 200) {
    return { error: "invalid_link", status: 404 };
  }
  // v2 deterministic tokens: strict verification — structure, HMAC under
  // the server secret, issuance recorded on the row, and the stored hash
  // of the finished token. A v2 token never falls through to the legacy
  // hash lookup, and a missing secret fails closed (legacy links still
  // work below).
  if (token.startsWith("ct2.")) {
    // Try every candidate secret (env first, derived fallback) so links
    // minted before the env secret was added keep opening afterwards.
    let verified: ReturnType<typeof verifyCleanerLinkV2> = null;
    for (const secret of cleanerLinkSecretCandidates()) {
      verified = verifyCleanerLinkV2(secret, token);
      if (verified) break;
    }
    if (!verified) return { error: "invalid_link", status: 404 };
    const rows = await dbSelect<VisitRow>(
      "gh_visits",
      `id=eq.${verified.visitId}&limit=1`,
    );
    const visit = rows[0];
    if (!visit) return { error: "invalid_link", status: 404 };
    if (
      visit.cleaner_link_version !== "v2" ||
      visit.cleaner_link_issuance !== verified.issuanceId ||
      !visit.cleaner_token_hash ||
      !tokenHashEquals(hashToken(token), visit.cleaner_token_hash)
    ) {
      return { error: "invalid_link", status: 404 };
    }
    if (visit.cleaner_token_expires && Date.parse(visit.cleaner_token_expires) < Date.now()) {
      return { error: "link_expired", status: 410 };
    }
    return { visit };
  }
  const rows = await dbSelect<VisitRow>(
    "gh_visits",
    `cleaner_token_hash=eq.${hashToken(token)}&limit=1`,
  );
  const visit = rows[0];
  if (!visit) return { error: "invalid_link", status: 404 };
  if (visit.cleaner_token_expires && Date.parse(visit.cleaner_token_expires) < Date.now()) {
    return { error: "link_expired", status: 410 };
  }
  return { visit };
}

/** Rooms that still block submission: no after-photo and no skip reason. */
export function missingRooms(
  checklist: Checklist,
  photos: { room: string; kind: string }[],
): string[] {
  const missing: string[] = [];
  for (const room of checklist.rooms ?? []) {
    const hasPhoto = photos.some((ph) => ph.room === room.name && ph.kind === "after");
    if (!hasPhoto && !room.skip_reason) missing.push(room.name);
  }
  return missing;
}

async function photosOf(visitId: string): Promise<PhotoRow[]> {
  return dbSelect<PhotoRow>(
    "gh_photos",
    `visit_id=eq.${visitId}&order=created_at.asc&limit=200`,
  );
}

/** A visit counts as confirmed only when the owner confirmed it: the
 * visit_confirmed journal event is the proof. Row status alone cannot
 * prove it — submit overwrites status to report_submitted, so a
 * submitted row may or may not have been confirmed first. */
async function visitConfirmed(visitId: string): Promise<boolean> {
  const rows = await dbSelect<{ id: number }>(
    "gh_events",
    `visit_id=eq.${visitId}&event=eq.visit_confirmed&limit=1`,
  );
  return rows.length > 0;
}

async function view(visit: VisitRow) {
  const photos = await photosOf(visit.id);
  const withUrls = await Promise.all(
    photos.map(async (p) => ({
      id: p.id,
      room: p.room,
      kind: p.kind,
      note: p.note,
      created_at: p.created_at,
      url: await storageSignDownload(p.storage_path, 3600),
    })),
  );
  const events = await dbSelect<{ detail: { note?: string } | null }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.report_returned&order=created_at.desc&limit=1`,
  );
  // The customer's general comments (booking form "Notes") — kept separate
  // from access instructions so the two never merge into one dump again.
  const noteEvents = await dbSelect<{ detail: { text?: string } | null }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.client_note&order=created_at.desc&limit=1`,
  );
  const firstName = (visit.client_name ?? "").trim().split(/\s+/)[0] ?? "";
  return {
    ok: true,
    confirmed: await visitConfirmed(visit.id),
    visit: {
      service: visit.service,
      date: visit.visit_date,
      window: visit.window,
      address: visit.address,
      access_notes: visit.access_notes,
      client_notes: noteEvents[0]?.detail?.text ?? null,
      no_photo_zones: visit.no_photo_zones,
      client_first_name: firstName,
    },
    checklist: visit.checklist ?? { rooms: [] },
    photos: withUrls,
    report_status: visit.report_status,
    editable: EDITABLE.has(visit.report_status),
    owner_note: events[0]?.detail?.note ?? null,
  };
}

const STRIPE_API = "https://api.stripe.com/v1";

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
): Promise<{ id: string } | null> {
  const q = `metadata['gh_booking_id']:'${bookingId}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query: q, limit: "1" })}`);
  if (res.ok && Array.isArray(res.data["data"]) && res.data["data"].length > 0) {
    const c = res.data["data"][0] as { id?: string };
    if (c.id) return { id: c.id };
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (listRes.ok && Array.isArray(listRes.data["data"])) {
    for (const c of listRes.data["data"] as Array<{ id?: string; metadata?: Record<string, string> }>) {
      if (c.id && c.metadata?.["gh_booking_id"] === bookingId) return { id: c.id };
    }
  }
  return null;
}

// v2 booking-link minting (same scheme as booking-action /
// send-contact-email): the report email links the client to
// /visit?bt=...#report.
type BookingPayload = { bid: string; email: string; name: string; ts: number };

function encryptBookingPayload(secret: string, payload: BookingPayload): string {
  const key = createHash("sha256").update(`gatehouse-booking-link:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2.${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
}

const escHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Publish a finished report straight to the client: the row moves to
 * report_sent, the 24h Terms clock starts from the publish time, and
 * the client gets the "Your cleaning report is ready" email — the same
 * email the owner's manual publish used to send. A failed email does
 * NOT start the clock: the report is marked bounced, auto-charge skips
 * it, and the owner re-sends from the panel. Returns ok:false when the
 * publish itself cannot happen (no customer, no pinned amount, an open
 * issue) — the caller then falls back to the owner review queue. */
async function publishReportToClient(
  visit: VisitRow,
  photos: PhotoRow[],
): Promise<{ ok: true; email_sent: boolean; version: number; sent_at: string } | { ok: false; error: string }> {
  const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
  if (!STRIPE_SECRET_KEY) return { ok: false, error: "stripe_not_configured" };
  const customer = await findCustomerByBooking(STRIPE_SECRET_KEY, visit.booking_id);
  if (!customer) return { ok: false, error: "customer_not_found" };
  const custRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${customer.id}`);
  const meta = (custRes.data["metadata"] ?? {}) as Record<string, string>;
  if (meta["gh_issue_open"] === "1") return { ok: false, error: "issue_open" };
  const custEmail = typeof custRes.data["email"] === "string" ? (custRes.data["email"] as string) : "";
  const custName = typeof custRes.data["name"] === "string" ? (custRes.data["name"] as string) : "";
  const amountCents = visit.amount_cents ?? parseInt(meta["gh_first_price_cents"] ?? "", 10);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { ok: false, error: "quote_missing" };
  const version = (parseInt(meta["gh_report_version"] ?? "0", 10) || 0) + 1;
  const sentAt = new Date().toISOString();
  const photoHash = createHash("sha256").update(photos.map((p) => p.storage_path).join("|")).digest("hex").slice(0, 16);
  const params: Record<string, string> = {
    "metadata[gh_state]": "report_sent",
    "metadata[gh_issue_open]": "",
    "metadata[gh_issue_reason]": "",
    "metadata[gh_report_sent_at]": sentAt,
    "metadata[gh_report_version]": String(version),
    "metadata[gh_report_amount_cents]": String(amountCents),
    "metadata[gh_report_bounced]": "",
    "metadata[gh_rp_hash]": photoHash,
    "metadata[gh_rp_source]": "db",
  };
  for (let i = 0; i < 4; i++) params[`metadata[gh_rp_${i}]`] = "";
  await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, params);
  let emailSent = false;
  let reportEmailId = "";
  const RESEND_API_KEY = process.env["RESEND_API_KEY"];
  if (RESEND_API_KEY && custEmail) {
    const firstName = custName.trim().split(/\s+/)[0] || "there";
    const token = encryptBookingPayload(process.env["BOOKING_LINK_SECRET"] || STRIPE_SECRET_KEY, {
      bid: visit.booking_id,
      email: custEmail,
      name: custName,
      ts: Math.floor(Date.now() / 1000),
    });
    const link = `https://www.gatehousehomecleaning.com/visit?bt=${token}#report`;
    const priceLine = ` Your card is charged $${(amountCents / 100).toFixed(2).replace(/\.00$/, "")} once you approve.`;
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
            `<p><a href="${escHtml(link)}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View report</a></p>` +
            `<p style="font-size:13px;color:#555;">If the button doesn't work, use the link in the plain-text version of this email.</p>` +
            `<p>Nick<br>Gatehouse Home Cleaning</p></div>`,
        }),
        signal: AbortSignal.timeout(15000),
      });
      emailSent = resp.ok;
      if (resp.ok) {
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
  if (!emailSent) {
    // The client cannot see the report, so the 24h clock must NOT run.
    await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
      "metadata[gh_report_bounced]": "1",
    });
  }
  await dbUpdate("gh_visits", `id=eq.${visit.id}`, {
    report_status: "sent",
    report_sent_at: sentAt,
    report_email_id: reportEmailId || null,
    report_bounced: !emailSent,
    status: "report_sent",
  });
  await logEvent(visit.id, visit.booking_id, "cleaner", "report_sent", {
    version, email_sent: emailSent, photos: photos.length, auto: true,
  });
  return { ok: true, email_sent: emailSent, version, sent_at: sentAt };
}

async function sendOwnerEmail(subject: string, text: string): Promise<boolean> {
  const key = process.env["RESEND_API_KEY"];
  if (!key) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [OWNER_EMAIL], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  try {
    if (req.method === "GET") {
      const ct = typeof req.query?.["ct"] === "string" ? (req.query["ct"] as string) : "";
      const resolved = await resolveVisit(ct);
      if ("error" in resolved) return json(resolved.status, { ok: false, error: resolved.error });
      // Link-open tracking for the owner panel ("did the cleaner open
      // it?"). Throttled to one event per 6 hours per visit; the owner's
      // own preview carries pv=1 and never counts.
      if (req.query?.["pv"] !== "1") {
        try {
          const prior = await dbSelect<{ created_at: string }>(
            "gh_events",
            `visit_id=eq.${resolved.visit.id}&event=eq.cleaner_link_opened&order=created_at.desc&limit=1`,
          );
          const last = prior[0] ? Date.parse(prior[0].created_at) : 0;
          if (!last || Date.now() - last > 6 * 3600 * 1000) {
            await logEvent(resolved.visit.id, resolved.visit.booking_id, "cleaner", "cleaner_link_opened", {});
          }
        } catch { /* tracking is best-effort */ }
      }
      return json(200, await view(resolved.visit));
    }
    if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ct = typeof body["ct"] === "string" ? (body["ct"] as string) : "";
    const action = typeof body["action"] === "string" ? (body["action"] as string) : "";
    const resolved = await resolveVisit(ct);
    if ("error" in resolved) return json(resolved.status, { ok: false, error: resolved.error });
    const visit = resolved.visit;

    // Pipeline gate: no ordinary work on an unconfirmed or cancelled
    // booking. Starting work (checklist/photos) and finishing it (submit)
    // both require the owner's confirmation first — otherwise the client
    // page ends up showing "awaiting confirmation" and "cleaning
    // complete" at the same time. Cancelled bookings never reach here
    // with a live link, but the status check keeps the gate explicit.
    if (visit.status === "cancelled" || !(await visitConfirmed(visit.id))) {
      return json(409, { ok: false, error: "visit_not_confirmed" });
    }

    if (!EDITABLE.has(visit.report_status) && action !== "submit") {
      return json(409, { ok: false, error: "report_locked", report_status: visit.report_status });
    }

    if (action === "checklist") {
      const checklist = sanitizeChecklist(body["checklist"]);
      if (!checklist) return json(400, { ok: false, error: "invalid_checklist" });
      // Keep the server-stamped submission time out of cleaner control.
      if (visit.checklist?.submitted_at) checklist.submitted_at = visit.checklist.submitted_at;
      const ok = await dbUpdate("gh_visits", `id=eq.${visit.id}`, {
        checklist,
        report_status: visit.report_status === "none" ? "draft" : visit.report_status,
      });
      if (!ok) return json(502, { ok: false, error: "db_error" });
      return json(200, { ok: true });
    }

    if (action === "photo_sign") {
      const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
      const kind = body["kind"] === "before" ? "before" : "after";
      const rooms = (visit.checklist?.rooms ?? []).map((r) => r.name);
      if (!room || (!rooms.includes(room) && room !== "Other areas")) {
        return json(400, { ok: false, error: "invalid_room" });
      }
      const objectPath = `visits/${visit.id}/${roomSlug(room)}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.jpg`;
      const signed = await storageSignUpload(objectPath);
      if (!signed) return json(502, { ok: false, error: "storage_error" });
      return json(200, { ok: true, upload_url: signed.signedUrl, storage_path: objectPath, kind });
    }

    if (action === "photo_register") {
      const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
      const kind = body["kind"] === "before" ? "before" : "after";
      const storagePath = typeof body["storage_path"] === "string" ? (body["storage_path"] as string) : "";
      if (!room || !storagePath.startsWith(`visits/${visit.id}/`)) {
        return json(400, { ok: false, error: "invalid_photo" });
      }
      // Server-side validation of the uploaded bytes (type + size): the
      // client uploads straight to Storage, so this is the first point
      // the server sees the file. Anything else is removed again.
      const info = await storageObjectInfo(storagePath);
      if (!info) return json(502, { ok: false, error: "storage_error" });
      if (!ALLOWED_PHOTO_TYPES.includes(info.contentType) || info.size <= 0 || info.size > MAX_PHOTO_BYTES) {
        await storageRemove(storagePath);
        return json(400, { ok: false, error: "invalid_photo_file" });
      }
      const existing = await photosOf(visit.id);
      if (existing.some((p) => p.storage_path === storagePath)) {
        return json(200, { ok: true, already: true });
      }
      if (existing.length >= 60) return json(400, { ok: false, error: "too_many_photos" });
      const note = typeof body["note"] === "string" ? (body["note"] as string).slice(0, 300) : null;
      const row = await dbInsert<PhotoRow>("gh_photos", {
        visit_id: visit.id,
        room,
        storage_path: storagePath,
        kind,
        note,
      });
      if (!row) return json(502, { ok: false, error: "db_error" });
      return json(200, { ok: true, photo_id: row.id });
    }

    if (action === "photo_delete") {
      const photoId = typeof body["photo_id"] === "string" ? (body["photo_id"] as string) : "";
      const photos = await photosOf(visit.id);
      const target = photos.find((p) => p.id === photoId);
      if (!target) return json(404, { ok: false, error: "photo_not_found" });
      await dbDelete("gh_photos", `id=eq.${target.id}&visit_id=eq.${visit.id}`);
      await storageRemove(target.storage_path);
      return json(200, { ok: true });
    }

    if (action === "submit") {
      if (visit.report_status === "submitted") {
        return json(200, { ok: true, already: true });
      }
      if (!EDITABLE.has(visit.report_status)) {
        return json(409, { ok: false, error: "report_locked", report_status: visit.report_status });
      }
      const checklist = sanitizeChecklist(body["checklist"]) ?? visit.checklist;
      const photos = await photosOf(visit.id);
      const missing = missingRooms(checklist, photos);
      if (missing.length > 0) {
        return json(400, { ok: false, error: "rooms_incomplete", missing });
      }
      checklist.submitted_at = new Date().toISOString();
      const ok = await dbUpdate("gh_visits", `id=eq.${visit.id}`, {
        checklist,
        report_status: "submitted",
        status: "report_submitted",
      });
      if (!ok) return json(502, { ok: false, error: "db_error" });
      await logEvent(visit.id, visit.booking_id, "cleaner", "report_submitted", {
        photos: photos.length,
        problem_note: checklist.problem_note ?? null,
      });
      // Auto-publish: the finished report goes straight to the client —
      // no mandatory owner step between the cleaner's finish and the
      // client's report. Exceptions stay with the owner: an open issue
      // holds the report in the review queue, and a failed publish falls
      // back to the same queue instead of starting an invisible clock.
      const held = visit.issue_open === true;
      if (held) {
        const emailed = await sendOwnerEmail(
          `Report ready for review — ${visit.client_name ?? "client"}, ${visit.visit_date ?? ""}`,
          `The cleaner submitted the photo report, but it is HELD for review: an issue is open on this visit.\n\nClient: ${visit.client_name ?? ""}\nDate: ${visit.visit_date ?? ""}\nPhotos: ${photos.length}\nCleaner note: ${checklist.problem_note ?? "—"}\n\nOpen the owner view to resolve the issue and send the report.`,
        );
        if (!emailed) {
          await logEvent(visit.id, visit.booking_id, "system", "owner_email_failed", {
            what: "report_submitted",
          });
        }
        return json(200, { ok: true, published: false, held: true });
      }
      const published = await publishReportToClient(visit, photos);
      if (!published.ok) {
        await logEvent(visit.id, visit.booking_id, "system", "report_publish_failed", {
          error: published.error,
        });
        const emailed = await sendOwnerEmail(
          `Report ready for review — ${visit.client_name ?? "client"}, ${visit.visit_date ?? ""}`,
          `The cleaner submitted the photo report, but automatic publishing failed (${published.error}). The report is waiting in the owner review queue — publish it from the owner panel.\n\nClient: ${visit.client_name ?? ""}\nDate: ${visit.visit_date ?? ""}\nPhotos: ${photos.length}\nCleaner note: ${checklist.problem_note ?? "—"}`,
        );
        if (!emailed) {
          await logEvent(visit.id, visit.booking_id, "system", "owner_email_failed", {
            what: "report_submitted",
          });
        }
        return json(200, { ok: true, published: false, publish_error: published.error });
      }
      const emailed = await sendOwnerEmail(
        `Report published to client — ${visit.client_name ?? "client"}, ${visit.visit_date ?? ""}`,
        `The cleaner finished the visit and the photo report went straight to the client — no action needed.\n\nClient: ${visit.client_name ?? ""}\nDate: ${visit.visit_date ?? ""}\nPhotos: ${photos.length}\nCleaner note: ${checklist.problem_note ?? "—"}\nReport email to the client: ${published.email_sent ? "sent" : "FAILED — the 24h clock is blocked; re-send it from the owner panel."}\n\nOpen the owner view to see the report and its notification status.`,
      );
      if (!emailed) {
        await logEvent(visit.id, visit.booking_id, "system", "owner_email_failed", {
          what: "report_published",
        });
      }
      return json(200, { ok: true, published: true, email_sent: published.email_sent });
    }

    return json(400, { ok: false, error: "invalid_action" });
  } catch (err) {
    console.error(JSON.stringify({ requestId, step: "cleaner", error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: "server_error" });
  }
}
