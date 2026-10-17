// Shared booking-token helpers for Gatehouse serverless functions.
// Stateless: no database. Booking identity is an HMAC-signed token.
//
// Token format: base64url(payload) + "." + base64url(signature)
// payload = JSON { bid, email, name, ts, first, recurring, service, date }
// signature = HMAC-SHA256(signingSecret, payloadB64)
//
// The signing secret is STRIPE_SECRET_KEY (already a high-entropy server
// secret). A dedicated BOOKING_SIGNING_SECRET env var can replace it later.

import { createHmac, timingSafeEqual, randomUUID } from "crypto";

export type BookingPayload = {
  bid: string; // booking_id (uuid v4)
  email: string;
  name: string;
  ts: number; // issued at, unix seconds
  first?: string; // agreed first-visit price, e.g. "153"
  recurring?: string; // agreed recurring price, e.g. "132"
  service?: string; // "Standard" | "Deep" | ...
  date?: string; // preferred date YYYY-MM-DD
};

// Token is valid for 60 days (booking -> card save -> service window).
const TOKEN_TTL_SECONDS = 60 * 24 * 3600;

const b64urlEncode = (s: string): string =>
  Buffer.from(s, "utf8").toString("base64url");

const b64urlDecode = (s: string): string =>
  Buffer.from(s, "base64url").toString("utf8");

export function signBooking(
  secret: string,
  payload: Omit<BookingPayload, "bid" | "ts"> & { bid?: string; ts?: number },
): { token: string; bid: string } {
  const full: BookingPayload = {
    ...payload,
    bid: payload.bid ?? randomUUID(),
    ts: payload.ts ?? Math.floor(Date.now() / 1000),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(full));
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return { token: `${payloadB64}.${sig}`, bid: full.bid };
}

export function verifyBooking(
  secret: string,
  token: string,
): { ok: true; payload: BookingPayload } | { ok: false; reason: string } {
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
  let payload: BookingPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64)) as BookingPayload;
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!payload.bid || !payload.email || !payload.ts) {
    return { ok: false, reason: "missing_fields" };
  }
  const age = Math.floor(Date.now() / 1000) - payload.ts;
  if (age < 0 || age > TOKEN_TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

// --- Minimal in-memory rate limiter (best-effort, per function instance).
// For a low-traffic site this stops casual abuse; not a DDoS defense.
const hits = new Map<string, number[]>();
export function rateLimit(ip: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (arr.length >= maxPerMinute) return false;
  arr.push(now);
  hits.set(ip, arr);
  // Prevent unbounded growth.
  if (hits.size > 5000) hits.clear();
  return true;
}

export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ?? "unknown").split(",")[0].trim();
}
