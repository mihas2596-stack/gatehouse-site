import { createHmac, timingSafeEqual } from "node:crypto";
import { dbRpc, dbSelectStrict, logEventStrict } from "./_db.js";
import { ownerNotificationEmail } from "./_owner_email.js";

export type ResendEmailData = {
  email_id?: string;
  from?: string;
  to?: string[];
  subject?: string;
  tags?: Record<string, string>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inboxDomain = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.resend\.app$/;

function replyConfig(): { domain: string; secret: string } | null {
  const domain = (process.env.RESEND_REPORT_REPLY_DOMAIN ?? "").trim().toLowerCase();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  return secret && inboxDomain.test(domain) ? { domain, secret } : null;
}

function signature(secret: string, domain: string, compactVisitId: string): string {
  return createHmac("sha256", secret)
    .update(`gatehouse-report-reply-v1:${domain}:${compactVisitId}`)
    .digest("hex").slice(0, 24);
}

export function reportReplyAddress(visitId?: string): string | undefined {
  const cfg = replyConfig();
  // Enable new Reply-To addresses only after the callback and DB migration
  // are verified. Disabling new addresses preserves already-sent replies.
  if (!cfg || process.env.RESEND_REPORT_REPLIES_ENABLED !== "1" || !visitId || !uuid.test(visitId)) return;
  const compact = visitId.toLowerCase().replace(/-/g, "");
  return `review-${compact}.${signature(cfg.secret, cfg.domain, compact)}@${cfg.domain}`;
}

function visitForReply(recipients: unknown): string | null {
  const cfg = replyConfig();
  if (!cfg || !Array.isArray(recipients)) return null;
  const visits = new Set<string>();
  for (const recipient of recipients) {
    if (typeof recipient !== "string") continue;
    const [address, domain, ...extra] = recipient.trim().toLowerCase().split("@");
    if (domain !== cfg.domain || extra.length) continue;
    const match = address.match(/^review-([0-9a-f]{32})\.([0-9a-f]{24})$/);
    if (!match) continue;
    const [, compact, tag] = match;
    if (!timingSafeEqual(Buffer.from(tag), Buffer.from(signature(cfg.secret, cfg.domain, compact)))) continue;
    visits.add(`${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`);
  }
  return visits.size === 1 ? [...visits][0] : null;
}

type ReplyOutcome = "ignored" | "held" | "payment_in_progress" | "paid" | "cancelled";
type RecordedReply = { outcome: ReplyOutcome; booking_id?: string };
type WebhookReply = { status: number; body: Record<string, unknown> };
const ignored = (): WebhookReply => ({ status: 200, body: { ok: true, ignored: true } });
const retry = (error: string): WebhookReply => ({ status: 503, body: { ok: false, error } });

const ownerStatus: Record<Exclude<ReplyOutcome, "ignored">, string> = {
  held: "Automatic payment was blocked when this reply was recorded. Review the visit before taking action.",
  payment_in_progress: "A payment was already in progress when this reply arrived. Check its outcome and review the reply.",
  paid: "This visit was already paid. Review the reply in the owner panel.",
  cancelled: "This visit is cancelled. Review the reply if follow-up is needed.",
};

export async function processReportReply(data?: ResendEmailData): Promise<WebhookReply> {
  const visitId = visitForReply(data?.to);
  const emailId = data?.email_id;
  const sender = typeof data?.from === "string" ? data.from.trim().toLowerCase() : "";
  const subject = typeof data?.subject === "string" ? data.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 180) : "";
  if (!visitId || typeof emailId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(emailId) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender) || sender.length > 254) return ignored();
  if (/^(automatic reply|auto[- ]?reply|out of office)\s*:/i.test(subject)) return ignored();

  const result = await dbRpc<RecordedReply>("gh_accept_report_email_reply", {
    p_visit_id: visitId, p_sender: sender, p_email_id: emailId,
  });
  if (!result) return retry("reply_not_recorded");
  if (result.outcome === "ignored") return ignored();
  const bookingId = result.booking_id;
  const statusText = ownerStatus[result.outcome];
  if (!bookingId || !statusText) return retry("reply_result_invalid");
  const recorded = await dbSelectStrict<{ id: number }>("gh_events", [
    `visit_id=eq.${visitId}`, "event=eq.notification_email_sent", "detail->>kind=eq.report_reply_owner",
    `detail->>email_id=eq.${encodeURIComponent(emailId)}`, "select=id", "limit=1",
  ].join("&"));
  if (!recorded.ok) return retry("notification_state_unavailable");
  if (recorded.rows.length) return { status: 200, body: { ok: true, outcome: result.outcome, already: true } };

  const key = process.env.RESEND_API_KEY;
  if (!key) return retry("owner_notification_unavailable");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "Idempotency-Key": `report-reply-owner/${visitId}/${emailId}`,
    },
    body: JSON.stringify({
      from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>", to: [ownerNotificationEmail()],
      reply_to: sender, subject: "Customer reply to a cleaning report — review needed",
      text: [statusText, `Booking: ${bookingId}`, `From: ${sender}`, `Subject: ${subject || "(no subject)"}`,
        `Open the original under Receiving in Resend: https://resend.com/emails\nMessage ID: ${emailId}`,
        "Review the visit: https://www.gatehousehomecleaning.com/owner"].join("\n\n"),
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return retry("owner_notification_failed");
  if (!await logEventStrict(visitId, bookingId, "system", "notification_email_sent", { kind: "report_reply_owner", email_id: emailId })) {
    return retry("notification_not_recorded");
  }
  return { status: 200, body: { ok: true, outcome: result.outcome } };
}
