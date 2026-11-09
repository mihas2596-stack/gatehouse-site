// Signed Resend callbacks. A bounce is scoped to the exact report email,
// and is acknowledged only after the authoritative visit is protected.

import { createHmac, timingSafeEqual } from "crypto";
import { dbSelectStrict, dbUpdateCount, logEvent } from "./_db.js";
import { processReportReply, type ResendEmailData } from "./_report_reply.js";
import { webhookEventSeen, recordWebhookEvent } from "./_webhook_dedup.js";

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

type NonReportBounce = {
  kind: string;
  visitId: string | null;
  bookingId: string | null;
  bounceEvent: string;
};

// N29: a bounce is not always the report email. Reminders and receipts
// carry their own Resend ids — match them so a bounced reminder is
// journaled (and stops counting as delivered) instead of vanishing.
// Returns null when the id belongs to none of them.
async function matchNonReportBounce(emailId: string): Promise<NonReportBounce | null> {
  // 1. Cleaning receipt — the row carries receipt_email_id.
  const receipt = await dbSelectStrict<{ id: string; booking_id: string }>(
    "gh_visits",
    `receipt_email_id=eq.${encodeURIComponent(emailId)}&select=id,booking_id&limit=2`,
  );
  if (receipt.ok && receipt.rows.length === 1) {
    return { kind: "receipt", visitId: receipt.rows[0].id, bookingId: receipt.rows[0].booking_id, bounceEvent: "receipt_bounced" };
  }
  // 2. Late-cancellation fee receipt — its id lives in the journal
  // detail of the cancellation_fee_receipt_sent event.
  const fee = await dbSelectStrict<{ visit_id: string | null; booking_id: string | null; detail?: Record<string, unknown> | null }>(
    "gh_events",
    `event=eq.cancellation_fee_receipt_sent&detail->>email_id=eq.${encodeURIComponent(emailId)}&select=visit_id,booking_id,detail&limit=1`,
  );
  const feeRow = fee.ok
    ? fee.rows.find((r) => (r.detail as Record<string, unknown> | null)?.["email_id"] === emailId)
    : undefined;
  if (feeRow) {
    return { kind: "fee_receipt", visitId: feeRow.visit_id, bookingId: feeRow.booking_id, bounceEvent: "cancellation_fee_receipt_bounced" };
  }
  // 3. Reminders (20h and early 4h) — their ids live in the journal
  // detail of the reminder_sent / early_reminder_sent events.
  const reminders = await dbSelectStrict<{ visit_id: string | null; booking_id: string | null; event: string; detail?: Record<string, unknown> | null }>(
    "gh_events",
    `event=in.(reminder_sent,early_reminder_sent)&detail->>email_id=eq.${encodeURIComponent(emailId)}&order=created_at.desc&select=visit_id,booking_id,event,detail&limit=1`,
  );
  const remRow = reminders.ok
    ? reminders.rows.find((r) => (r.event === "reminder_sent" || r.event === "early_reminder_sent") && (r.detail as Record<string, unknown> | null)?.["email_id"] === emailId)
    : undefined;
  if (remRow) {
    const early = remRow.event === "early_reminder_sent";
    return { kind: early ? "early_reminder" : "reminder", visitId: remRow.visit_id, bookingId: remRow.booking_id, bounceEvent: early ? "early_reminder_bounced" : "reminder_bounced" };
  }
  return null;
}

// A redelivered bounce must not double-log the same journal event.
async function bounceAlreadyLogged(bookingId: string | null, bounceEvent: string, emailId: string): Promise<boolean> {
  if (!bookingId) return false;
  const prior = await dbSelectStrict<{ id: number }>(
    "gh_events",
    `booking_id=eq.${encodeURIComponent(bookingId)}&event=eq.${bounceEvent}&detail->>email_id=eq.${encodeURIComponent(emailId)}&select=id&limit=1`,
  );
  return prior.ok && prior.rows.length > 0;
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
  // C14: persistent dedup — the Svix delivery id is the event id.
  // Recorded only after a 200 (below), so a 503 delivery is retried
  // by Resend instead of being swallowed as a duplicate. Before this
  // change the Resend webhook had no dedup at all.
  const svixId = header(req, "svix-id");
  if (svixId && (await webhookEventSeen("resend", svixId))) {
    res.status(200).json({ requestId, ok: true, deduped: true });
    return;
  }
  let result: { status: number; body: Record<string, unknown> };
  try {
    result = await handleResendEvent(event);
  } catch (err) {
    logErr("unexpected", err);
    res.status(503).json({ requestId, ok: false, error: "server_error" });
    return;
  }
  if (result.status === 200 && svixId) {
    await recordWebhookEvent("resend", svixId, event.type ?? "");
  }
  res.status(result.status).json({ requestId, ...result.body });
}

async function handleResendEvent(
  event: { type?: string; data?: ResendEmailData },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (event.type === "email.received") {
    const result = await processReportReply(event.data);
    return { status: result.status, body: result.body };
  }
  if (event.type !== "email.bounced" && event.type !== "email.failed") {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const emailId = event.data?.email_id;
  if (typeof emailId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(emailId)) {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const matchEmail = `report_email_id=eq.${encodeURIComponent(emailId)}`;
  const matched = await dbSelectStrict<{
    id: string; booking_id: string; status: string; report_status: string; report_bounced: boolean;
  }>("gh_visits", `${matchEmail}&select=id,booking_id,status,report_status,report_bounced&limit=2`);
  if (!matched.ok || matched.rows.length > 1) {
    return { status: 503, body: { ok: false, error: "visit_lookup_unavailable" } };
  }
  const visit = matched.rows[0];
  if (!visit) {
    // N29: before giving up, try the other emails that carry their
    // own Resend ids — a bounced reminder, receipt or fee receipt.
    const other = await matchNonReportBounce(emailId);
    if (other) {
      const already = await bounceAlreadyLogged(other.bookingId, other.bounceEvent, emailId);
      if (!already) {
        await logEvent(other.visitId, other.bookingId, "system", other.bounceEvent, { email_id: emailId });
      }
      return { status: 200, body: { ok: true, bounced: true, kind: other.kind, ...(already ? { already: true } : {}) } };
    }
    // Resend can send a bounce before its send response is stored.
    // Request redelivery for report events. Other emails are irrelevant.
    const isReport = event.data?.tags?.gh_report === "1" || event.data?.subject === "Your cleaning report is ready";
    return isReport
      ? { status: 503, body: { ok: false, error: "report_email_not_linked" } }
      : { status: 200, body: { ok: true, ignored: true } };
  }
  if (visit.status === "paid" || visit.status === "cancelled" || visit.report_status !== "sent") {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  if (visit.report_bounced) {
    return { status: 200, body: { ok: true, bounced: true, already: true } };
  }
  const saved = await dbUpdateCount("gh_visits", [
    `id=eq.${visit.id}`, matchEmail, `status=eq.${encodeURIComponent(visit.status)}`,
    "report_status=eq.sent", "report_bounced=neq.true",
  ].join("&"), { report_bounced: true });
  if (saved !== 1) {
    return { status: 503, body: { ok: false, error: "delivery_block_not_saved" } };
  }
  await logEvent(visit.id, visit.booking_id, "system", "report_bounced", { email_id: emailId });
  return { status: 200, body: { ok: true, bounced: true } };
}
