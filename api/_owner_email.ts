import { dbSelectStrict, logEventStrict } from "./_db.js";
import { emailArrivalWindow, emailDate, emailDocument } from "./_email_copy.js";

// Single source of truth for the owner's notification mailbox (N22).
// Every server email addressed to the owner goes through
// ownerNotificationEmail() instead of a literal repeated in six files.
// Override with OWNER_NOTIFICATION_EMAIL; without it the mailbox below
// (the owner's address since launch) is used, so nothing breaks when
// the variable is not set in Vercel.
const FALLBACK_OWNER_EMAIL = "nikolajmihasenok@gmail.com";

export function ownerNotificationEmail(): string {
  const env = (process.env.OWNER_NOTIFICATION_EMAIL ?? "").trim();
  return env || FALLBACK_OWNER_EMAIL;
}

// Concise owner-request notice (used by the owner-panel resend action,
// and mirroring the creation email in api/send-contact-email.ts): the
// same facts — date, service, address, amount — rebuilt from the stored
// visit row, with an "Open request" action that opens the owner panel
// (a plain link, no login token — C20).
export type OwnerRequestNotice = {
  name: string;
  email?: string | null;
  phone?: string | null;
  service?: string | null;
  date?: string | null;
  window?: string | null;
  address?: string | null;
  amountCents?: number | null;
  bookingId?: string | null;
  isTest?: boolean | null;
};

export function ownerRequestEmailBody(n: OwnerRequestNotice): { subject: string; html: string; text: string } {
  const heading = n.isTest ? "Test request — new cleaning request" : "New cleaning request";
  const details = [
    n.name && `Client: ${n.name}`,
    n.email && `Email: ${n.email}`,
    n.phone && `Phone: ${n.phone}`,
    n.service && `Service: ${n.service}`,
    n.date && `Requested date: ${emailDate(n.date)}`,
    n.window && `Arrival preference: ${emailArrivalWindow(n.window)}`,
    n.address && `Address: ${n.address}`,
    n.amountCents != null && `Visit price: $${(n.amountCents / 100).toFixed(2)}`,
    n.bookingId && `Booking ID: ${n.bookingId}`,
  ].filter(Boolean).join("\n");
  const url = "https://www.gatehousehomecleaning.com/owner";
  const text = `${heading}\n\n${details}\n\nOpen the request in the owner panel:\n${url}\n\nGatehouse Home Cleaning\nhello@gatehousehomecleaning.com\n`;
  const html = emailDocument({
    firstName: "Gatehouse",
    heading,
    paragraphs: ["A new cleaning request is waiting in the owner panel.", details],
    action: { url, label: "Open request" },
    linkNote: false,
  });
  const subject = `New quote request — ${n.name}${n.date ? `, ${emailDate(n.date)}` : ""}`;
  return { subject, html, text };
}

type ReadyVisit = {
  id: string; booking_id: string; status: string | null;
  client_name?: string | null; service: string | null; visit_date: string | null;
  window?: string | null; amount_cents: number | null; is_test?: boolean | null;
};

export async function notifyOwnerCardReady(visit: ReadyVisit | null): Promise<void> {
  if (!visit || visit.status !== "requested") return;
  const previous = await dbSelectStrict<{ id: string }>("gh_events",
    `visit_id=eq.${encodeURIComponent(visit.id)}&event=eq.owner_card_ready_email&select=id&limit=1`);
  if (!previous.ok) throw new Error("owner_card_ready_lookup_failed");
  if (previous.rows.length) return;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("owner_card_ready_email_unconfigured");
  const heading = visit.is_test ? "Test request ready to schedule" : "Cleaning request ready to schedule";
  const details = [
    visit.client_name && `Client: ${visit.client_name}`,
    visit.service && `Service: ${visit.service}`,
    visit.visit_date && `Requested date: ${emailDate(visit.visit_date)}`,
    visit.window && `Arrival preference: ${emailArrivalWindow(visit.window)}`,
    visit.amount_cents != null && `Visit price: $${(visit.amount_cents / 100).toFixed(2)}`,
  ].filter(Boolean).join("\n");
  const nextStep = "The client’s card is ready. Open Schedule, select a cleaner and confirm the arrival window. Gatehouse will email the client.";
  const url = "https://www.gatehousehomecleaning.com/owner";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `owner-card-ready/${visit.id}` },
    body: JSON.stringify({
      from: "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>",
      to: [ownerNotificationEmail()],
      subject: heading,
      text: `${heading}\n\n${details}\n\n${nextStep}\n\nOpen owner dashboard: ${url}`,
      html: emailDocument({ firstName: "Gatehouse", heading, paragraphs: [nextStep, details], action: { url, label: "Open owner dashboard" }, linkNote: false }),
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`owner_card_ready_email_failed_${response.status}`);
  const receipt = await response.json().catch(() => ({})) as { id?: string };
  if (!await logEventStrict(visit.id, visit.booking_id, "system", "owner_card_ready_email", { email_id: receipt.id ?? null })) {
    throw new Error("owner_card_ready_email_log_failed");
  }
}
