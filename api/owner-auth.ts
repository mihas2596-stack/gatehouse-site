// Owner auth actions (owner order 2026-10-24) + quote test-price check.
// One file hosts three actions because the Vercel Hobby plan allows only
// 12 serverless functions per deployment and the site already uses all of
// them (2026-10-24: two login endpoints pushed the count to 14 and every
// deploy failed until they were merged here).
//   POST { action: "send" } (or no action) -> emails a 24-hour login
//     link to the fixed owner address (nikolajmihasenok@gmail.com). The
//     recipient is never taken from the caller, so the endpoint cannot be
//     used to mail links to anyone else, and it always answers ok:true on
//     throttle so a caller cannot probe whether a link was just sent.
//   POST { action: "verify", ol } -> { ok: true, session } when the link
//     token verifies, else 401. The session token (os1, 24h) is what the
//     /owner page then sends as its Bearer token.
//   GET ?token= -> verifies an owner test-price token's signature and
//     expiry WITHOUT creating anything (folded from test-price-check.ts).
// Throttle: at most one link email per 5 minutes (gh_events journal). If
// the database is unavailable the throttle fails open — the panel itself
// needs the database anyway, so this only matters for the send step.
import { dbSelect, logEvent } from "./_db.js";
import { mintOwnerLoginToken, mintOwnerSessionToken, verifyOwnerLoginToken } from "./_owner_auth.js";
import { createHash, createHmac, timingSafeEqual } from "crypto";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
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

const OWNER_EMAIL = "nikolajmihasenok@gmail.com";
const FROM_EMAIL = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const THROTTLE_MS = 5 * 60 * 1000;

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  const origin = req.headers["origin"];
  if (origin && (typeof origin !== "string" || !ALLOWED_ORIGINS.includes(origin))) {
    return json(403, { ok: false, error: "origin_not_allowed" });
  }
  if (req.method === "GET") {
    // Quote test-price check (was GET /api/test-price-check): verify the
    // tp1 token's signature + expiry, create nothing.
    const token = typeof req.query?.["token"] === "string" ? (req.query["token"] as string) : "";
    const adminToken = process.env["ADMIN_TOKEN"] ?? "";
    if (!token || !adminToken) return json(200, { ok: false });
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "tp1") return json(200, { ok: false });
    const exp = parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now() || exp > Math.floor(Date.now() / 1000) + 48 * 3600) {
      return json(200, { ok: false, expired: true });
    }
    const key = createHash("sha256").update(`gatehouse-test-price:${adminToken}`).digest();
    const expected = createHmac("sha256", key).update(`tp1.${parts[1]}.${parts[2]}`).digest("base64url");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(parts[3] ?? "", "utf8");
    return json(200, { ok: a.length === b.length && timingSafeEqual(a, b) });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "";
  const RESEND_API_KEY = process.env["RESEND_API_KEY"] ?? "";
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = typeof body["action"] === "string" ? (body["action"] as string) : "send";
  if (action === "verify") {
    if (!ADMIN_TOKEN) return json(500, { ok: false, error: "server_error" });
    const ol = typeof body["ol"] === "string" ? (body["ol"] as string) : "";
    const nowSec = Math.floor(Date.now() / 1000);
    if (!verifyOwnerLoginToken(ol, ADMIN_TOKEN, nowSec)) {
      return json(401, { ok: false, error: "unauthorized" });
    }
    return json(200, { ok: true, session: mintOwnerSessionToken(ADMIN_TOKEN, nowSec) });
  }
  if (!ADMIN_TOKEN || !RESEND_API_KEY) {
    return json(500, { ok: false, error: "server_error" });
  }

  // Throttle: one link email per 5 minutes, silently.
  try {
    const recent = await dbSelect<{ created_at: string }>(
      "gh_events",
      "event=eq.owner_login_link_sent&order=created_at.desc&limit=1",
    );
    const last = recent[0]?.created_at;
    if (last && Date.parse(last) > Date.now() - THROTTLE_MS) {
      return json(200, { ok: true });
    }
  } catch {
    // Throttle check failed — continue; the panel needs the DB anyway.
  }

  const token = mintOwnerLoginToken(ADMIN_TOKEN, Math.floor(Date.now() / 1000));
  const link = `https://www.gatehousehomecleaning.com/owner?ol=${token}`;
  await logEvent(null, null, "owner", "owner_login_link_sent");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [OWNER_EMAIL],
        subject: "Gatehouse owner login link",
        text: `Open this link to enter the Gatehouse owner panel (no key needed):\n\n${link}\n\nThe link works for 24 hours. If you did not request it, ignore this email.`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return json(500, { ok: false, error: "email_failed" });
  } catch {
    return json(500, { ok: false, error: "email_failed" });
  }
  return json(200, { ok: true });
}
