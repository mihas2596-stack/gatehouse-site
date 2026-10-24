// Cleaner access links, version 2 — reusable, deterministic.
//
// Problem v2 solves: a random token cannot be recovered from its SHA-256
// hash, so the owner panel could only show a cleaner link once, right
// after issuing it. A v2 token is instead derived deterministically:
//   token = "ct2." + b64url(visitId) + "." + b64url(issuanceId)
//           + "." + b64url(HMAC-SHA-256(secret, canonicalInput))
//   canonicalInput = "cleaner-access\nv2\n<visitId>\n<issuanceId>"
// The server stores only the SHA-256 hash of the finished token plus the
// issuance metadata (version + issuance id). Given the server secret and
// that metadata, an authorized owner request recomputes the exact same
// token — no new link is issued, and expiry, purpose, hash and opened_at
// are untouched.
//
// HONEST SECURITY TRADE-OFF: the database alone reveals no tokens (hashes
// only) and the secret alone reveals nothing (issuance ids live in the
// DB) — but database + secret together can recompute every live link.
// That is the price of reusability. The secret must therefore live
// server-side only: never a VITE_* variable, never in a bundle, a
// response, a log line, or a gh_events detail. Legacy random tokens keep
// working through the old hash check and are never upgraded
// automatically; only an explicit Replace/Create issues a v2 link.
//
// Secret selection (no dashboard click required to start): the primary
// secret is CLEANER_LINK_SECRET when set. Otherwise a domain-separated
// key derived from ADMIN_TOKEN is used — anyone holding ADMIN_TOKEN can
// already fetch any cleaner link through the owner API, so the fallback
// adds no new exposure. Verification tries every candidate secret, so
// links minted under the fallback keep working after the env secret is
// added later (rotation-safe in that direction; removing the env secret
// invalidates links minted under it, as any secret removal should).
//
// This module is pure except for secret selection (process.env), so the
// scheme is unit-testable in isolation; api/booking-action.ts and
// api/cleaner.ts both use it.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

export const CLEANER_LINK_PURPOSE = "cleaner-access";
export const CLEANER_LINK_VERSION = "v2";
export const CLEANER_LINK_URL_BASE = "https://www.gatehousehomecleaning.com/cleaner";

/**
 * Candidate secrets for v2 minting/verification, env first. Empty when
 * neither the env secret nor ADMIN_TOKEN is configured (callers then
 * fail closed or fall back to legacy links).
 */
export function cleanerLinkSecretCandidates(): string[] {
  const out: string[] = [];
  const env = process.env["CLEANER_LINK_SECRET"] ?? "";
  if (env) out.push(env);
  const admin = process.env["ADMIN_TOKEN"] ?? "";
  if (admin) {
    const derived = createHash("sha256").update(`gatehouse-cleaner-link:${admin}`).digest("hex");
    if (!out.includes(derived)) out.push(derived);
  }
  return out;
}

/** The secret new links are minted under: env first, derived fallback. */
export function cleanerLinkPrimarySecret(): string {
  return cleanerLinkSecretCandidates()[0] ?? "";
}

const b64urlEncode = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

const b64urlDecode = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

/** Fresh random issuance id (32 hex chars). A new issuance revokes the old link. */
export function newIssuanceId(): string {
  return randomBytes(16).toString("hex");
}

function canonicalInput(visitId: string, issuanceId: string): string {
  // Fixed field order, newline separators, no user-controlled newlines in
  // either field (uuid + hex by construction) — the serialization is
  // unambiguous.
  return [CLEANER_LINK_PURPOSE, CLEANER_LINK_VERSION, visitId, issuanceId].join("\n");
}

export function mintCleanerLinkV2(secret: string, visitId: string, issuanceId: string): string {
  const hmac = createHmac("sha256", secret).update(canonicalInput(visitId, issuanceId), "utf8").digest();
  return `ct2.${b64urlEncode(visitId)}.${b64urlEncode(issuanceId)}.${hmac.toString("base64url")}`;
}

export function cleanerLinkUrl(token: string): string {
  return `${CLEANER_LINK_URL_BASE}?ct=${token}`;
}

export function parseCleanerLinkV2(
  token: string,
): { visitId: string; issuanceId: string; hmacB64: string } | null {
  if (!token.startsWith("ct2.")) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [, visitB64, issuanceB64, hmacB64] = parts;
  let visitId: string;
  let issuanceId: string;
  try {
    visitId = b64urlDecode(visitB64);
    issuanceId = b64urlDecode(issuanceB64);
  } catch {
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(visitId)) return null;
  if (!/^[0-9a-f]{32}$/.test(issuanceId)) return null;
  // 32-byte HMAC as base64url is exactly 43 chars, no padding.
  if (!/^[A-Za-z0-9_-]{43}$/.test(hmacB64)) return null;
  return { visitId, issuanceId, hmacB64 };
}

/** Strict v2 verification: structure + HMAC under the server secret. Null on any failure. */
export function verifyCleanerLinkV2(
  secret: string,
  token: string,
): { visitId: string; issuanceId: string } | null {
  const parsed = parseCleanerLinkV2(token);
  if (!parsed || !secret) return null;
  const expected = createHmac("sha256", secret).update(canonicalInput(parsed.visitId, parsed.issuanceId), "utf8").digest();
  const actual = Buffer.from(parsed.hmacB64, "base64url");
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  return { visitId: parsed.visitId, issuanceId: parsed.issuanceId };
}

/**
 * Link expiry rule, shared by every issuer (unchanged from the legacy
 * behavior): the later of 14 days from now, or the visit date + 2 days,
 * so a link generated early cannot die before the job happens.
 */
export function cleanerLinkExpiry(visitDate: string | null, nowMs: number = Date.now()): string {
  let expiresMs = nowMs + 14 * 24 * 3600 * 1000;
  if (visitDate && /^\d{4}-\d{2}-\d{2}$/.test(visitDate)) {
    const jobMs = Date.parse(`${visitDate}T23:59:59Z`) + 2 * 24 * 3600 * 1000;
    if (Number.isFinite(jobMs)) expiresMs = Math.max(expiresMs, jobMs);
  }
  return new Date(expiresMs).toISOString();
}
