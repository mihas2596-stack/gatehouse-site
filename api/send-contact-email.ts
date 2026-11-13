import { z } from "zod";
import { buildWorkRooms } from "./_work_scope.js";
import { dbConfigured, dbSelect, dbSelectStrict, dbInsert, dbDelete, logEvent } from "./_db.js";
import { ownerNotificationEmail } from "./_owner_email.js";
import { emailDate, emailArrivalWindow, emailDocument, paymentEmailCopy } from "./_email_copy.js";
import { createHmac, timingSafeEqual, randomUUID, createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

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

// ---- Server-side price tables (inlined — api/ cannot import from src/
// due to the Vercel bundler limitation). Must match src/config/calculator.ts.
// Used to verify the browser-sent price instead of trusting it blindly.
type TierKey = "S" | "M" | "L";
const SERVER_PRICES: Record<string, Record<TierKey, number>> = {
  standardOnetime: { S: 149, M: 219, L: 279 },
  deep: { S: 249, M: 329, L: 399 },
  moveinout: { S: 279, M: 369, L: 449 },
  recurring: { S: 129, M: 189, L: 239 },
};
function serverTierFor(bedrooms: number, fullBaths: number): TierKey | null {
  if (!Number.isFinite(bedrooms) || !Number.isFinite(fullBaths)) return null;
  if (bedrooms > 5 || fullBaths > 5) return null;
  if (bedrooms >= 4 || fullBaths >= 4) return "L";
  if (bedrooms === 3 || fullBaths === 3) return "M";
  return "S";
}
// Returns the exact first-visit and recurring totals for the given inputs.
// Mirrors priceBreakdown() in src/config/calculator.ts — the two MUST stay
// in sync (see src/test/calculator.test.ts). The browser-sent price is
// verified against this, never trusted.
type ServerAddonSel = {
  insideOven?: boolean;
  insideFridge?: boolean;
  insideCabinets?: boolean;
  interiorWindows?: number;
  pets?: boolean;
};
const SERVER_ADDON_PRICES: Record<string, number> = {
  insideOven: 35,
  insideFridge: 35,
  insideCabinets: 45,
  interiorWindow: 8,
  pets: 15,
};
const SERVER_ADDONS_INCLUDED: Record<string, string[]> = {
  standard: [],
  deep: ["insideOven", "insideFridge", "insideCabinets"],
  moveinout: ["insideOven", "insideFridge", "insideCabinets"],
};
function serverAddonsTotal(a: ServerAddonSel, serviceKey: string): number {
  const included = SERVER_ADDONS_INCLUDED[serviceKey] ?? [];
  const charge = (key: string, on?: boolean) =>
    on && !included.includes(key) ? SERVER_ADDON_PRICES[key] ?? 0 : 0;
  const windows = Math.min(40, Math.max(0, a.interiorWindows ?? 0));
  return (
    charge("insideOven", a.insideOven) +
    charge("insideFridge", a.insideFridge) +
    charge("insideCabinets", a.insideCabinets) +
    charge("pets", a.pets) +
    windows * (SERVER_ADDON_PRICES["interiorWindow"] ?? 0)
  );
}
// The Founding Clients program was closed to new bookings by the owner on
// 2026-10-23. A `founding` flag sent by a stale open tab is accepted by the
// schema and IGNORED — new bookings always price from the regular tables.
// Existing bookings keep their pinned prices; nothing here touches them.
//
// Owner price-test mode: a booking submitted with a valid signed test
// token (see verifyTestPriceToken) prices at TEST_PRICE_SCALE so the owner
// can run a real-card payment check at 1/10 of the regular price. The
// token is bound to the owner's email and expires; regular bookings are
// never affected.
export const TEST_PRICE_SCALE = 0.01;
// Owner order 2026-10-24: GLOBAL 48-hour test-price window (mirrors
// GLOBAL_TEST_CUT_UNTIL_MS in src/config/calculator.ts). While active,
// every booking prices at TEST_PRICE_SCALE — no token needed. Auto-expires.
// Extended by owner order 2026-10-26 by 24h: now ends 2026-10-27T10:33:00Z.
// Extended again by owner order 2026-10-26 by 48h: now ends 2026-10-29T10:33:00Z.
// Extended again by owner order 2026-10-28 by 72h: now ends 2026-11-01T10:33:00Z.
// Extended again by owner order 2026-10-31: now ends 2026-11-03T10:33:00Z
// (owner payment testing 2026-11-01–02; values unchanged, only the window).
// Extended again 2026-11-03, then by owner order 2026-11-06 for another
// week: ends 2026-11-13T20:59:59Z (23:59 Minsk). Extended again by owner
// order 2026-11-12 by 5 days: ends 2026-11-18T20:59:59Z (23:59 Minsk).
// Existing quotes stay pinned.
const GLOBAL_TEST_CUT_UNTIL_MS = Date.parse("2026-11-18T20:59:59Z");
const globalTestCutActive = (nowMs: number = Date.now()): boolean =>
  nowMs < GLOBAL_TEST_CUT_UNTIL_MS;
const moneyRound = (n: number): number => Math.round(n * 100) / 100;

export function verifyTestPriceToken(
  token: string,
  email: string,
  adminToken: string | undefined,
  nowSec: number,
): boolean {
  if (!token || !adminToken) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "tp1") return false;
  const exp = parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(exp) || exp < nowSec || exp > nowSec + 48 * 3600) return false;
  let tokenEmail = "";
  try {
    tokenEmail = Buffer.from(parts[2] ?? "", "base64url").toString("utf8");
  } catch {
    return false;
  }
  if (!tokenEmail || tokenEmail !== (email ?? "").trim().toLowerCase()) return false;
  const key = createHash("sha256").update(`gatehouse-test-price:${adminToken}`).digest();
  const expected = createHmac("sha256", key).update(`tp1.${parts[1]}.${parts[2]}`).digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parts[3] ?? "", "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function serverBreakdown(opts: {
  bedroomsRaw: string | undefined;
  bathroomsRaw: string | undefined;
  // Exact full-bath count from the form. bathroomsRaw mixes full + half
  // baths into one decimal ("2 full + 2 half" = "3"), which the legacy
  // parse below misreads as 3 full baths — tiering a larger home than
  // the customer saw (M1). When fullBathsRaw is present it wins.
  fullBathsRaw?: string | undefined;
  serviceKey: string | undefined;
  frequency: string | undefined;
  cleanedRecently: boolean | undefined;
  addons: ServerAddonSel;
  testScale?: boolean;
}): { first_total: number; recurring_total: number; first_service: "deep" | "standard" } | null {
  const bedrooms = parseInt(opts.bedroomsRaw ?? "", 10);
  const exactFull = parseInt(opts.fullBathsRaw ?? "", 10);
  const fullBaths = Number.isFinite(exactFull) && (opts.fullBathsRaw ?? "").trim() !== ""
    ? exactFull
    : parseInt((opts.bathroomsRaw ?? "").split(".")[0], 10);
  const tier = serverTierFor(bedrooms, fullBaths);
  if (!tier) return null;
  const serviceKey = opts.serviceKey ?? "standard";
  let result: { first_total: number; recurring_total: number; first_service: "deep" | "standard" };
  // Deep / move-in-out are one-time services.
  if (serviceKey === "deep" || serviceKey === "moveinout") {
    const base = SERVER_PRICES[serviceKey][tier];
    const total = base + serverAddonsTotal(opts.addons, serviceKey);
    result = { first_total: total, recurring_total: total, first_service: "deep" };
  } else {
    const deepFirst = !(opts.cleanedRecently ?? true);
    const first_service: "deep" | "standard" = deepFirst ? "deep" : "standard";
    const recurringBase = SERVER_PRICES.recurring[tier];
    const recurring_total = recurringBase + serverAddonsTotal(opts.addons, "standard");
    // One-time visits price from the one-time table; recurring plans price
    // the first visit at the recurring rate (or deep when needed).
    const standardBase =
      opts.frequency === "onetime" ? SERVER_PRICES.standardOnetime[tier] : SERVER_PRICES.recurring[tier];
    const base = deepFirst ? SERVER_PRICES.deep[tier] : standardBase;
    result = {
      first_total: base + serverAddonsTotal(opts.addons, first_service),
      recurring_total,
      first_service,
    };
  }
  if (opts.testScale) {
    // Owner order 2026-10-23: during the test window no visit prices
    // above $1.50 (mirrors TEST_PRICE_CAP in src/config/calculator.ts).
    result = {
      ...result,
      first_total: Math.min(1.5, moneyRound(result.first_total * TEST_PRICE_SCALE)),
      recurring_total: Math.min(1.5, moneyRound(result.recurring_total * TEST_PRICE_SCALE)),
    };
  }
  return result;
}

