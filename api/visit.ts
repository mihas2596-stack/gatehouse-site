// /api/visit — the client's "Manage your visit" page backend.
//
// Authenticated by the same signed booking token (bt) as /api/report.
// GET returns everything the page needs: lifecycle state in plain terms,
// prices, the assigned cleaner, alternative dates when the requested
// date was declined, and the exact cancellation fee the server would
// apply RIGHT NOW (free up to 48 hours before the visit, $25 after —
// Terms). POST actions:
//   accept_alt_date {date}  — pick one of the operator's alternatives
//   propose_date {date}     — suggest a different date (back to pending)
//   cancel {scope}          — scope "once" | "stop": cancel this visit,
//                             or this visit and all future recurring ones.
//                             The fee is recomputed on the server at
//                             cancel time; the client confirmed it on
//                             the page after seeing the same number.
//   update_access {notes?, no_photo_zones?} — entry instructions and
//                             rooms not to photograph.
// Nothing here charges the client: a recorded late-cancel fee is
// collected later by the operator (booking-action charge_fee).

import { createHmac, timingSafeEqual, createDecipheriv, createHash } from "crypto";
import { dbConfigured, dbSelect, dbUpdate, logEvent } from "./_db.js";

// Booking-scoped truth: the Stripe customer is shared by every booking of
// one email, so its metadata may describe a different booking. gh_visits
// (pinned at submission) and gh_events (per-booking journal) win for any
// booking the customer is not currently bound to.
type BookingRow = {
  id: string; booking_id: string; status: string | null;
  amount_cents: number | null; cleaner_name: string | null;
  report_sent_at: string | null; report_bounced: boolean | null;
  access_notes: string | null; no_photo_zones: string | null;
  report_status?: string | null;
  cleaner_profile?: unknown;
};

/** Cleaner photo from the per-visit profile (v2): the row is the truth,
 * because shared Stripe metadata is overwritten by other bookings. */
function rowCleanerPhoto(row: BookingRow | null): string {
  const raw = row?.cleaner_profile;
  if (raw && typeof raw === "object") {
    const photo = (raw as Record<string, unknown>)["photo"];
    return typeof photo === "string" ? photo : "";
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const photo = (parsed as Record<string, unknown>)["photo"];
        return typeof photo === "string" ? photo : "";
      }
    } catch { /* fall through */ }
  }
  return "";
}
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
// Confirmation deadline promised to the customer: 6:00 PM Atlanta time on
// the next business day (Mon-Fri). Mirrors confirmDeadlineLabel in
// send-contact-email.ts so every surface quotes the same moment.
function confirmDeadlineLabel(from = new Date()): string {
  const tz = "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(from);
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  const y = get("year"), m = get("month"), d = get("day");
  for (let i = 1; i <= 7; i++) {
    const probe = new Date(Date.UTC(y, m - 1, d + i, 12));
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(probe);
    if (wd === "Sat" || wd === "Sun") continue;
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long", month: "long", day: "numeric",
    }).format(probe);
    return `${label} at 6:00 PM ET`;
  }
  return "the end of the next business day";
}

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
// Rebuild the metadata view of THIS booking from its DB row + journal.
function buildEffectiveMeta(row: BookingRow, events: BookingEvent[], hasCard: boolean, tokenRecurring?: string): Record<string, string> {
  const confirmEv = latestEvent(events, "visit_confirmed");
  const proposedEv = latestEvent(events, "date_proposed");
  const cancelledEv = latestEvent(events, "visit_cancelled");
  const approvedEv = latestEvent(events, "report_approved");
  const issueOpen = issueOpenFrom(events);
  // M5: surface a failed charge after reload, like api/report.ts.
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
      : approvedEv ? "approved"
      : row.report_sent_at ? ""
      : hasCard ? "card_ready" : "",
    gh_report_sent_at: row.report_sent_at ?? "",
    gh_first_price_cents: row.amount_cents != null ? String(row.amount_cents) : "",
    gh_recurring_price_cents: tokenRecurring && Number.isFinite(parseFloat(tokenRecurring))
      ? String(Math.round(parseFloat(tokenRecurring) * 100)) : "",
    gh_confirmed_date: evStr(confirmEv, "date"),
    gh_confirmed_window: evStr(confirmEv, "window"),
    gh_cleaner_name: row.cleaner_name ?? "",
    // The row's own profile photo: metadata alone is shared across the
    // customer's bookings and used to be wiped to "" on every hydrate.
    gh_cleaner_photo: rowCleanerPhoto(row),
    gh_alt_dates: evStr(proposedEv, "alt_dates"),
    gh_proposed_date: evStr(proposedEv, "date"),
    gh_cancel_scope: evStr(cancelledEv, "scope"),
    gh_access_notes: row.access_notes ?? "",
    gh_no_photo_zones: row.no_photo_zones ?? "",
    gh_payment_method: hasCard ? "1" : "",
    gh_issue_open: issueOpen ? "1" : "",
  };
}
// Write this booking's DB/journal state into the shared customer's
// metadata before an action runs against it, so no field of another
// booking leaks into this booking's writes.
async function hydrateCustomerMeta(
  secretKey: string,
  customer: { id: string; metadata: Record<string, string> },
  row: BookingRow,
  events: BookingEvent[],
): Promise<void> {
  const eff = buildEffectiveMeta(row, events, Boolean(customer.metadata["gh_payment_method"]));
  if (!eff["gh_state"] && customer.metadata["gh_state"]) eff["gh_state"] = customer.metadata["gh_state"];
  const params: Record<string, string> = { "metadata[gh_booking_id]": row.booking_id };
  for (const [k, v] of Object.entries(eff)) params[`metadata[${k}]`] = v;
  params["metadata[gh_report_amount_cents]"] = row.amount_cents != null ? String(row.amount_cents) : "";
  params["metadata[gh_report_bounced]"] = row.report_bounced ? "1" : "";
  params["metadata[gh_booking_confirmed]"] = eff["gh_confirmed_date"] ? "1" : "";
  await stripePost(secretKey, `/customers/${customer.id}`, params);
  for (const [k, v] of Object.entries(eff)) customer.metadata[k] = v;
  customer.metadata["gh_booking_id"] = row.booking_id;
  customer.metadata["gh_report_amount_cents"] = params["metadata[gh_report_amount_cents]"];
  customer.metadata["gh_report_bounced"] = params["metadata[gh_report_bounced]"];
  customer.metadata["gh_booking_confirmed"] = params["metadata[gh_booking_confirmed]"];
}

