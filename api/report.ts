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
import { dbConfigured, dbSelect, dbSelectStrict, dbInsert, dbUpdate, logEvent, storageSignDownload, storagePut } from "./_db.js";
import { sendReceiptEmailOnce, sendPaymentFailedEmailOnce } from "./booking-action.js";
import { clientApprovedEvent, issueStateFrom } from "./_payment_basis.js";
import { reconcileIntent, confirmIntent, confirmAttemptKey } from "./_payment_intent.js";
import { chargeVisit } from "./_payment_obligation.js";

// Booking-scoped truth: the Stripe customer is shared by every booking of
// one email, so its metadata may describe a different booking. gh_visits
// (pinned at submission) and gh_events (per-booking journal) win for any
// booking the customer is not currently bound to.
type ChecklistItem = { label: string; done: boolean };
type ChecklistRoom = { name: string; items: ChecklistItem[]; skip_reason?: string };
type Checklist = { rooms: ChecklistRoom[]; problem_note?: string; submitted_at?: string };
type BookingRow = {
  id: string; booking_id: string; status: string | null;
  amount_cents: number | null; report_sent_at: string | null;
  report_status: string | null; receipt_email_id?: string | null;
  report_bounced: boolean | null; cleaner_name: string | null;
  issue_open?: boolean | null; issue_ever?: boolean | null;
  checklist?: Checklist | null;
};
type BookingEvent = { event: string; detail: Record<string, unknown> | null; created_at: string };
// RA04: strict loaders that tell "no row" apart from "the DB could
// not be read". A state-changing POST must fail closed on a read
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
function issueOpenFrom(events: BookingEvent[]): boolean {
  const opened = latestEvent(events, "issue_opened");
  if (!opened) return false;
  const resolved = latestEvent(events, "issue_resolved");
  return !resolved || resolved.created_at < opened.created_at;
}
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
function buildEffectiveMeta(row: BookingRow, events: BookingEvent[]): Record<string, string> {
  const confirmEv = latestEvent(events, "visit_confirmed");
  const opened = latestEvent(events, "issue_opened");
  const resolved = latestEvent(events, "issue_resolved");
  // An operator approval is not client consent (G3): it must not surface
  // as an approved report here either. P01: a superseded approval (a newer
  // report was published after it) is not consent for the new report.
  const approvedEv = clientApprovedEvent(events);
  const cancelledEv = latestEvent(events, "visit_cancelled");
  const issueOpen = issueOpenFrom(events);
  // M5: a failed approve-charge must survive a page reload. Without this,
  // the journal's payment_failed was invisible here and the customer saw
  // "approved — payment is being completed" with no retry path.
  const failedEv = latestEvent(events, "payment_failed");
  const succeededEv = latestEvent(events, "payment_succeeded");
  const paymentFailed = Boolean(
    failedEv && (!succeededEv || succeededEv.created_at < failedEv.created_at),
  );
  return {
    gh_state: row.status === "paid" ? "paid"
      : cancelledEv ? "cancelled"
      : issueOpen ? "issue_open"
      : paymentFailed ? "payment_failed"
      : approvedEv ? "approved" : "",
    gh_report_sent_at: row.report_sent_at ?? "",
    gh_report_amount_cents: row.amount_cents != null ? String(row.amount_cents) : "",
    gh_first_price_cents: row.amount_cents != null ? String(row.amount_cents) : "",
    gh_report_bounced: row.report_bounced ? "1" : "",
    gh_rp_source: row.report_sent_at ? "db" : "",
    gh_confirmed_date: evStr(confirmEv, "date"),
    gh_issue_open: issueOpen ? "1" : "",
    gh_issue_reason: issueOpen ? evStr(opened, "reason") : "",
    gh_issue_room: issueOpen ? evStr(opened, "room") : "",
    gh_issue_resolved_at: resolved && !issueOpen ? resolved.created_at : "",
    gh_reclean_date: resolved && !issueOpen ? evStr(resolved, "reclean_date") : "",
  };
}
async function hydrateCustomerMeta(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string> },
  row: BookingRow,
  events: BookingEvent[],
): Promise<void> {
  const eff = buildEffectiveMeta(row, events);
  const params: Record<string, string> = { "metadata[gh_booking_id]": row.booking_id };
  for (const [k, v] of Object.entries(eff)) params[`metadata[${k}]`] = v;
  params["metadata[gh_booking_confirmed]"] = eff["gh_confirmed_date"] ? "1" : "";
  params["metadata[gh_cleaner_name]"] = row.cleaner_name ?? "";
  await stripePost(secretKey, `/customers/${customer.id}`, params);
  for (const [k, v] of Object.entries(eff)) customer.metadata[k] = v;
  customer.metadata["gh_booking_id"] = row.booking_id;
  customer.metadata["gh_booking_confirmed"] = params["metadata[gh_booking_confirmed]"];
  customer.metadata["gh_cleaner_name"] = row.cleaner_name ?? "";
}

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
): { ok: boolean; payload: BookingPayload | null; reason?: string } {
  let payload: BookingPayload | null = null;
  let ttl = TOKEN_TTL_SECONDS;
  if (token.startsWith("v2.")) {
    payload = decryptBookingPayload(secret, token);
    if (!payload) return { ok: false, payload: null, reason: "bad_token" };
    ttl = TOKEN_TTL_V2_SECONDS;
  } else {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, payload: null, reason: "bad_format" };
    }
    const [payloadB64, sig] = parts;
    let expected: string;
    try {
      expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    } catch {
      return { ok: false, payload: null, reason: "sign_error" };
    }
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, payload: null, reason: "bad_signature" };
    }
    try {
      payload = JSON.parse(b64urlDecode(payloadB64)) as BookingPayload;
    } catch {
      return { ok: false, payload: null, reason: "bad_payload" };
    }
  }
  if (!payload.bid || !payload.email || !payload.ts) {
    return { ok: false, payload: null, reason: "missing_fields" };
  }
  const age = Math.floor(Date.now() / 1000) - payload.ts;
  if (age < 0 || age > ttl) {
    return { ok: false, payload: null, reason: "expired" };
  }
  return { ok: true, payload };
}

