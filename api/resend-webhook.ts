// POST /api/resend-webhook — Resend (Svix) delivery events for site email.
//
// Purpose: a CONFIRMED BOUNCE of the photo-report email must void the
// report's 24h clock. The Terms say the window does not start until the
// report reaches the client another way, so on "email.bounced" for the
// message id stored by send_report (gh_report_email_id) we flag the
// booking (gh_report_bounced=1), clear gh_report_sent_at and return the
// booking to card_ready. The auto-charge timer skips bounced bookings,
// and the /report page tells the client the email could not be delivered
// and that no charge will happen until the report reaches them.
//
// Fail-closed: without RESEND_WEBHOOK_SECRET the endpoint answers 503
// and does nothing. Signature: Svix — HMAC-SHA256 over
// "<svix-id>.<svix-timestamp>.<raw body>" with the base64-decoded secret.

import { createHmac, timingSafeEqual } from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const STRIPE_API = "https://api.stripe.com/v1";

async function readRawBody(stream: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  const readable = stream as AsyncIterable<Uint8Array>;
  for await (const chunk of readable) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

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

function header(req: Req, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function verifySvix(secret: string, id: string, timestamp: string, signature: string, body: string): boolean {
  const ts = Number(timestamp);
  if (!id || !Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const keyB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const sigBuf = Buffer.from(sig, "utf8");
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
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
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  return { ok: response.ok, status: response.status };
}

async function findCustomerByReportEmail(
  secretKey: string,
  emailId: string,
): Promise<{ id: string; metadata: Record<string, string> } | null> {
  const query = `metadata['gh_report_email_id']:'${emailId.replace(/'/g, "")}'`;
  const res = await stripeGet(secretKey, `/customers/search?${new URLSearchParams({ query, limit: "1" })}`);
  if (res.ok) {
    const list = (res.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
    if (list.length > 0) return { id: list[0].id, metadata: list[0].metadata ?? {} };
    return null;
  }
  const listRes = await stripeGet(secretKey, `/customers?${new URLSearchParams({ limit: "100" })}`);
  if (!listRes.ok) return null;
  const list = (listRes.data["data"] as Array<{ id: string; metadata?: Record<string, string> }> | undefined) ?? [];
  const found = list.find((c) => c.metadata?.["gh_report_email_id"] === emailId);
  return found ? { id: found.id, metadata: found.metadata ?? {} } : null;
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const logErr = (step: string, err: unknown) =>
    console.error(
      JSON.stringify({ requestId, step, error: err instanceof Error ? err.message : String(err) }),
    );

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }
  const secret = process.env["RESEND_WEBHOOK_SECRET"];
  if (!secret) {
    res.status(503).json({ requestId, ok: false, error: "webhook_not_configured" });
    return;
  }
  const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
  if (!STRIPE_SECRET_KEY) {
    logErr("config", "STRIPE_SECRET_KEY missing");
    res.status(500).json({ requestId, ok: false, error: "server_error" });
    return;
  }

  let raw: string;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    logErr("read_body", err);
    res.status(400).json({ requestId, ok: false, error: "bad_body" });
    return;
  }
  const okSig = verifySvix(
    secret,
    header(req, "svix-id"),
    header(req, "svix-timestamp"),
    header(req, "svix-signature"),
    raw,
  );
  if (!okSig) {
    logErr("signature", "verification failed");
    res.status(401).json({ requestId, ok: false, error: "bad_signature" });
    return;
  }

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    res.status(400).json({ requestId, ok: false, error: "bad_json" });
    return;
  }
  if (event.type !== "email.bounced") {
    res.status(200).json({ requestId, ok: true, ignored: true });
    return;
  }
  const emailId = event.data?.email_id ?? "";
  if (!emailId) {
    res.status(200).json({ requestId, ok: true, ignored: true });
    return;
  }

  try {
    const customer = await findCustomerByReportEmail(STRIPE_SECRET_KEY, emailId);
    if (!customer) {
      res.status(200).json({ requestId, ok: true, ignored: true });
      return;
    }
    if ((customer.metadata["gh_state"] ?? "") !== "report_sent") {
      // The money path already moved (approved/paid) or no clock is
      // running — a late bounce changes nothing.
      res.status(200).json({ requestId, ok: true, ignored: true });
      return;
    }
    const upd = await stripePost(STRIPE_SECRET_KEY, `/customers/${customer.id}`, {
      "metadata[gh_state]": "card_ready",
      "metadata[gh_report_bounced]": "1",
      "metadata[gh_report_sent_at]": "",
    });
    if (!upd.ok) {
      logErr("bounce_update", `stripe ${upd.status}`);
      res.status(502).json({ requestId, ok: false, error: "stripe_error" });
      return;
    }
    console.log(JSON.stringify({ requestId, step: "report_bounced", booking: customer.metadata["gh_booking_id"] ?? "" }));
    res.status(200).json({ requestId, ok: true, bounced: true });
  } catch (err) {
    logErr("unexpected", err);
    res.status(500).json({ requestId, ok: false, error: "server_error" });
  }
}
