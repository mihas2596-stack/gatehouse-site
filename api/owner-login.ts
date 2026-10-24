// Owner login-link sender (owner order 2026-10-24).
// POST /api/owner-login -> emails a 30-minute login link to the fixed owner
// address (nikolajmihasenok@gmail.com). No request body: the recipient is
// never taken from the caller, so the endpoint cannot be used to mail
// links to anyone else, and it always answers ok:true on throttle so a
// caller cannot probe whether a link was just sent.
// Throttle: at most one email per 5 minutes (gh_events journal). If the
// database is unavailable the throttle fails open — the panel itself
// needs the database anyway, so this only matters for the send step.
import { dbSelect, logEvent } from "./_db.js";
import { mintOwnerLoginToken } from "./_owner_auth.js";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
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
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "";
  const RESEND_API_KEY = process.env["RESEND_API_KEY"] ?? "";
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
        text: `Open this link to enter the Gatehouse owner panel (no key needed):\n\n${link}\n\nThe link works for 30 minutes. If you did not request it, ignore this email.`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return json(500, { ok: false, error: "email_failed" });
  } catch {
    return json(500, { ok: false, error: "email_failed" });
  }
  return json(200, { ok: true });
}