function verifyBookingLink(
  stripeKey: string,
  token: string,
): { ok: boolean; payload: BookingPayload | null; reason?: string } {
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

// The saved-card webhook can miss (its secret is an owner action), so a
// missing gh_payment_method must not block a charge Stripe can actually
// make: read the customer's cards from Stripe and backfill the cache.
async function reconcilePaymentMethod(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string> },
  meta: Record<string, string>,
): Promise<string> {
  const existing = meta["gh_payment_method"] ?? "";
  if (existing) return existing;
  const res = await stripeGet(
    secretKey,
    `/customers/${encodeURIComponent(customer.id)}/payment_methods?${new URLSearchParams({ type: "card", limit: "1" })}`,
  );
  if (!res.ok) return "";
  const list = (res.data["data"] as Array<{ id: string }> | undefined) ?? [];
  const pm = list[0]?.id ?? "";
  if (!pm) return "";
  await stripePost(secretKey, `/customers/${customer.id}`, { "metadata[gh_payment_method]": pm });
  customer.metadata["gh_payment_method"] = pm;
  meta["gh_payment_method"] = pm;
  return pm;
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

export type PhotoItem = { url: string; room?: string; note?: string; kind?: string };

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
    let seenPublicationId = "";
    if (req.method === "GET") {
      bt = q((req.query ?? {})["bt"]);
    } else {
      const body = (req.body ?? {}) as Record<string, unknown>;
      bt = typeof body["bt"] === "string" ? body["bt"] : "";
      action = typeof body["action"] === "string" ? body["action"] : "";
      reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 500) : "";
      room = typeof body["room"] === "string" ? body["room"].slice(0, 60) : "";
      seenPublicationId = typeof body["seen_publication_id"] === "string" ? body["seen_publication_id"] : "";
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
    const boundCustomer = await findCustomerByBooking(STRIPE_SECRET_KEY, payload.bid);
    const rowRes = await latestBookingRowStrict(payload.bid);
    if (!rowRes.ok && req.method === "POST") {
      res.status(502).json({ requestId, ok: false, error: "db_unreadable" });
      return;
    }
    const row = rowRes.row;
    let events: BookingEvent[] = [];
    if (row) {
      const evRes = await bookingEventsStrict(payload.bid);
      if (!evRes.ok && req.method === "POST") {
        res.status(502).json({ requestId, ok: false, error: "db_unreadable" });
        return;
      }
      events = evRes.events;
    }
    let customer = boundCustomer;
    if (!customer && payload.email) {
      const found = await findCustomerByEmail(STRIPE_SECRET_KEY, payload.email);
      // Normalize: the token's own email/name are the verified fallback
      // for a customer record without them.
      if (found) {
        customer = {
          id: found.id, metadata: found.metadata,
          email: found.email ?? payload.email, name: found.name ?? payload.name ?? "",
        };
      }
    }
    const bound = Boolean(boundCustomer);

    const payloadBooking: Record<string, string> = {};
    if (payload.service) payloadBooking.service = payload.service;
    if (payload.date) payloadBooking.date = payload.date;
    if (payload.first) payloadBooking.first = payload.first;

    if (!customer && !row) {
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
    if (!customer) {
      customer = { id: "", metadata: {}, email: payload.email, name: payload.name };
    }
    if (req.method === "POST" && !customer.id) {
      res.status(404).json({ requestId, ok: false, error: "booking_not_found" });
      return;
    }
    // Before a WRITE on an unbound booking, sync the shared customer's
    // metadata to this booking's own state (another booking may be bound).
    if (req.method === "POST" && row && !bound) {
      try {
        await hydrateCustomerMeta(STRIPE_SECRET_KEY, customer, row, events);
      } catch {
        /* the action handlers re-check state before writing */
      }
    }

    const meta = row
      ? { ...customer.metadata, ...buildEffectiveMeta(row, events) }
      : customer.metadata;
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
          const rows = await dbSelect<{ room: string; storage_path: string; note: string | null; kind: string }>(
            "gh_photos",
            `visit_id=eq.${vid}&order=created_at.asc&limit=60`,
          );
          const items: PhotoItem[] = [];
          for (const r of rows) {
            if (r.kind === "client") continue; // customer-submitted photos are not part of the report
            const url = await storageSignDownload(r.storage_path, 24 * 3600);
            if (url) {
              items.push({
                url,
                room: r.room,
                kind: r.kind === "before" ? "before" : "after",
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

    // U02: the timer display predicate must match the charge gate — a
    // resolved dispute still blocks the timer forever (issue_ever), as
    // does a bounced report. Otherwise the page shows a countdown for a
    // charge that can never happen.
    const timerIssue = issueStateFrom(events, row?.issue_open ?? null, row?.issue_ever ?? null);
    const timerBounced = (row?.report_bounced ?? false) || meta["gh_report_bounced"] === "1";
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
        // V3: the auto-charge timer's real eligibility, identical on
        // /visit and /report. The deadline warning must render only
        // when the timer actually runs: an open issue, a resolved
        // dispute (ever) or a bounced report blocks it, and "sent"
        // never means delivered or read.
        charge_timer_blocked: timerIssue.open || timerIssue.ever || timerBounced,
        charge_timer_block_reason: timerIssue.open ? "issue_open" : (timerBounced ? "bounced" : (timerIssue.ever ? "issue_ever" : null)),
        // RA19: with a visit row, receipt and post-payment-issue flags
        // come ONLY from this visit (row + its journal). Shared
        // customer metadata may carry another booking's flags — a null
        // row marker must never fall back to another visit's marker.
        receipt_sent: row ? Boolean(row.receipt_email_id) : Boolean(meta["gh_receipt_email_id"]),
        postpay_issue: row
          ? events.some((e) => e.event === "postpay_issue")
          : meta["gh_postpay_issue"] === "1",
        // RA08: the publication the client is looking at. Approve must
        // send this id back; a stale tab (older publication) never pays
        // for a newer report.
        publication_id: row?.report_sent_at ?? meta["gh_report_sent_at"] ?? null,
        report_version: (() => {
          const sentEv = events.find((e) => e.event === "report_sent");
          return typeof sentEv?.detail?.["version"] === "number"
            ? (sentEv.detail["version"] as number)
            : (parseInt(meta["gh_report_version"] ?? "", 10) || 1);
        })(),
        // A paid visit with an open issue shows both facts: the money
        // moved AND the complaint is still open (RA07 honest state).
        paid: row?.status === "paid" || meta["gh_state"] === "paid",
        issue_reason: meta["gh_issue_open"] === "1" ? meta["gh_issue_reason"] ?? "" : "",
        issue_room: meta["gh_issue_open"] === "1" ? meta["gh_issue_room"] ?? "" : "",
        // §10/§11: the cleaner's completed checklist travels with the
        // report — the client sees what was actually done, room by room.
        checklist: row?.checklist ?? null,
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
      // P09: the post-payment dedupe is per-booking (journal event), never
      // shared customer metadata — another booking's complaint must not
      // suppress this booking's complaint. The metadata flag remains
      // only as the legacy fallback when no journal exists at all.
      if (events.some((e) => e.event === "postpay_issue") || (!dbConfigured() && meta["gh_postpay_issue"] === "1")) {
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
      // P06: only a CURRENT published report can be approved and paid.
      // A cancelled visit never charges; a returned (or merely
      // submitted, unpublished) report is not a fresh publication.
      // Events are newest-first, so a report_returned BEFORE the latest
      // report_sent in this list is NEWER than that publication.
      const sentIdx = events.findIndex((e) => e.event === "report_sent");
      const returnedIdx = events.findIndex((e) => e.event === "report_returned");
      const returnedAfterSent = sentIdx >= 0 && returnedIdx >= 0 && returnedIdx < sentIdx;
      if (row && row.status === "cancelled") {
        res.status(409).json({ requestId, ok: false, error: "visit_not_chargeable" });
        return;
      }
      if (row && ((row.report_status != null && row.report_status !== "sent") || returnedAfterSent)) {
        res.status(409).json({ requestId, ok: false, error: "report_not_current" });
        return;
      }
      // RA08: the client pays for the publication they actually saw.
      // A stale tab (older publication id, or none at all) gets the
      // fresh report and must approve again — it never pays for a
      // report published after the tab loaded.
      const currentPublication = row?.report_sent_at ?? meta["gh_report_sent_at"] ?? null;
      if (currentPublication) {
        if (!seenPublicationId || seenPublicationId !== currentPublication) {
          res.status(409).json({ ...view(), error: "report_changed" });
          return;
        }
      }
      // Terms 5.2: the card is charged WHEN the client approves the
      // report. Approval is recorded first (it is a fact even if the
      // payment then fails), then the pinned amount is charged at once.
      // An operator approval does not count as the client's: a client
      // press after one must still log a genuine client approval (G3).
      // P01/RA09: an approval superseded by a newer publication, or
      // voided by a later dispute, is not consent for this charge.
      const approvalLogged = Boolean(clientApprovedEvent(events));
      if (!approvalLogged) {
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
        if (row) {
          await logEvent(row.id, payload.bid, "client", "report_approved", {});
          await dbUpdate("gh_visits", `id=eq.${row.id}`, { issue_open: false });
        }
      }
      const paymentMethod = await reconcilePaymentMethod(STRIPE_SECRET_KEY, customer, meta);
      if (!paymentMethod) {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_state]": "payment_failed",
        });
        meta["gh_state"] = "payment_failed";
        if (row) await logEvent(row.id, payload.bid, "system", "payment_failed", { reason: "no_payment_method" });
        await sendPaymentFailedEmailOnce(STRIPE_SECRET_KEY, customer.id, payload.bid, row?.id ?? null);
        res.status(402).json({ ...view(), error: "no_payment_method" });
        return;
      }
      // Row-backed bookings charge through the single shared flow
      // (RA01-RA13): pinned amount, journal version, atomic claim,
      // reconcile-before-create, verified paid write.
      if (row) {
        const outcome = await chargeVisit({
          secretKey: STRIPE_SECRET_KEY,
          bookingId: payload.bid,
          customerId: customer.id,
          customerEmail: customer.email || null,
          paymentMethod,
          source: "client_approve",
          allowedBases: ["client_approved"],
          seenPublicationId: seenPublicationId || null,
          nowMs: Date.now(),
          deps: {
            setCustomerMeta: async (patch) => {
              const params: Record<string, string> = {};
              for (const [k, v] of Object.entries(patch)) params[`metadata[${k}]`] = v;
              await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, params);
              Object.assign(meta, patch);
            },
            sendReceipt: (amountCents) => sendReceiptEmailOnce(
              STRIPE_SECRET_KEY, customer.id,
              { ...meta, gh_report_amount_cents: String(amountCents) },
              payload.bid,
            ),
            sendPaymentFailedEmail: async (visitId) => {
              await sendPaymentFailedEmailOnce(
                STRIPE_SECRET_KEY, customer.id, payload.bid, visitId,
              );
            },
          },
        });
        if (outcome.outcome === "paid") {
          Object.assign(meta, { gh_state: "paid", gh_last_payment: outcome.payment_intent });
          if (outcome.receipt_sent) {
            meta["gh_receipt_email_id"] = meta["gh_receipt_email_id"] || "sent";
            row.receipt_email_id = row.receipt_email_id ?? "sent";
          }
          res.status(200).json(view());
          return;
        }
        if (outcome.outcome === "blocked") {
          res.status(409).json({ ...view(), error: outcome.error });
          return;
        }
        if (outcome.outcome === "processing") {
          res.status(409).json({ ...view(), error: "payment_processing" });
          return;
        }
        if (outcome.outcome === "mismatch") {
          res.status(409).json({ ...view(), error: "payment_intent_mismatch" });
          return;
        }
        if (outcome.outcome === "failed") {
          meta["gh_state"] = "payment_failed";
          res.status(402).json({
            ...view(),
            error: outcome.error === "payment_requires_action" ? "payment_requires_action" : "payment_failed",
          });
          return;
        }
        res.status(502).json({ ...view(), error: outcome.error });
        return;
      }
      // Legacy path (no visit row): the old metadata-gated charge, with
      // RA03/RA02 hardening — a failed search never means "no payment",
      // and a found intent is verified before it is confirmed.
      const amountCents = (parseInt(meta["gh_report_amount_cents"] ?? "", 10) || parseInt(meta["gh_first_price_cents"] ?? "", 10) || NaN);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        logErr("approve_charge", "blocked: no pinned amount");
        res.status(409).json({ requestId, ok: false, error: "quote_missing" });
        return;
      }
      const reportVersion = sentIdx >= 0 && typeof events[sentIdx]?.detail?.["version"] === "number"
        ? String(events[sentIdx].detail["version"] as number)
        : (meta["gh_report_version"] ?? "1");
      const idemKey = `charge_${payload.bid}_v${reportVersion}`;
      const rec = await reconcileIntent(STRIPE_SECRET_KEY, payload.bid, [], {
        amountCents, currency: "usd", customerId: customer.id,
      });
      if (rec.state === "unknown") {
        res.status(502).json({ ...view(), error: "payment_unknown" });
        return;
      }
      if (rec.state === "mismatch") {
        res.status(409).json({ ...view(), error: "payment_intent_mismatch" });
        return;
      }
      if (rec.state === "succeeded") {
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_state]": "paid",
          "metadata[gh_paid_at]": new Date().toISOString(),
          "metadata[gh_last_payment]": rec.intent.id,
        });
        Object.assign(meta, { gh_state: "paid", gh_last_payment: rec.intent.id });
        const adoptedReceipt = await sendReceiptEmailOnce(
          STRIPE_SECRET_KEY, customer.id,
          { ...meta, gh_report_amount_cents: String(amountCents) },
          payload.bid,
        );
        if (adoptedReceipt) meta["gh_receipt_email_id"] = meta["gh_receipt_email_id"] || "sent";
        res.status(200).json(view());
        return;
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "payment_pending",
        "metadata[gh_report_version]": reportVersion,
      });
      meta["gh_state"] = "payment_pending";
      if (rec.state === "live" && rec.intent.status === "processing") {
        res.status(409).json({ ...view(), error: "payment_processing" });
        return;
      }
      // Legacy confirm key: no journal exists to number attempts, so
      // the key is derived from the payment method itself — a new card
      // gets a new key (no idempotency clash), the same card replays.
      const legacyConfirmKey = rec.state === "live"
        ? `${idemKey}_confirm_${createHash("sha256").update(paymentMethod).digest("hex").slice(0, 12)}`
        : idemKey;
      const pi = rec.state === "live"
        ? await confirmIntent(STRIPE_SECRET_KEY, rec.intent.id, paymentMethod, legacyConfirmKey)
        : await stripePost(
        STRIPE_SECRET_KEY,
        "/payment_intents",
        {
          amount: String(amountCents),
          currency: "usd",
          customer: customer.id,
          payment_method: paymentMethod,
          off_session: "true",
          confirm: "true",
          description: `Gatehouse cleaning — booking ${payload.bid}`,
          "metadata[gh_booking_id]": payload.bid,
          "metadata[gh_report_version]": reportVersion,
        },
        idemKey,
      );
      if (pi.ok && pi.data["status"] === "succeeded") {
        const piId = String(pi.data["id"] ?? "");
        await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
          "metadata[gh_state]": "paid",
          "metadata[gh_paid_at]": new Date().toISOString(),
          "metadata[gh_last_payment]": piId,
        });
        Object.assign(meta, { gh_state: "paid", gh_last_payment: piId });
        const receiptSent = await sendReceiptEmailOnce(
          STRIPE_SECRET_KEY, customer.id,
          { ...meta, gh_report_amount_cents: String(amountCents) },
          payload.bid,
        );
        if (receiptSent) meta["gh_receipt_email_id"] = meta["gh_receipt_email_id"] || "sent";
        res.status(200).json(view());
        return;
      }
      const piStatus = String(pi.data["status"] ?? "failed");
      const errMsg =
        ((pi.data["error"] as { message?: string } | undefined)?.message ?? `payment ${piStatus}`);
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "payment_failed",
      });
      meta["gh_state"] = "payment_failed";
      await sendPaymentFailedEmailOnce(STRIPE_SECRET_KEY, customer.id, payload.bid, row?.id ?? null);
      logErr("approve_charge", `${payload.bid}: ${errMsg}`);
      res.status(402).json({
        ...view(),
        error: piStatus === "requires_action" ? "payment_requires_action" : "payment_failed",
      });
      return;
    }

    // action === "issue"
    if (state === "issue_open") {
      res.status(200).json({ ...view(), already: true });
      return;
    }
    // RA07: if a charge is already in flight, the issue is still
    // recorded (it blocks every FUTURE charge and stays open), but the
    // client must not be promised a pause of a payment that may
    // already complete. The response and emails say so honestly.
    const paymentInFlight =
      meta["gh_state"] === "payment_pending" || row?.status === "payment_pending";
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
    if (row) {
      await logEvent(row.id, payload.bid, "client", "issue_opened", {
        reason: reason.slice(0, 200), room: room.slice(0, 60),
      });
      // The visit row's issue flag is what the automatic-charge cron
      // reads for database visits — keep it in sync with the metadata.
      await dbUpdate("gh_visits", `id=eq.${row.id}`, { issue_open: true, issue_ever: true });
      // Persist the customer's own photo on the visit (it is also emailed
      // to the owner below) so it stays visible in the owner review
      // instead of living only in an email attachment.
      if (photoB64) {
        try {
          const bytes = Buffer.from(photoB64, "base64");
          if (bytes.length > 0 && bytes.length <= 15 * 1024 * 1024) {
            const path = `visits/${row.id}/client-issue/${Date.now()}.jpg`;
            if (await storagePut(path, bytes, "image/jpeg")) {
              const inserted = await dbInsert("gh_photos", {
                visit_id: row.id,
                room: room || "Client photo",
                storage_path: path,
                kind: "client",
                note: reason.slice(0, 300) || null,
              });
              await logEvent(row.id, payload.bid, "system",
                inserted ? "client_photo_stored" : "client_photo_store_failed", {});
            } else {
              await logEvent(row.id, payload.bid, "system", "client_photo_store_failed", {});
            }
          }
        } catch {
          /* the emailed copy still reaches the owner */
        }
      }
    }

    // Best-effort notifications — the issue is already recorded on the
    // server at this point; an email failure changes nothing for the
    // client. The subject must not promise a pause when a payment was
    // already in flight: that charge may still complete, and the
    // issue then becomes a re-clean-or-refund case, not a block.
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
          `A client reported an issue from the photo report.${paymentInFlight ? " A payment was already in progress when the issue arrived, so it may still complete — the issue stays open either way; review it for a re-clean or a refund." : " The charge is PAUSED."}\n\n` +
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
          subject: paymentInFlight
            ? "We received your report — a payment was already in progress"
            : "We received your report — the charge is paused",
          text:
            `Hi ${firstName},\n\nIssue received.${paymentInFlight ? " A payment was already in progress when your report arrived, so it may still complete — we will review it right away and make it right (a re-clean or a refund) if the visit wasn't right." : " The charge is paused — nothing will be charged while we look into it."}\n` +
            `We'll reply within one business day.\n\n` +
            (room ? `Room: ${room}\n` : "") +
            (reason ? `What you told us: ${reason}\n\n` : "\n") +
            `You can check the status any time on your report page — the same link as before.\n\nNick\n\nGatehouse Home Cleaning\n`,
        });
      }
    }
    res.status(200).json(paymentInFlight ? { ...view(), payment_in_flight: true } : view());
  } catch (error: unknown) {
    console.error(JSON.stringify({
      requestId, step: "unexpected",
      error: error instanceof Error ? error.message : String(error),
    }));
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
