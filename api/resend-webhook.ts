// Signed Resend callbacks. A bounce is scoped to the exact report email,
// and is acknowledged only after the authoritative visit is protected.

import { createHmac, timingSafeEqual } from "crypto";
import { dbSelectStrict, dbUpdateCount, logEvent } from "./_db.js";
import { processReportReply, type ResendEmailData } from "./_report_reply.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

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

  let event: { type?: string; data?: ResendEmailData };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    res.status(400).json({ requestId, ok: false, error: "bad_json" });
    return;
  }
  try {
    if (event.type === "email.received") {
      const result = await processReportReply(event.data);
      res.status(result.status).json({ requestId, ...result.body });
      return;
    }
    if (event.type !== "email.bounced" && event.type !== "email.failed") {
      res.status(200).json({ requestId, ok: true, ignored: true });
      return;
    }
    const emailId = event.data?.email_id;
    if (typeof emailId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(emailId)) {
      res.status(200).json({ requestId, ok: true, ignored: true });
      return;
    }
    const matchEmail = `report_email_id=eq.${encodeURIComponent(emailId)}`;
    const matched = await dbSelectStrict<{
      id: string; booking_id: string; status: string; report_status: string; report_bounced: boolean;
    }>("gh_visits", `${matchEmail}&select=id,booking_id,status,report_status,report_bounced&limit=2`);
    if (!matched.ok || matched.rows.length > 1) {
      res.status(503).json({ requestId, ok: false, error: "visit_lookup_unavailable" });
      return;
    }
    const visit = matched.rows[0];
    if (!visit) {
      // Resend can send a bounce before its send response is stored.
      // Request redelivery for report events. Other emails are irrelevant.
      const isReport = event.data?.tags?.gh_report === "1" || event.data?.subject === "Your cleaning report is ready";
      res.status(isReport ? 503 : 200).json(isReport
        ? { requestId, ok: false, error: "report_email_not_linked" }
        : { requestId, ok: true, ignored: true });
      return;
    }
    if (visit.status === "paid" || visit.status === "cancelled" || visit.report_status !== "sent") {
      res.status(200).json({ requestId, ok: true, ignored: true });
      return;
    }
    if (visit.report_bounced) {
      res.status(200).json({ requestId, ok: true, bounced: true, already: true });
      return;
    }
    const saved = await dbUpdateCount("gh_visits", [
      `id=eq.${visit.id}`, matchEmail, `status=eq.${encodeURIComponent(visit.status)}`,
      "report_status=eq.sent", "report_bounced=neq.true",
    ].join("&"), { report_bounced: true });
    if (saved !== 1) {
      res.status(503).json({ requestId, ok: false, error: "delivery_block_not_saved" });
      return;
    }
    await logEvent(visit.id, visit.booking_id, "system", "report_bounced", { email_id: emailId });
    res.status(200).json({ requestId, ok: true, bounced: true });
  } catch (err) {
    logErr("unexpected", err);
    res.status(503).json({ requestId, ok: false, error: "server_error" });
  }
}
