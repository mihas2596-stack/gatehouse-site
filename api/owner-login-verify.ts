// Owner login-link exchange (owner order 2026-10-24).
// POST /api/owner-login-verify { ol } -> { ok: true, session } when the
// link token verifies, else 401. The session token (os1, 24h) is what the
// /owner page then sends as its Bearer credential; owner APIs accept it
// next to ADMIN_TOKEN (see _owner_auth.ts isOwnerAuth).
import { mintOwnerSessionToken, verifyOwnerLoginToken } from "./_owner_auth.js";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
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

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  const origin = req.headers["origin"];
  if (origin && (typeof origin !== "string" || !ALLOWED_ORIGINS.includes(origin))) {
    return json(403, { ok: false, error: "origin_not_allowed" });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "";
  if (!ADMIN_TOKEN) return json(500, { ok: false, error: "server_error" });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const ol = typeof body["ol"] === "string" ? (body["ol"] as string) : "";
  const nowSec = Math.floor(Date.now() / 1000);
  if (!verifyOwnerLoginToken(ol, ADMIN_TOKEN, nowSec)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  return json(200, { ok: true, session: mintOwnerSessionToken(ADMIN_TOKEN, nowSec) });
}
