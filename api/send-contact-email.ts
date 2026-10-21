import { z } from "zod";
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
// Owner decision: how the founding discount treats a deep first visit.
// "full" (default) = full deep-clean price; discount applies to recurring only.
// Must match FOUNDING_DEEP_RULE in src/config/calculator.ts.
export const SERVER_FOUNDING_DEEP_RULE = "full";
export function serverBreakdown(opts: {
  bedroomsRaw: string | undefined;
  bathroomsRaw: string | undefined;
  serviceKey: string | undefined;
  frequency: string | undefined;
  founding: boolean | undefined;
  cleanedRecently: boolean | undefined;
  addons: ServerAddonSel;
}): { first_total: number; recurring_total: number; first_service: "deep" | "standard" } | null {
  const bedrooms = parseInt(opts.bedroomsRaw ?? "", 10);
  const fullBaths = parseInt((opts.bathroomsRaw ?? "").split(".")[0], 10);
  const tier = serverTierFor(bedrooms, fullBaths);
  if (!tier) return null;
  const serviceKey = opts.serviceKey ?? "standard";
  // Deep / move-in-out are one-time; founding never applies to them.
  if (serviceKey === "deep" || serviceKey === "moveinout") {
    const base = SERVER_PRICES[serviceKey][tier];
    const total = base + serverAddonsTotal(opts.addons, serviceKey);
    return { first_total: total, recurring_total: total, first_service: "deep" };
  }
  const deepFirst = !(opts.cleanedRecently ?? true);
  const first_service: "deep" | "standard" = deepFirst ? "deep" : "standard";
  const recurringBase = SERVER_PRICES.recurring[tier];
  const recurring_total = recurringBase + serverAddonsTotal(opts.addons, "standard");
  if (!opts.founding) {
    // One-time visits price from the one-time table; recurring plans price
    // the first visit at the recurring rate (or deep when needed).
    const standardBase =
      opts.frequency === "onetime" ? SERVER_PRICES.standardOnetime[tier] : SERVER_PRICES.recurring[tier];
    const base = deepFirst ? SERVER_PRICES.deep[tier] : standardBase;
    return {
      first_total: base + serverAddonsTotal(opts.addons, first_service),
      recurring_total,
      first_service,
    };
  }
  const foundingRecurringBase = Math.round(recurringBase * 0.7);
  const founding_recurring = foundingRecurringBase + serverAddonsTotal(opts.addons, "standard");
  if (!deepFirst) {
    const foundingFirstBase = Math.round(SERVER_PRICES.standardOnetime[tier] * 0.7);
    return {
      first_total: foundingFirstBase + serverAddonsTotal(opts.addons, "standard"),
      recurring_total: founding_recurring,
      first_service,
    };
  }
  if (SERVER_FOUNDING_DEEP_RULE === "discounted") {
    const discountedDeep = Math.round(SERVER_PRICES.deep[tier] * 0.7);
    return {
      first_total: discountedDeep + serverAddonsTotal(opts.addons, "deep"),
      recurring_total: founding_recurring,
      first_service,
    };
  }
  if (SERVER_FOUNDING_DEEP_RULE === "flat") {
    const foundingFirstBase = Math.round(SERVER_PRICES.standardOnetime[tier] * 0.7);
    return {
      first_total: foundingFirstBase + serverAddonsTotal(opts.addons, "deep"),
      recurring_total: founding_recurring,
      first_service,
    };
  }
  // "full": full deep-clean price for a founding deep first visit.
  return {
    first_total: SERVER_PRICES.deep[tier] + serverAddonsTotal(opts.addons, "deep"),
    recurring_total: founding_recurring,
    first_service,
  };
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
): { ok: true; payload: BookingPayload } | { ok: false; reason: string } {
  let payload: BookingPayload | null = null;
  let ttl = TOKEN_TTL_SECONDS;
  if (token.startsWith("v2.")) {
    payload = decryptBookingPayload(secret, token);
    if (!payload) return { ok: false, reason: "bad_token" };
    ttl = TOKEN_TTL_V2_SECONDS;
  } else {
    // Legacy v1: HMAC-signed readable payload.
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
const OWNER_EMAIL = "nikolajmihasenok@gmail.com";
const FROM_OWNER = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const FROM_AUTO = "Nick at Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
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
  founding: z.boolean().optional(),
  extra_zones: z.string().max(200).optional(),
  scope_review: z.boolean().optional(),
  scope_reasons: z.string().max(300).optional(),
  bedrooms: z.string().max(20).optional().or(z.literal("")),
  bathrooms: z.string().max(20).optional().or(z.literal("")),
  zip: z.string().max(20).optional().or(z.literal("")),
  address: z.string().max(200).optional().or(z.literal("")),
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
      founding,
      extra_zones,
      scope_review,
      scope_reasons,
      bedrooms,
      bathrooms,
      zip,
      address,
      price,
    } = parsed.data;

    const isQuote = parsed.data.source === "quote";

    // Server-issued booking identity (quote bookings only). The HMAC-signed
    // token binds this booking to the card-saving step (/save-card?bt=...)
    // without a database. Signed with STRIPE_SECRET_KEY (inlined below, stateless).
    let bookingToken: string | null = null;
    let bookingId: string | null = null;
    let saveCardUrl: string | null = null;
    let visitUrl: string | null = null;
    // Server-verified first-visit price (recomputed, never the browser value).
    let serverFirst: string | undefined;
    let serverRecurring: string | undefined;
    if (isQuote) {
      const signingSecret = process.env["STRIPE_SECRET_KEY"];
      if (!signingSecret) {
        logErr("config", "STRIPE_SECRET_KEY is not configured (needed for booking token)");
        return json(500, { ok: false, error: "server_error" });
      }
      // Server-side price verification: recompute the EXACT breakdown from
      // the quote inputs (bedrooms, bathrooms, service, frequency, founding,
      // cleaning history, add-ons). The browser-sent price is never trusted
      // for the signed token: any mismatch is replaced and logged (tamper
      // attempt or stale calculator).
      const server = serverBreakdown({
        bedroomsRaw: bedrooms,
        bathroomsRaw: bathrooms,
        serviceKey: parsed.data.service_key,
        frequency: parsed.data.frequency,
        founding,
        cleanedRecently: parsed.data.cleaned_recently,
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
      const signed = signBooking(bookingLinkSecret(signingSecret), {
        email: (email ?? "").trim(),
        name: (name ?? "").trim(),
        first: tokenPrice,
        recurring: tokenRecurring,
        service: (service ?? "").trim() || undefined,
        date: (date ?? "").trim() || undefined,
        bid: parsed.data.request_id ? bidFromRequestId(parsed.data.request_id) : undefined,
      });
      bookingToken = signed.token;
      bookingId = signed.bid;
      saveCardUrl = `https://www.gatehousehomecleaning.com/save-card?bt=${encodeURIComponent(bookingToken)}`;
      visitUrl = `https://www.gatehousehomecleaning.com/visit?bt=${encodeURIComponent(bookingToken)}`;
      log("booking", { bid: bookingId });
    }

    const row = (label: string, value: string) =>
      `<tr><td style="padding: 8px 0; font-weight: bold; color: #555;">${label}:</td><td style="padding: 8px 0;">${value}</td></tr>`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background:${founding ? "#FFF4E5" : "#F4F4F4"};border-left:6px solid ${founding ? "#D4855A" : "#999"};padding:14px 18px;margin-bottom:18px;border-radius:6px;font-size:16px;font-weight:bold;color:${founding ? "#8B4513" : "#444"};">
          ${isQuote ? (founding ? "FOUNDING CLIENT REQUEST — Verify offer eligibility before confirming" : "CLEANING REQUEST — Verify estimate before confirming") : "GENERAL INQUIRY"}
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
          ${bedrooms ? row("Bedrooms", escapeHtml(bedrooms)) : ""}
          ${bathrooms ? row("Bathrooms", escapeHtml(bathrooms)) : ""}
          ${price ? row("Client-side estimate — verify", `$${escapeHtml(price)}`) : ""}
          ${date ? row("Preferred Date", escapeHtml(date)) : ""}
          ${time ? row("Preferred Time", escapeHtml(time)) : ""}
          ${message ? row("Notes from client", escapeHtml(message).replace(/\n/g, "<br>")) : ""}
${isQuote ? row("First-clean discount requested", founding ? "YES" : "NO") : ""}
${isQuote && extra_zones ? row("Extra areas to clean", extra_zones) : ""}
${isQuote && scope_review ? row("Scope review", `YES — ${scope_reasons || "check scope"}. Agree the scope (and any price change) with the client BEFORE confirming the visit.`) : ""}
          ${Object.entries(parsed.data.attribution || {}).map(([key, value]) => value ? row(key, escapeHtml(value)) : "").join("")}
        </table>
        <p style="margin-top: 24px; font-size: 12px; color: #999;">Sent from Gatehouse Home Cleaning website contact form${bookingId ? ` · Booking ID: ${bookingId}` : ""}</p>
      </div>
    `;

    // Step: owner notification (no database table exists; the owner email is the record)
    try {
      const sent = await sendEmail(RESEND_API_KEY, {
        from: FROM_OWNER,
        to: [OWNER_EMAIL],
        reply_to: email || undefined,
        subject: `${isQuote ? "New quote request" : "New general inquiry"} — ${name}${zip ? `, ${zip}` : ""}`,
        html: htmlContent,
      }, parsed.data.request_id ? `owner/${parsed.data.request_id}` : undefined);
      if (!sent.ok) {
        logErr("owner_notification", `provider ${sent.status}: ${sent.data?.name ?? ""} ${sent.data?.message ?? ""}`);
        return json(500, { ok: false, error: "server_error" });
      }
      log("owner_notification", "sent");
    } catch (err) {
      logErr("owner_notification", err);
      return json(500, { ok: false, error: "server_error" });
    }

    // Step: client autoresponse (errors surface intentionally)
    const emailValid = !!email && EMAIL_RE.test(email);
    let customerEmailSent = false;
    if (emailValid) {
      try {
        const firstName = firstNameOf(name);

        // Parse "Professionally cleaned in last 3 months: Yes/No" from the message summary.
        const cleanedMatch = /Professionally cleaned in last 3 months:\s*(Yes|No)/i.exec(message || "");
        const cleanedRecently = cleanedMatch ? cleanedMatch[1].toLowerCase() === "yes" : true;

        // Home details and service label for the customer.
        const baths = bathrooms ? String(bathrooms).replace(/\.0$/, "") : "";
        const homeDetails = `${bedrooms || "?"} bed / ${baths || "?"} bath`;
        const firstVisitDeep = service === "Standard" && !cleanedRecently;
        const serviceLabel = firstVisitDeep ? "First visit: Deep clean" : (service || "Standard");
        const deepPara = firstVisitDeep
          ? `\nBecause the home hasn't been professionally cleaned in the last 3 months, the first visit is a deep clean. Regular visits after that cost less.\n`
          : "";
        const priceDisplay = serverFirst ? `$${serverFirst}` : price ? `$${price}` : "—";
        // Equal first and recurring prices collapse into one line — "$189 for
        // the first visit, then $189 per visit" reads like a typo.
        const sameVisitPrice = !!serverRecurring && !!serverFirst && serverFirst === serverRecurring && !firstVisitDeep;
        const recurringDisplay = serverRecurring && !sameVisitPrice ? `, then $${serverRecurring} per visit` : "";

        const textBody = isQuote ? `Hi ${firstName},

Thanks for your request — it isn't a confirmed booking yet.

Next step: save your card to continue. Saving a card doesn't charge you anything — $0 today, and we never see your card number (Stripe handles it securely). We ask for it now so your date can be confirmed — and so you pay only after the visit, once you've seen the photo report:
${saveCardUrl ?? "https://www.gatehousehomecleaning.com/save-card"}

After that, your visit page is where everything lives — status, your cleaner, reschedule or cancel without refilling forms:
${visitUrl ?? "https://www.gatehousehomecleaning.com/visit"}

Your request:

${homeDetails} · ZIP ${zip || ""}

Service: ${serviceLabel}

Your estimate: ${priceDisplay}${sameVisitPrice ? " per visit" : " for the first visit"}${recurringDisplay}.
${deepPara}
I'll confirm your estimate, date and arrival window by the end of the next business day. Your final confirmation comes in a separate email.

How payment works:

After the clean, you get a photo report of every room. Your card is charged when you approve the report, or automatically 24 hours after we send it if you haven't reported an issue. If the report email doesn't reach you, we pause and check manually — silence never triggers a charge you weren't told about.

Something wrong with the visit? Reply to the report email within 24 hours — or write to hello@gatehousehomecleaning.com — and the charge stays paused until we fix it.

If something on our checklist gets missed, we come back within 72 hours and fix it at no charge.

Nick

Gatehouse Home Cleaning

hello@gatehousehomecleaning.com` : `Hi ${firstName},

Thanks for your question. I received your message and will reply within one business day. This is a general inquiry, not a booking request.

Nick
Gatehouse Home Cleaning
hello@gatehousehomecleaning.com`;

        const auto = await sendEmail(RESEND_API_KEY, {
          from: FROM_AUTO,
          to: [email],
          reply_to: REPLY_TO_AUTO,
          subject: isQuote ? "Request received — save your card to continue" : "Got your question — I’ll reply within one business day",
          text: textBody,
        }, parsed.data.request_id ? `customer/${parsed.data.request_id}` : undefined);
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

    return json(200, {
      ok: true,
      success: true,
      customerEmailSent,
      ...(bookingId ? { booking_id: bookingId } : {}),
      ...(bookingToken ? { bt: bookingToken } : {}),
    });
  } catch (error: unknown) {
    logErr("unexpected", error);
    return json(500, { ok: false, error: "server_error" });
  }
}
