// Owner email-link login + session tokens (owner order 2026-10-24).
// The /owner page historically takes ADMIN_TOKEN typed by hand. Email login
// adds a second credential so the owner never has to copy the key:
//   1. POST /api/owner-login -> server emails a short-lived link token (ol1)
//      to the fixed OWNER_EMAIL (nikolajmihasenok@gmail.com).
//   2. /owner?ol=<token> -> POST /api/owner-login-verify exchanges it for a
//      24h session token (os1), stored in sessionStorage like the key.
//   3. Owner APIs accept `Bearer <ADMIN_TOKEN>` OR a valid os1 session.
// Both token types are HMAC-signed with keys derived from ADMIN_TOKEN, so
// rotating ADMIN_TOKEN in Vercel invalidates every outstanding link/session.
// The link token carries no email claim: the send endpoint only ever mails
// the fixed owner address, so there is nothing to bind it to.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Minutes a login link stays clickable. */
export const OWNER_LOGIN_LINK_TTL_SEC = 1800;
/** Hours a verified panel session stays valid. */
export const OWNER_SESSION_TTL_SEC = 24 * 3600;

const loginKey = (adminToken: string): Buffer =>
  createHash("sha256").update(`gatehouse-owner-login:${adminToken}`).digest();
const sessionKey = (adminToken: string): Buffer =>
  createHash("sha256").update(`gatehouse-owner-session:${adminToken}`).digest();

function sign(key: Buffer, msg: string): string {
  return createHmac("sha256", key).update(msg).digest("base64url");
}

function sigOk(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintOwnerLoginToken(adminToken: string, nowSec: number): string {
  const exp = nowSec + OWNER_LOGIN_LINK_TTL_SEC;
  const msg = `ol1.${exp}`;
  return `${msg}.${sign(loginKey(adminToken), msg)}`;
}

export function verifyOwnerLoginToken(token: string, adminToken: string, nowSec: number): boolean {
  if (!token || !adminToken) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "ol1") return false;
  const exp = parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  return sigOk(sign(loginKey(adminToken), `ol1.${parts[1]}`), parts[2] ?? "");
}

export function mintOwnerSessionToken(adminToken: string, nowSec: number): string {
  const exp = nowSec + OWNER_SESSION_TTL_SEC;
  const msg = `os1.${exp}`;
  return `${msg}.${sign(sessionKey(adminToken), msg)}`;
}

export function verifyOwnerSessionToken(token: string, adminToken: string, nowSec: number): boolean {
  if (!token || !adminToken) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "os1") return false;
  const exp = parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(exp) || exp < nowSec) return false;
  return sigOk(sign(sessionKey(adminToken), `os1.${parts[1]}`), parts[2] ?? "");
}

/** Owner API auth: the hand-typed key, or a valid email-login session. */
export function isOwnerAuth(authHeader: string, adminToken: string, nowSec: number): boolean {
  if (!authHeader.startsWith("Bearer ")) return false;
  const cred = authHeader.slice("Bearer ".length);
  if (!adminToken || !cred) return false;
  if (cred === adminToken) return true;
  return verifyOwnerSessionToken(cred, adminToken, nowSec);
}