const STRIPE_API = "https://api.stripe.com/v1";
const LATE_CANCEL_FEE_CENTS = 2500; // Terms: $25 inside 48 hours

const _rlHits = new Map<string, number[]>();
function rateLimit(ip: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const arr = (_rlHits.get(ip) ?? []).filter((t) => now - t < 60000);
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

const ALLOWED_ORIGINS = [
  "https://gatehousehomecleaning.com",
  "https://www.gatehousehomecleaning.com",
  "http://localhost:8080",
];

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
  type RawCust = { id: string; email?: string; name?: string; metadata?: Record<string, string> };
  const shape = (c: RawCust) => ({
    id: c.id,
    email: typeof c.email === "string" ? c.email : "",
    name: typeof c.name === "string" ? c.name : "",
    metadata: c.metadata ?? {},
  });
  const query = `metadata['gh_booking_id']:'${bookingId.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "1" })}`);
  if (res.ok) {
    const list = (res.data["data"] as RawCust[] | undefined) ?? [];
    return list.length > 0 ? shape(list[0]) : null;
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return null;
  const list = (listRes.data["data"] as RawCust[] | undefined) ?? [];
  const found = list.find((c) => c.metadata?.["gh_booking_id"] === bookingId);
  return found ? shape(found) : null;
}

export type VisitState =
  | "card_needed" | "card_failed" | "awaiting_confirmation" | "confirmed"
  | "date_declined" | "report_sent" | "issue_open" | "approved" | "paid"
  | "payment_issue" | "cancelled";

export function deriveVisitState(meta: Record<string, string>): VisitState {
  const state = meta["gh_state"] ?? "";
  if (state === "cancelled") return "cancelled";
  if (state === "paid") return "paid";
  if (state === "payment_failed") return "payment_issue";
  if (state === "date_declined") return "date_declined";
  if (meta["gh_issue_open"] === "1" || state === "issue_open") return "issue_open";
  if (state === "approved" || state === "payment_pending") return "approved";
  if (meta["gh_report_sent_at"]) return "report_sent";
  if (meta["gh_confirmed_date"]) return "confirmed";
  if (state === "card_ready") return "awaiting_confirmation";
  if (state === "card_failed") return "card_failed";
  return "card_needed";
}