const b64urlEncode = (s: string): string =>
  Buffer.from(s, "utf8").toString("base64url");
const b64urlDecode = (s: string): string =>
  Buffer.from(s, "base64url").toString("utf8");

// v2 booking-link tokens: the payload is AES-256-GCM encrypted, so a link
// carries nothing readable (no name, email or prices) into analytics, server
// logs or a forwarded message. v1 tokens were signed-but-readable JSON;
// verifiers still accept them so links already emailed keep working until
// they expire (60 days). New v2 links live 30 days.
const TOKEN_TTL_V2_SECONDS = 30 * 24 * 3600;

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

// Idempotency: a retried submission carries the same request_id, so derive
// the booking id from it deterministically. A retry after a lost response
// then reproduces the SAME booking (same bid, Resend dedupes the emails by
// request_id too) instead of creating a duplicate booking.
export function bidFromRequestId(requestId: string): string {
  const h = createHash("sha256").update(`gatehouse-bid:${requestId}`).digest("hex");
  const variant = (parseInt(h.slice(16, 17), 16) & 0x3) | 0x8;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant.toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Natural-key dedup (L2): a resubmission from a NEW TAB or browser carries
// a fresh request_id, so the bid-based dedup above cannot see it — the same
// booking would be created twice. The natural key (email + date + service
// + address + window + amount) catches it: an identical booking created
// within the window is the same request, not a second visit. A cancelled
// visit never matches (re-booking after a cancellation is a new booking),
// and an intentional second visit sends force_new_booking to bypass this
// check explicitly. The window is short on purpose: a genuine second visit
// for the same home/date/service is almost always booked later, and after
// the window it creates a new booking normally.
export const NATURAL_DEDUP_WINDOW_MS = 60 * 60 * 1000;

export type VisitDedupRow = {
  id: string;
  booking_id: string;
  client_name: string | null;
  client_email: string | null;
  visit_date: string | null;
  service: string | null;
  address: string | null;
  window: string | null;
  amount_cents: number | null;
  status: string | null;
  created_at: string | null;
};

export type NaturalBookingKey = {
  email: string;
  date: string;
  service: string;
  address: string;
  window: string;
  amountCents: number | null;
};

export function isNaturalDuplicate(
  key: NaturalBookingKey,
  row: VisitDedupRow,
  nowMs: number = Date.now(),
): boolean {
  if ((row.status ?? "") === "cancelled") return false;
  if ((row.client_email ?? "").trim().toLowerCase() !== key.email) return false;
  if ((row.visit_date ?? "") !== key.date) return false;
  if ((row.service ?? "") !== key.service) return false;
  if ((row.address ?? "").trim().toLowerCase() !== key.address) return false;
  if ((row.window ?? "").trim() !== key.window) return false;
  if ((row.amount_cents ?? null) !== key.amountCents) return false;
  const created = row.created_at ? Date.parse(row.created_at) : NaN;
  if (!Number.isFinite(created)) return false;
  const age = nowMs - created;
  return age >= 0 && age < NATURAL_DEDUP_WINDOW_MS;
}

function signBooking(
  secret: string,
  payload: Omit<BookingPayload, "bid" | "ts"> & { bid?: string; ts?: number },
): { token: string; bid: string } {
  const full: BookingPayload = {
    ...payload,
    bid: payload.bid ?? randomUUID(),
    ts: payload.ts ?? Math.floor(Date.now() / 1000),
  };
  return { token: encryptBookingPayload(secret, full), bid: full.bid };
}


// Booking-link signing key, separate from STRIPE_SECRET_KEY so that a Stripe
// key rotation does not invalidate outstanding booking links. Set
// BOOKING_LINK_SECRET in Vercel; until then it falls back to the Stripe key
// and old links keep working.
const bookingLinkSecret = (stripeKey: string): string =>
  process.env["BOOKING_LINK_SECRET"] || stripeKey;

// Verify with the dedicated key first, then the legacy Stripe key, so links
// issued before the dedicated key was set keep working through rotation.
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
    // Legacy v1: HMAC-signed readable payload.
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


// Inlined from ../src/config/service-area (self-contained: the working
// create-checkout-session function has no cross-directory imports, and the
// bundler chokes on them here).
const SERVICE_ZIPS = new Set([
  "30024", "30518", "30519", "30097", "30096", "30099",
  "30004", "30005", "30009", "30022", "30075", "30076", "30077",
]);

function earliestServiceDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + 3));
  return date.toISOString().slice(0, 10);
}

function validServiceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Vercel serverless function — replaces the Lovable Cloud edge function
// "send-contact-email". Sends via Resend's public API directly; no Lovable
// connector gateway, no Supabase.
//
// Env required: RESEND_API_KEY

const RESEND_API = "https://api.resend.com/emails";
const FROM_OWNER = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const FROM_AUTO = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const REPLY_TO_AUTO = "hello@gatehousehomecleaning.com";

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

const ContactSchema = z.object({
  request_id: z.string().uuid().optional(),
  website: z.string().max(300).optional(),
  name: z.string().trim().min(1).max(255),
  phone: z.string().max(50).optional().or(z.literal("")),
  email: z.string().trim().max(255).optional().or(z.literal("")),
  service: z.string().max(255).optional().or(z.literal("")),
  date: z.string().max(50).optional().or(z.literal("")),
  time: z.string().max(50).optional().or(z.literal("")),
  message: z.string().max(5000).optional().or(z.literal("")),
  entry_instructions: z.string().max(1000).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
  consent_record: z.string().max(2000).optional().or(z.literal("")),
  founding: z.boolean().optional(),
  test_token: z.string().max(300).optional(),
  test_price_window: z.boolean().optional(),
  extra_zones: z.string().max(200).optional(),
  scope_review: z.boolean().optional(),
  scope_reasons: z.string().max(300).optional(),
  bedrooms: z.string().max(20).optional().or(z.literal("")),
  bathrooms: z.string().max(20).optional().or(z.literal("")),
  full_baths: z.string().max(20).optional().or(z.literal("")),
  half_baths: z.string().max(20).optional().or(z.literal("")),
  zip: z.string().max(20).optional().or(z.literal("")),
  address: z.string().max(400).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  state: z.string().max(50).optional().or(z.literal("")),
  apt: z.string().max(50).optional().or(z.literal("")),
  entry_method: z.enum(["home", "other_person", "arrange_before", "decide_later"]).optional(),
  entry_detail: z.enum(["door_code", "lockbox", "other"]).optional(),
  entry_notes: z.string().max(500).optional().or(z.literal("")),
  price: z.string().max(20).optional().or(z.literal("")),
  // Exact quote inputs — the server recomputes the price from these and
  // never trusts the browser-sent price for the signed booking token.
  frequency: z.enum(["every2weeks", "onetime"]).optional(),
  service_key: z.enum(["standard", "deep", "moveinout"]).optional(),
  cleaned_recently: z.boolean().optional(),
  addons: z.object({
    insideOven: z.boolean().optional(),
    insideFridge: z.boolean().optional(),
    insideCabinets: z.boolean().optional(),
    interiorWindows: z.number().int().min(0).max(40).optional(),
    pets: z.boolean().optional(),
  }).optional(),
  attribution: z.object({
    utm_source: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
    utm_medium: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
    utm_campaign: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
    utm_content: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
  }).optional(),
  source: z.enum(["quote", "contact"]).default("contact"),
  terms_consent: z.boolean().optional(),
  photo_consent: z.boolean().optional(),
  sms_consent: z.boolean().optional(),
  // Explicit second-visit request: bypasses BOTH the request_id dedup
  // and the natural-key dedup below. Only an intentional second visit
  // sends this — never set by default, never implied by a retry.
  force_new_booking: z.boolean().optional(),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Booking-specific checks (quote form). Plain-English, field-keyed messages.
const bookingErrors = (d: z.infer<typeof ContactSchema>): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (!d.email || !EMAIL_RE.test(d.email.trim())) errors.email = "Enter a valid email, like name@example.com.";
  let digits = (d.phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) errors.phone = "Enter a 10-digit US phone number.";
  if (!SERVICE_ZIPS.has((d.zip || "").trim())) errors.zip = "Enter a ZIP in our North Atlanta service area.";
  // We serve Georgia only: a non-GA state next to a GA ZIP is inconsistent data.
  if (d.state && d.state.trim() && d.state.trim().toUpperCase() !== "GA")
    errors.state = "We currently serve Georgia only — please enter GA.";
  if (!d.address || d.address.trim().length < 5) errors.address = "Enter your street address.";
  if (!d.date || !validServiceDate(d.date) || d.date < earliestServiceDate()) errors.date = "Choose a valid preferred date at least 3 days ahead.";
  if (d.terms_consent !== true) errors.terms_consent = "Please agree to the Terms of Service and Privacy Policy.";
  if (d.photo_consent !== true) errors.photo_consent = "Please agree to the photo report.";
  return errors;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const firstNameOf = (raw: unknown): string => {
  if (!raw) return "there";
  const s = String(raw).trim();
  if (s.length < 2) return "there";
  if (s.includes("@")) return "there";
  const first = s.split(/\s+/)[0];
  if (first.length < 2) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

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

// Confirmation deadline promised to the customer: 6:00 PM Atlanta time on
// the next business day (Mon-Fri). The same label is quoted in the card
// confirmation email and on the visit pages, so every surface agrees.
export function confirmDeadlineLabel(from = new Date()): string {
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

// Prominent HTML email button (table-based for mail-client compatibility).
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:#8B5E3C;border-radius:8px;"><a href="${href}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;">${label}</a></td></tr></table>`;
}

// Canonical payment explanation (Terms 5.2 model): viewing photos is never
// required for automatic charging; any reported issue permanently blocks it.
export function paymentExplainer(amount: string): string {
  return paymentEmailCopy(amount);
}

async function sendEmail(apiKey: string, payload: Record<string, unknown>, idempotencyKey?: string) {
  const response = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  let data: { name?: string; message?: string } = {};
  try {
    data = await response.json();
  } catch {
    /* ignore */
  }
  return { ok: response.ok, status: response.status, data };
}

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

  // M3: this endpoint sends email to arbitrary addresses — it was the
  // only public POST without a rate limit, and requests with NO Origin
  // header (any script) sailed through the gate above. Browser form
  // posts always carry an Origin; require it, and cap the send rate.
  if (!origin) {
    res.status(403).json({ ok: false, error: "origin_required" });
    return;
  }
  if (!rateLimit(clientIp(req.headers), 30)) {
    res.status(429).json({ ok: false, error: "rate_limited" });
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
    const RESEND_API_KEY = process.env["RESEND_API_KEY"];
    if (!RESEND_API_KEY) {
      logErr("config", "RESEND_API_KEY is not configured");
      return json(500, { ok: false, error: "server_error" });
    }

    // Step: parse (Vercel pre-parses JSON bodies when content-type is application/json)
    const body: unknown = req.body ?? null;
    if (!body || typeof body !== "object") {
      logErr("parse", "empty or non-object body");
      return json(400, { ok: false, errors: { form: "The request could not be read. Please try again." } });
    }
    log("parse", "ok");

    // Step: validate
    const parsed = ContactSchema.safeParse(body);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
        errors[k] = (v && v[0]) || "This field is not valid.";
      }
      log("validate", { fields: Object.keys(errors) });
      return json(400, { ok: false, errors });
    }
    {
      const errors: Record<string, string> =
        parsed.data.source === "quote"
          ? bookingErrors(parsed.data)
          : {
              ...(!parsed.data.email || !EMAIL_RE.test(parsed.data.email) ? { email: "Enter a valid email, like name@example.com." } : {}),
              ...(!parsed.data.message?.trim() ? { message: "Enter your question." } : {}),
            };
      if (Object.keys(errors).length) {
        log("validate", { fields: Object.keys(errors) });
        return json(400, { ok: false, errors });
      }
    }
    if (parsed.data.website) return json(400, { ok: false, error: "invalid_request" });
    log("validate", "ok");

    const {
      name,
      phone,
      email,
      service,
      date,
      time,
      message,
      entry_instructions: _entry_instructions_ignored,
      notes,
      extra_zones,
      scope_review,
      scope_reasons,
      bedrooms,
      bathrooms,
      zip,
      address,
      city,
      state,
      apt,
      entry_method,
      entry_detail,
      entry_notes,
      price,
    } = parsed.data;

    const isQuote = parsed.data.source === "quote";

    // Server-issued booking identity (quote bookings only). The HMAC-signed
    // token binds this booking to the card-saving step (/save-card?bt=...)
    // without a database. Signed with STRIPE_SECRET_KEY (inlined below, stateless).
    let bookingToken: string | null = null;
    let bookingId: string | null = null;
    let visitRowId: string | null = null;
    let saveCardUrl: string | null = null;
    let visitUrl: string | null = null;
    // Server-verified first-visit price (recomputed, never the browser value).
    let serverFirst: string | undefined;
    let testScale = false;
    // Owner order 2026-10-24: a GLOBAL 48-hour test-price window. While
    // active, every booking prices at TEST_PRICE_SCALE with no token
    // needed; the window auto-expires 2026-11-18 20:59 UTC. Token sessions
    // (testScale) work the same way on top of it.
    const cutScale = globalTestCutActive();
    let serverRecurring: string | undefined;
    if (isQuote) {
      const signingSecret = process.env["STRIPE_SECRET_KEY"];
      if (!signingSecret) {
        logErr("config", "STRIPE_SECRET_KEY is not configured (needed for booking token)");
        return json(500, { ok: false, error: "server_error" });
      }
      // Server-side price verification: recompute the EXACT breakdown from
      // the quote inputs (bedrooms, bathrooms, service, frequency,
      // cleaning history, add-ons). The browser-sent price is never trusted
      // for the signed token: any mismatch is replaced and logged (tamper
      // attempt or stale calculator).
      // Owner price-test token: when present it MUST verify — an invalid
      // or expired token rejects the submission instead of silently
      // repricing the booking at regular prices.
      const testToken = (parsed.data.test_token ?? "").trim();
      if (testToken) {
        testScale = verifyTestPriceToken(
          testToken,
          email ?? "",
          process.env["ADMIN_TOKEN"],
          Math.floor(Date.now() / 1000),
        );
        if (!testScale) {
          return json(400, {
            ok: false,
            errors: {
              test_token:
                "This test-price link is invalid or has expired. Regular prices apply — please reload the quote page.",
            },
          });
        }
      }
      const server = serverBreakdown({
        bedroomsRaw: bedrooms,
        bathroomsRaw: bathrooms,
        fullBathsRaw: parsed.data.full_baths,
        serviceKey: parsed.data.service_key,
        frequency: parsed.data.frequency,
        cleanedRecently: parsed.data.cleaned_recently,
        testScale: testScale || cutScale,
        addons: {
          insideOven: parsed.data.addons?.insideOven,
          insideFridge: parsed.data.addons?.insideFridge,
          insideCabinets: parsed.data.addons?.insideCabinets,
          interiorWindows: parsed.data.addons?.interiorWindows,
          pets: parsed.data.addons?.pets,
        },
      });
      let tokenPrice = (price ?? "").trim() || undefined;
      let tokenRecurring: string | undefined;
      if (server) {
        const browserPriceNum = tokenPrice ? parseFloat(tokenPrice.replace(/[^0-9.]/g, "")) : NaN;
        const displayedTestWindow = parsed.data.test_price_window;
        const staleTestPrice = !cutScale && browserPriceNum === Math.min(1.5, moneyRound(server.first_total * TEST_PRICE_SCALE));
        if (!testScale && browserPriceNum !== server.first_total && (
          (displayedTestWindow !== undefined && displayedTestWindow !== cutScale) || staleTestPrice
        )) {
          return json(409, { ok: false, errors: { price: "Prices have changed. Review the updated total before sending your request." } });
        }
        if (!Number.isFinite(browserPriceNum) || browserPriceNum !== server.first_total) {
          logErr(
            "price_mismatch",
            `browser $${Number.isFinite(browserPriceNum) ? browserPriceNum : "?"} != server $${server.first_total}; replaced`
          );
          tokenPrice = String(server.first_total);
        }
        if (parsed.data.frequency !== "onetime") tokenRecurring = String(server.recurring_total);
        serverFirst = String(server.first_total);
        serverRecurring = tokenRecurring;
      }
      const forceNewBooking = parsed.data.force_new_booking === true;
      const signed = signBooking(bookingLinkSecret(signingSecret), {
        email: (email ?? "").trim(),
        name: (name ?? "").trim(),
        first: tokenPrice,
        recurring: tokenRecurring,
        service: (service ?? "").trim() || undefined,
        date: (date ?? "").trim() || undefined,
        // An explicit second visit bypasses the request_id dedup too:
        // a fresh random bid makes it a fully independent booking.
        bid: forceNewBooking
          ? undefined
          : parsed.data.request_id
            ? bidFromRequestId(parsed.data.request_id)
            : undefined,
      });
      bookingToken = signed.token;
      bookingId = signed.bid;
      // Visit record (database): one row per visit, created with the
      // booking so the cleaner/owner pipeline has its anchor from the
      // start. Best-effort — a DB hiccup never fails the booking.
      if (dbConfigured()) {
        try {
          const actualService = parsed.data.service_key === "moveinout" ? "Move-in / Move-out cleaning" : server?.first_service === "deep" ? "Deep cleaning" : (service ?? "Standard cleaning");
          // L2: the duplicate answer, shared by the pre-insert check
          // and the post-insert race re-check below — same bid, a
          // fresh link token, the same server-verified totals. No new
          // row, no new journal events, no emails: the original
          // submission already sent the confirmation (so
          // customerEmailSent is true: the client has it).
          const duplicateBody = (duplicateRow: VisitDedupRow) => {
            const dupSigned = signBooking(bookingLinkSecret(signingSecret), {
              email: (duplicateRow.client_email ?? "").trim(),
              name: (duplicateRow.client_name ?? "").trim(),
              first: duplicateRow.amount_cents != null
                ? String(duplicateRow.amount_cents / 100)
                : tokenPrice,
              recurring: tokenRecurring,
              service: (duplicateRow.service ?? "").trim() || undefined,
              date: (duplicateRow.visit_date ?? "").trim() || undefined,
              bid: duplicateRow.booking_id,
            });
            log("booking_duplicate", { bid: duplicateRow.booking_id });
            return {
              ok: true,
              success: true,
              customerEmailSent: true,
              duplicate: true,
              ...(serverFirst ? { server_first: serverFirst } : {}),
              ...(serverRecurring ? { server_recurring: serverRecurring } : {}),
              booking_id: duplicateRow.booking_id,
              bt: dupSigned.token,
            };
          };
          const rooms = buildWorkRooms({ bedrooms, fullBaths: parsed.data.full_baths ?? bathrooms, halfBaths: parsed.data.half_baths, extraZones: extra_zones, deep: server?.first_service === "deep", addons: parsed.data.addons });
          // M6/N-upsert: insert-only, never merge. A retried or
          // concurrent submission reproduces the same booking id by
          // design — it must never regress a visit that has already
          // advanced, and must never change its pinned amount.
          // The old read-then-merge-upsert lost the race: two
          // concurrent submissions both read "no row" and the second
          // merge overwrote the first row's amount/status. Now the
          // unique constraint decides: the insert winner owns the
          // row, the loser re-reads it unchanged (409 → select).
          const existingRows = await dbSelect<{ id: string }>(
            "gh_visits",
            `booking_id=eq.${encodeURIComponent(bookingId ?? "")}&visit_no=eq.1&limit=1`,
          );
          let visitRow = existingRows[0] ?? null;
          let createdByThisCall = false;
          if (!visitRow) {
            // Natural-key dedup (L2): the bid above is new (fresh
            // request_id — a new tab or browser), but the booking itself
            // may already exist. An identical booking created within the
            // window is the same request, not a second visit: return it
            // instead of inserting a duplicate row. Skipped for an
            // explicit second visit (force_new_booking).
            const naturalKey: NaturalBookingKey = {
              email: (email ?? "").trim().toLowerCase(),
              date: (date ?? "").trim(),
              service: actualService,
              address: (address ?? "").trim().toLowerCase(),
              window: (time ?? "").trim(),
              amountCents: serverFirst ? Math.round(parseFloat(serverFirst) * 100) : null,
            };
            if (!forceNewBooking) {
              // The same-date scan is capped at 200 rows: on a busy
              // day more than 50 same-date bookings would push the
              // true duplicate out of the old limit=50 window and let
              // a resubmission through.
              const dupCheck = await dbSelectStrict<VisitDedupRow>(
                "gh_visits",
                `visit_date=eq.${encodeURIComponent((date ?? "").trim())}&order=created_at.desc&limit=200`,
              );
              if (!dupCheck.ok) {
                logErr("dedup_read", "could not check for an existing identical booking");
                return json(503, { ok: false, error: "booking_save_failed" });
              }
              const duplicateRow = dupCheck.rows.find((row) => isNaturalDuplicate(naturalKey, row));
              if (duplicateRow && duplicateRow.booking_id) {
                return json(200, duplicateBody(duplicateRow));
              }
            }
            const inserted = await dbInsert<{ id: string }>("gh_visits", {
              booking_id: bookingId,
              visit_no: 1,
              client_name: (name ?? "").trim() || null,
              client_email: (email ?? "").trim() || null,
              service: actualService,
              visit_date: /^\d{4}-\d{2}-\d{2}$/.test((date ?? "").trim()) ? (date as string).trim() : null,
              window: (time ?? "").trim() || null,
              address: (address ?? "").trim() || null,
              entry_method: entry_method ?? null,
              entry_detail: entry_method === "arrange_before" ? entry_detail ?? null : null,
              entry_notes: (entry_notes ?? "").trim() || null,
              // Entry instructions are NOT collected at booking (spec A §4):
              // a value sent by an old cached page is dropped here, never
              // stored in the row, Stripe metadata, or email.
              access_notes: null,
              amount_cents: serverFirst ? Math.round(parseFloat(serverFirst) * 100) : null,
              checklist: { rooms },
              status: "requested",
              is_test: testScale || cutScale || /\b(qa|test|probe)\b|прогон|провер|тест/i.test(name ?? ""),
            });
            if (inserted) {
              visitRow = inserted;
              createdByThisCall = true;
            } else {
              // Lost the insert race (or the row appeared between the
              // select and the insert): re-read the winner unchanged.
              const reread = await dbSelect<{ id: string }>(
                "gh_visits",
                `booking_id=eq.${encodeURIComponent(bookingId ?? "")}&visit_no=eq.1&limit=1`,
              );
              visitRow = reread[0] ?? null;
            }
            // L2: close the check-then-act race — two identical
            // submissions with different request_ids can both pass the
            // pre-insert check (neither row exists yet) and both
            // insert. Re-check now: if an EARLIER identical row
            // exists, this call's row is the duplicate — delete it
            // (no journal events or emails exist for it yet; those are
            // logged after this block) and return the earlier booking.
            // A failed re-check fails OPEN: the booking already exists
            // and must not fail on a read error.
            if (createdByThisCall && !forceNewBooking && visitRow) {
              const recheck = await dbSelectStrict<VisitDedupRow>(
                "gh_visits",
                `visit_date=eq.${encodeURIComponent((date ?? "").trim())}&order=created_at.desc&limit=200`,
              );
              if (recheck.ok) {
                const mineCreatedAt = (visitRow as { created_at?: string }).created_at ?? "";
                const earlier = recheck.rows
                  .filter((row) => row.booking_id !== bookingId)
                  .find((row) => isNaturalDuplicate(naturalKey, row)
                    && ((row.created_at ?? "") < mineCreatedAt
                      || ((row.created_at ?? "") === mineCreatedAt
                        && (row.booking_id ?? "") < (bookingId ?? ""))));
                if (earlier && earlier.booking_id) {
                  await dbDelete("gh_visits", `id=eq.${visitRow.id}`);
                  log("booking_duplicate_race", { kept: earlier.booking_id, dropped: bookingId ?? "" });
                  return json(200, duplicateBody(earlier));
                }
              }
            }
          }
          if (!visitRow) return json(503, { ok: false, error: "booking_save_failed" });
          if (visitRow) {
            visitRowId = visitRow.id;
            // Keep contact with this visit. Older versions only put the phone
            // in the owner email, so neither private portal could read it.
            const contactPhone = (phone ?? "").replace(/\D/g, "");
            if (contactPhone) {
              const contacts = await dbSelect("gh_events", `visit_id=eq.${visitRow.id}&event=eq.client_contact&limit=1`);
              if (contacts.length === 0) {
                const saved = await dbInsert("gh_events", { visit_id: visitRow.id, booking_id: bookingId, actor: "client", event: "client_contact", detail: { phone: contactPhone } });
                if (!saved) return json(503, { ok: false, error: "contact_save_failed" });
              }
            }
            if (createdByThisCall) {
              // Single pricing record for the booking (§5/§7): the server
              // breakdown's first_service is what every surface must show
              // ("First visit: Deep clean" vs plain Standard), not the
              // form's service label alone.
              await logEvent(visitRow.id, bookingId, "system", "visit_created", {
                service: service ?? null,
                first_service: server ? server.first_service : null,
                first_total: server ? server.first_total : null,
                recurring_total: server ? server.recurring_total : null,
              });
            }
            // Customer comments live in the journal, separate from access
            // instructions — the old build stuffed the whole composed
            // request message (summary + consent record) into access_notes.
            // Guarded like client_contact: a retry after a lost response
            // must not journal the same note twice.
            const noteText = (notes ?? "").trim();
            if (noteText) {
              const existingNotes = await dbSelect("gh_events", `visit_id=eq.${visitRow.id}&event=eq.client_note&limit=1`);
              if (existingNotes.length === 0) {
                await logEvent(visitRow.id, bookingId, "client", "client_note", { text: noteText.slice(0, 1000) });
              }
            }
            // Scope review is an internal flag with reasons; it is persisted
            // here so owner and customer surfaces read the same state.
            // Same retry guard as client_note.
            if (scope_review) {
              const existingScope = await dbSelect("gh_events", `visit_id=eq.${visitRow.id}&event=eq.scope_review&limit=1`);
              if (existingScope.length === 0) {
                await logEvent(visitRow.id, bookingId, "system", "scope_review", {
                  reasons: (scope_reasons ?? "").slice(0, 300),
                });
              }
            }
          }
        } catch (err) {
          logErr("visit_row", err instanceof Error ? err.message : String(err));
          return json(503, { ok: false, error: "booking_save_failed" });
        }
      }
      saveCardUrl = `https://www.gatehousehomecleaning.com/save-card?bt=${encodeURIComponent(bookingToken)}`;
      visitUrl = `https://www.gatehousehomecleaning.com/visit?bt=${encodeURIComponent(bookingToken)}`;
      log("booking", { bid: bookingId });
    }

    const entryMethodLabel = (method: string, detail?: string): string => {
      const base = ({
        home: "I'll be home to let the cleaner in",
        other_person: "Someone else will let the cleaner in",
        arrange_before: "I'll arrange entry before the visit",
        decide_later: "I'll decide later — please contact me",
      } as Record<string, string>)[method] ?? method;
      if (method === "arrange_before" && detail) {
        const d = ({ door_code: "Door code / smart lock", lockbox: "Lockbox", other: "Other arrangement" } as Record<string, string>)[detail];
        return d ? `${base} (${d})` : base;
      }
      return base;
    };
    const row = (label: string, value: string) =>
      `<tr><td style="padding: 8px 0; font-weight: bold; color: #555;">${label}:</td><td style="padding: 8px 0;">${value}</td></tr>`;

    // C20: no one-click owner login in routine request emails — a
    // forwarded/leaked inbox message used to carry a 24h panel token.
    // The owner enters the panel with the "Send login link" button in
    // /owner itself (POST /api/owner-auth { action: "send" }).
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background:${testScale || cutScale ? "#FFF4E5" : "#F4F4F4"};border-left:6px solid ${testScale || cutScale ? "#D4855A" : "#999"};padding:14px 18px;margin-bottom:18px;border-radius:6px;font-size:16px;font-weight:bold;color:${testScale || cutScale ? "#8B4513" : "#444"};">
          ${isQuote ? (testScale || cutScale ? "TEST BOOKING — owner price test at reduced test prices" : "CLEANING REQUEST — Verify estimate before confirming") : "GENERAL INQUIRY"}
        </div>
        <h2 style="color: #8B5E3C; border-bottom: 2px solid #D4A853; padding-bottom: 10px;">
          ${isQuote ? "New Cleaning Request" : "New General Inquiry"} from ${escapeHtml(name)}
        </h2>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
          <tr><td style="padding: 8px 0; font-weight: bold; color: #555;">Name:</td><td style="padding: 8px 0;">${escapeHtml(name)}</td></tr>
          ${phone ? row("Phone", escapeHtml(phone)) : ""}
          ${email ? row("Email", escapeHtml(email)) : ""}
          ${service ? row("Service Type", escapeHtml(service)) : ""}
          ${zip ? row("ZIP", escapeHtml(zip)) : ""}
          ${address ? row("Street address", escapeHtml(address)) : ""}
          ${city ? row("City", escapeHtml(city)) : ""}
          ${entry_method ? row("Entry", escapeHtml(entryMethodLabel(entry_method, entry_detail))) : ""}
          ${entry_notes ? row("Entry notes (parking/building)", escapeHtml(entry_notes)) : ""}
          ${bedrooms ? row("Bedrooms", escapeHtml(bedrooms)) : ""}
          ${bathrooms ? row("Bathrooms", escapeHtml(bathrooms)) : ""}
          ${parsed.data.half_baths ? row("Half bathrooms", escapeHtml(parsed.data.half_baths)) : ""}
          ${serverFirst ? row("Server-verified estimate", `$${escapeHtml(serverFirst)}`) : price ? row("Client-side estimate — verify", `$${escapeHtml(price)}`) : ""}
          ${serverFirst && price && parseFloat(String(price).replace(/[^0-9.]/g, "")) !== parseFloat(serverFirst) ? row("Browser showed (replaced)", `$${escapeHtml(price)} — the browser tab priced differently; the server price above is the one that counts`) : ""}
          ${date ? row("Preferred Date", escapeHtml(date)) : ""}
          ${time ? row("Preferred Time", escapeHtml(time)) : ""}
          ${message ? row("Notes from client", escapeHtml(message).replace(/\n/g, "<br>")) : ""}
          ${notes ? row("Customer notes (client)", escapeHtml(notes).replace(/\n/g, "<br>")) : ""}
${isQuote ? row("Test price mode (reduced)", testScale || cutScale ? "YES" : "NO") : ""}
${isQuote && extra_zones ? row("Extra areas to clean", escapeHtml(extra_zones)) : ""}
${isQuote && scope_review ? row("Scope review", `YES — ${escapeHtml(scope_reasons || "check scope")}. Agree the scope (and any price change) with the client BEFORE confirming the visit.`) : ""}
          ${Object.entries(parsed.data.attribution || {}).map(([key, value]) => value ? row(key, escapeHtml(value)) : "").join("")}
        </table>
        ${emailButton("https://www.gatehousehomecleaning.com/owner", "Open request")}
        <p style="margin-top: 24px; font-size: 12px; color: #999;">Sent from Gatehouse Home Cleaning website contact form${bookingId ? ` · Booking ID: ${bookingId}` : ""}</p>
      </div>
    `;

    // Owner notification: EVERY new request gets one — including online
    // quote bookings. The old gate skipped quotes with a visit row on
    // the assumption that the "card ready" email would follow, but a
    // quote whose client never saves a card then notified the owner
    // never: the request sat in /owner as "Needs attention" while the
    // client waited for a confirmation nobody processed (extension bug
    // #4, "Test Client" 2026-11-20). The card-ready email
    // (notifyOwnerCardReady) still follows separately once a card is on
    // file — it is a different message ("ready to schedule"), not a
    // duplicate of this one.
    //
    // Idempotency by booking: a retry after a lost response must not
    // send a second owner email. The journal decides — Resend's
    // Idempotency-Key (owner/<request_id>) only dedupes identical
    // request_ids; a new tab gets a fresh one.
    //
    // Failure: a booking with a saved visit row survives a failed
    // notification — the failure is journaled (owner_notification_failed,
    // visible in /owner Activity with a resend action) and the submission
    // still succeeds. Failing the whole submission would tell the client
    // their request failed when it did not. Without a visit row (general
    // inquiry) the email IS the record, so a failed send still fails the
    // submission.
    let ownerEmailSent = false;
    {
      let alreadyNotified = false;
      if (visitRowId) {
        const prior = await dbSelect<{ id: string }>(
          "gh_events",
          `visit_id=eq.${encodeURIComponent(visitRowId)}&event=eq.owner_notification&limit=1`,
        );
        alreadyNotified = prior.length > 0;
      }
      if (alreadyNotified) {
        log("owner_notification", "already_sent");
      } else {
        try {
          const sent = await sendEmail(RESEND_API_KEY, {
            from: FROM_OWNER,
            to: [ownerNotificationEmail()],
            reply_to: email || undefined,
            subject: `${isQuote ? "New quote request" : "New general inquiry"} — ${name}${zip ? `, ${zip}` : ""}`,
            html: htmlContent,
            text: htmlContent.replace(/<\/tr>/g, "\n").replace(/<\/td>/g, " ").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'),
          }, parsed.data.request_id ? `owner/${parsed.data.request_id}` : undefined);
          if (!sent.ok) {
            logErr("owner_notification", `provider ${sent.status}: ${sent.data?.name ?? ""} ${sent.data?.message ?? ""}`);
            if (visitRowId) {
              await logEvent(visitRowId, bookingId, "system", "owner_notification_failed", {
                status: sent.status,
                error: sent.data?.message ?? sent.data?.name ?? "provider_error",
              });
            } else {
              return json(500, { ok: false, error: "server_error" });
            }
          } else {
            ownerEmailSent = true;
            log("owner_notification", "sent");
            if (visitRowId) {
              await logEvent(visitRowId, bookingId, "system", "owner_notification", {
                email_id: (sent.data as unknown as { id?: string })?.id ?? null,
              });
            }
          }
        } catch (err) {
          logErr("owner_notification", err);
          if (visitRowId) {
            await logEvent(visitRowId, bookingId, "system", "owner_notification_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          } else {
            return json(500, { ok: false, error: "server_error" });
          }
        }
      }
    }

    // Step: client autoresponse (errors surface intentionally)
    const emailValid = !!email && EMAIL_RE.test(email);
    let customerEmailSent = false;
    if (emailValid) {
      try {
        const firstName = firstNameOf(name);

        // Only old calculator pages submit a cleaning-history flag.
        const cleanedRecently = parsed.data.cleaned_recently !== false;

        // Home details and service label for the customer.
        const firstVisitDeep = (parsed.data.service_key === "standard" || service === "Standard") && !cleanedRecently;
        const serviceLabel = firstVisitDeep ? "First visit: Deep clean" : (service || "Standard");
        const deepPara = firstVisitDeep
          ? `\nBecause the home hasn't been professionally cleaned in the last 3 months, the first visit is a deep clean. Regular visits after that cost less.\n`
          : "";
        const fmtUsd = (v: string): string => {
          const n = parseFloat(v);
          return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${v}`;
        };
        const priceDisplay = serverFirst ? fmtUsd(serverFirst) : price ? fmtUsd(price) : "—";
        const testNote = testScale || cutScale ? "\nThis is a test booking at reduced test prices for an owner payment check.\n" : "";
        // Equal first and recurring prices collapse into one line — "$189 for
        // the first visit, then $189 per visit" reads like a typo.
        const sameVisitPrice = !!serverRecurring && !!serverFirst && serverFirst === serverRecurring && !firstVisitDeep;
        const recurringDisplay = serverRecurring && !sameVisitPrice ? `, then ${fmtUsd(serverRecurring)} per visit` : "";

        // Does this customer already have a card on file with Stripe? A
        // returning customer must not be told to "save your card to
        // continue" — their request email is the card-saved confirmation
        // for THIS booking instead.
        let cardOnFile = false;
        if (isQuote) {
          try {
            const sk = process.env["STRIPE_SECRET_KEY"];
            if (sk) {
              const q = new URLSearchParams({ query: `email:"${(email ?? "").replace(/"/g, "")}"`, limit: "1" });
              const sr = await fetch(`https://api.stripe.com/v1/customers/search?${q}`, {
                headers: { Authorization: `Bearer ${sk}` },
                signal: AbortSignal.timeout(10000),
              });
              if (sr.ok) {
                const sd = (await sr.json()) as { data?: { id: string; email?: string }[] };
                // C13: the search can return a near-matching email —
                // only use the record whose email matches exactly.
                // (Display hint only: which save-card email variant to send.)
                const cid = sd.data?.find((c) => typeof c.email === "string"
                  && c.email.trim().toLowerCase() === (email ?? "").trim().toLowerCase())?.id;
                if (cid) {
                  const pr = await fetch(`https://api.stripe.com/v1/customers/${cid}/payment_methods?type=card&limit=1`, {
                    headers: { Authorization: `Bearer ${sk}` },
                    signal: AbortSignal.timeout(10000),
                  });
                  if (pr.ok) {
                    const pd = (await pr.json()) as { data?: unknown[] };
                    cardOnFile = (pd.data?.length ?? 0) > 0;
                  }
                }
              }
            }
          } catch { /* lookup is best-effort; the save-card email variant stays the default */ }
        }
        const deadline = confirmDeadlineLabel();
        const scopeNote = scope_review
          ? "One note: we may check a couple of scope details with you before confirming. The quoted price above won't change unless you agree to a change."
          : "";
        const hasPrice = Boolean(serverFirst || price);
        const requestLines =
          `Requested date: ${date ? emailDate(date) : "To be confirmed"}\nArrival preference: ${emailArrivalWindow(time || "flexible")}\nService: ${serviceLabel}\nFrequency: ${parsed.data.frequency === "onetime" ? "One-time" : "Every other week"}\n\n${hasPrice
            ? `Quoted price: ${priceDisplay}${sameVisitPrice ? " per visit" : " for the first visit"}${recurringDisplay}.`
            : "Price: we'll confirm the exact price together with your visit confirmation — nothing is charged until after your cleaning."}`;
        const action = {
          url: cardOnFile
            ? visitUrl ?? "https://www.gatehousehomecleaning.com/visit"
            : saveCardUrl ?? "https://www.gatehousehomecleaning.com/save-card",
          label: cardOnFile ? "Choose my card — $0 today" : "Save my card — $0 today",
        };
        const heading = "Cleaning request received";
        const nextStep = cardOnFile
          ? "Choose a card for this visit. $0 is charged today."
          : "Save a card securely through Stripe to complete your request. $0 is charged today.";
        const payment = "After cleaning, approve your photo report to pay. Your card is charged automatically 24 hours after we send the report unless you approve or report an issue. Reporting an issue stops automatic payment, and closing the issue does not restart it.";
        const paragraphs = [
          nextStep,
          requestLines,
          `Once your card is ready, we’ll email you an update on your date, arrival window and cleaner by ${deadline}.`,
          scopeNote,
          testNote.trim(),
          deepPara.trim(),
          payment,
        ].filter(Boolean);
        const textBody = !isQuote
          ? `Hi ${firstName},\n\nThanks for your question. We’ll reply within one business day. This is a general inquiry, not a booking request.\n\nGatehouse Home Cleaning`
          : `Hi ${firstName},\n\n${heading}\n\n${nextStep}\n\n${action.label}: ${action.url}\n\n${paragraphs.slice(1).join("\n\n")}\n\nGatehouse Home Cleaning`;
        const htmlBody = isQuote ? emailDocument({ firstName, heading, paragraphs, action }) : undefined;

        const auto = await sendEmail(RESEND_API_KEY, {
          from: FROM_AUTO,
          to: [email],
          reply_to: REPLY_TO_AUTO,
          subject: !isQuote ? "Got your question — we’ll reply within one business day" : cardOnFile ? "Request received — confirm your card" : "Request received — save your card to continue",
          text: textBody,
          ...(htmlBody ? { html: htmlBody } : {}),
        }, parsed.data.request_id ? `customer/${parsed.data.request_id}` : undefined);
        // §3: the request email no longer claims "Card saved" — the
        // card_saved_email event is journaled only by the explicit
        // confirm_card action or a verified Checkout save.
        if (auto.ok) {
          customerEmailSent = true;
          log("customer_confirmation", "sent");
        } else {
          logErr("customer_confirmation", `provider ${auto.status}: ${auto.data.name ?? ""} ${auto.data.message ?? ""}`);
        }
      } catch (err) {
        logErr("customer_confirmation", err);
      }
    } else {
      log("customer_confirmation", "skipped_no_email");
    }

    // N23: the response carries the server-verified totals, so the
    // client never learns a replaced price only from the email or the
    // save-card step. The browser price is still never trusted for the
    // signed token — only the values are now visible to the caller.
    return json(200, {
      ok: true,
      success: true,
      customerEmailSent,
      ownerEmailSent,
      ...(serverFirst ? { server_first: serverFirst } : {}),
      ...(serverRecurring ? { server_recurring: serverRecurring } : {}),
      ...(bookingId ? { booking_id: bookingId } : {}),
      ...(bookingToken ? { bt: bookingToken } : {}),
    });
  } catch (error: unknown) {
    logErr("unexpected", error);
    return json(500, { ok: false, error: "server_error" });
  }
}