// The visit moment used for the 48h rule: the confirmed date when there
// is one, otherwise the requested date, at midday Atlanta time.
export function visitMomentMs(meta: Record<string, string>, requestedDate: string): number {
  const d = meta["gh_confirmed_date"] || requestedDate || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return NaN;
  return Date.parse(`${d}T12:00:00-04:00`);
}

export function cancelFeeCents(meta: Record<string, string>, requestedDate: string, nowMs: number): number {
  const state = deriveVisitState(meta);
  if (state === "cancelled" || state === "paid") return 0;
  const visitMs = visitMomentMs(meta, requestedDate);
  if (!Number.isFinite(visitMs)) return 0;
  return visitMs - nowMs >= 48 * 3600 * 1000 ? 0 : LATE_CANCEL_FEE_CENTS;
}

function money(cents: number | null): string | null {
  if (cents === null || !Number.isFinite(cents) || cents <= 0) return null;
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

const q = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? v[0] ?? "" : v ?? "";

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
    console.error(JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }));

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
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (req.method === "GET") {
      bt = q((req.query ?? {})["bt"]);
    } else {
      bt = typeof body["bt"] === "string" ? body["bt"] : "";
      action = typeof body["action"] === "string" ? body["action"] : "";
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
    const row = await latestBookingRow(payload.bid);
    const events = row ? await bookingEvents(payload.bid) : [];
    let customer = boundCustomer;
    if (!customer && payload.email) {
      customer = await findCustomerByEmail(STRIPE_SECRET_KEY, payload.email);
    }
    const bound = Boolean(boundCustomer);
    if (customer) {
      try {
        await reconcileCard(STRIPE_SECRET_KEY, customer);
      } catch {
        /* cached metadata still applies */
      }
    }
    if (!customer && !row) {
      res.status(200).json({
        requestId, ok: true, state: "card_needed" as VisitState,
        booking: { service: payload.service ?? "", date: payload.date ?? "", first: payload.first ?? "" },
      });
      return;
    }
    if (!customer) {
      // Booking exists in the DB but no Stripe customer at all: the card
      // was never saved. The view below renders from the DB row alone.
      customer = { id: "", metadata: {}, email: payload.email, name: payload.name };
    }
    // Before any WRITE action on an unbound booking, sync the shared
    // customer's metadata to this booking's own state.
    if (req.method === "POST" && row && !bound && customer.id) {
      try {
        await hydrateCustomerMeta(STRIPE_SECRET_KEY, customer, row, events);
      } catch {
        /* actions below re-check state before writing */
      }
    }
    // With a DB row, the booking-scoped view ALWAYS comes from the row +
    // journal — even when this customer is currently bound to the booking,
    // because a legacy binding can carry another booking's stale fields.
    const meta = row && req.method === "GET"
      ? { ...customer.metadata, ...buildEffectiveMeta(row, events, Boolean(customer.metadata["gh_payment_method"]), payload.recurring) }
      : customer.metadata;
    const requestedDate = payload.date ?? "";

    // §3: the saved card's brand/last4 + whether THIS booking confirmed it.
    // A card on file without a card_confirmed event is a choice waiting
    // for the client — never an assumed confirmation.
    let cardBrand = "";
    let cardLast4 = "";
    const cardConfirmed = Boolean(latestEvent(events, "card_confirmed"));
    if (customer.id && meta["gh_payment_method"]) {
      try {
        const pmRes = await stripeGet(STRIPE_SECRET_KEY, `/customers/${encodeURIComponent(customer.id)}/payment_methods?${new URLSearchParams({ type: "card", limit: "1" })}`);
        const pm = (pmRes.data["data"] as Array<{ card?: { brand?: string; last4?: string } }> | undefined)?.[0];
        cardBrand = String(pm?.card?.brand ?? "");
        cardLast4 = String(pm?.card?.last4 ?? "");
      } catch { /* best-effort — the choice UI falls back to no details */ }
    }

    const view = () => {
      const firstCents = parseInt(meta["gh_first_price_cents"] ?? "", 10);
      const recCents = parseInt(meta["gh_recurring_price_cents"] ?? "", 10);
      return {
        requestId,
        ok: true,
        state: deriveVisitState(meta),
        booking: {
          // Service falls back to the visit row: owner-minted and report
          // links carry no service in their payload, so without this the
          // client page shows no service at all on those visits.
          service: payload.service || (row as unknown as { service?: string } | null)?.service || "",
          // §5: the server-recorded first-visit service ("deep" when the
          // client answered No to recent professional cleaning) — the
          // label every surface must show, not the form's "Standard".
          first_service: (latestEvent(events, "visit_created")?.detail?.["first_service"] as string | undefined) ?? "",
          requested_date: requestedDate,
          confirmed_date: meta["gh_confirmed_date"] ?? "",
          window: meta["gh_confirmed_window"] ?? "",
          first: money(Number.isFinite(firstCents) ? firstCents : null) ?? payload.first ?? "",
          recurring: money(Number.isFinite(recCents) ? recCents : null),
        },
        cleaner: meta["gh_cleaner_name"]
          ? { name: meta["gh_cleaner_name"], photo: rowCleanerPhoto(row) || meta["gh_cleaner_photo"] || "" }
          : null,
        alt_dates: (meta["gh_alt_dates"] ?? "").split(",").filter(Boolean),
        cancel_fee_cents: cancelFeeCents(meta, requestedDate, Date.now()),
        cancel_fee: money(cancelFeeCents(meta, requestedDate, Date.now())) ?? "$0",
        cancelled_scope: meta["gh_cancel_scope"] ?? "",
        access_notes: meta["gh_access_notes"] ?? "",
        no_photo_zones: meta["gh_no_photo_zones"] ?? "",
        has_card: Boolean(meta["gh_payment_method"]),
        card_brand: cardBrand,
        card_last4: cardLast4,
        card_confirmed: cardConfirmed,
        // The cleaner has submitted the report and the owner has not
        // published it yet: the customer's review period has NOT started.
        // Gated on confirmation: a report submitted for a visit that was
        // never confirmed must NOT render as "cleaning complete" next to
        // "awaiting confirmation" — that contradiction was the reported
        // break. Unpublished reports stay invisible to the client either
        // way; this flag only drives the "preparing" note.
        report_preparing: Boolean(row && row.report_status === "submitted" && !row.report_sent_at && latestEvent(events, "visit_confirmed")),
        // Internal scope-review flag, surfaced to the customer only as a
        // plain explanation (the agreed price never changes silently).
        scope_review_needed: Boolean(latestEvent(events, "scope_review")),
        // When the visit is not confirmed yet, this is the moment we
        // promised to confirm by — the same label the emails quote.
        confirm_by: meta["gh_confirmed_date"] ? "" : confirmDeadlineLabel(),
      };
    };

    if (req.method === "GET") {
      res.status(200).json(view());
      return;
    }
    if (!customer.id) {
      res.status(404).json({ requestId, ok: false, error: "booking_not_found" });
      return;
    }

    const state = deriveVisitState(meta);
    if (state === "cancelled") {
      res.status(409).json({ requestId, ok: false, error: "already_cancelled" });
      return;
    }
    const notify = async (subject: string, text: string, toClient: boolean) => {
      const RESEND_API_KEY = process.env["RESEND_API_KEY"];
      if (!RESEND_API_KEY) return;
      const to = toClient && customer.email ? [customer.email] : ["nikolajmihasenok@gmail.com"];
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Gatehouse site <info@gatehousehomecleaning.com>",
            to, reply_to: "hello@gatehousehomecleaning.com", subject, text,
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        /* best-effort */
      }
    };

    if (action === "accept_alt_date") {
      const date = typeof body["date"] === "string" ? body["date"] : "";
      const alts = (meta["gh_alt_dates"] ?? "").split(",").filter(Boolean);
      if (state !== "date_declined" || !alts.includes(date)) {
        res.status(409).json({ requestId, ok: false, error: "date_not_offered" });
        return;
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "card_ready",
        "metadata[gh_confirmed_date]": date,
        "metadata[gh_alt_dates]": "",
      });
      Object.assign(meta, { gh_state: "card_ready", gh_confirmed_date: date, gh_alt_dates: "" });
      if (row) await logEvent(row.id, payload.bid, "client", "visit_confirmed", { date, window: meta["gh_confirmed_window"] ?? "" });
      await notify(`Date accepted — booking ${payload.bid}`, `The client accepted the alternative date ${date} for booking ${payload.bid}.`, false);
      res.status(200).json(view());
      return;
    }

    if (action === "propose_date") {
      const date = typeof body["date"] === "string" ? body["date"].slice(0, 10) : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ requestId, ok: false, error: "bad_date" });
        return;
      }
      if (state !== "date_declined" && state !== "awaiting_confirmation" && state !== "confirmed") {
        res.status(409).json({ requestId, ok: false, error: "cannot_reschedule_now" });
        return;
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "card_ready",
        "metadata[gh_confirmed_date]": "",
        "metadata[gh_alt_dates]": "",
        "metadata[gh_proposed_date]": date,
      });
      Object.assign(meta, { gh_state: "card_ready", gh_confirmed_date: "", gh_alt_dates: "", gh_proposed_date: date });
      if (row) await logEvent(row.id, payload.bid, "client", "date_proposed", { date });
      await notify(`New date proposed — booking ${payload.bid}`, `The client proposed a new date: ${date} (booking ${payload.bid}). Confirm or decline it in the dashboard flow.`, false);
      res.status(200).json({ ...view(), proposed_date: date });
      return;
    }

    if (action === "cancel") {
      const scope = body["scope"] === "stop" ? "stop" : "once";
      if (state === "paid" || state === "report_sent" || state === "approved") {
        res.status(409).json({ requestId, ok: false, error: "visit_already_done" });
        return;
      }
      const fee = cancelFeeCents(meta, requestedDate, Date.now());
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
        "metadata[gh_state]": "cancelled",
        "metadata[gh_cancel_scope]": scope,
        "metadata[gh_cancel_fee_cents]": String(fee),
        "metadata[gh_cancelled_at]": new Date().toISOString(),
      });
      Object.assign(meta, { gh_state: "cancelled", gh_cancel_scope: scope, gh_cancel_fee_cents: String(fee) });
      if (row) {
        await logEvent(row.id, payload.bid, "client", "visit_cancelled", { scope, fee_cents: fee });
        await dbUpdate("gh_visits", `id=eq.${row.id}`, { status: "cancelled" });
      }
      const scopeText = scope === "stop"
        ? "This visit and all future recurring visits are cancelled."
        : "This visit is cancelled. Your recurring schedule stays in place — tell us if you want to stop it too.";
      await notify(
        scope === "stop" ? "Your recurring cleanings are cancelled" : "Your visit is cancelled",
        `Hi ${(customer.name || "").trim().split(/\s+/)[0] || "there"},\n\n${scopeText}\n` +
          (fee > 0
            ? `Because this is inside 48 hours before the visit, the $25 late-cancellation fee from our Terms applies and will be charged to your saved card.\n`
            : `No fee — you cancelled more than 48 hours before the visit.\n`) +
          `Your saved card stays on file for future bookings; ask us any time to remove it.\n\nGatehouse Home Cleaning\n`,
        true,
      );
      await notify(`Cancelled (${scope}) — booking ${payload.bid}`, `Booking ${payload.bid} cancelled by the client. Scope: ${scope}. Fee recorded: ${fee} cents.`, false);
      res.status(200).json({ ...view(), fee_cents: fee });
      return;
    }

    if (action === "update_access") {
      const notes = typeof body["notes"] === "string" ? body["notes"].slice(0, 300) : null;
      const zones = typeof body["no_photo_zones"] === "string" ? body["no_photo_zones"].slice(0, 200) : null;
      const params: Record<string, string> = {};
      if (notes !== null) params["metadata[gh_access_notes]"] = notes;
      if (zones !== null) params["metadata[gh_no_photo_zones]"] = zones;
      if (Object.keys(params).length === 0) {
        res.status(400).json({ requestId, ok: false, error: "nothing_to_update" });
        return;
      }
      await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, params);
      Object.assign(meta, {
        ...(notes !== null ? { gh_access_notes: notes } : {}),
        ...(zones !== null ? { gh_no_photo_zones: zones } : {}),
      });
      if (row) {
        await dbUpdate("gh_visits", `id=eq.${row.id}`, {
          ...(notes !== null ? { access_notes: notes } : {}),
          ...(zones !== null ? { no_photo_zones: zones } : {}),
        });
      }
      res.status(200).json(view());
      return;
    }

    res.status(400).json({ requestId, ok: false, error: "invalid_action" });
  } catch (error: unknown) {
    logErr("unexpected", error);
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
