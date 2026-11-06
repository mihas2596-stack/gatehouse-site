// Presentation only. Prices, recipients, deadlines and send/idempotency
// decisions remain with the booking-scoped callers.
const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function emailDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
}

export function emailArrivalWindow(value: string): string {
  const labels: Record<string, string> = {
    morning: "7–11 AM ET", midday: "11 AM–2 PM ET", afternoon: "2–5 PM ET",
    flexible: "Flexible — we'll agree an arrival window with you",
  };
  return labels[value] ?? (value ? `${value}${/ET|Atlanta|Eastern/i.test(value) ? "" : " (Atlanta time)"}` : "To be confirmed");
}

export function paymentEmailCopy(amount: string): string {
  const charge = amount && amount !== "—" ? amount : "the agreed visit amount";
  return `Due today: $0.\n\nReview & pay: approving your photo report charges your card ${charge} immediately.\n\nAutomatic payment: your card is charged automatically 24 hours after we send the report unless you approve or report an issue first.\n\nNeed help? Choose "Report an issue" on your visit page within 24 hours. This blocks automatic charging for this visit; closing the issue does not restart it.`;
}

export function emailDocument(options: {
  firstName: string; heading: string; paragraphs: string[];
  action?: { url: string; label: string };
}): string {
  const paragraphs = options.paragraphs.flatMap((p) => p.split("\n\n")).filter(Boolean);
  const paragraph = (p: string) => `<p style="margin:18px 0;">${esc(p).replace(/\n/g, "<br>")}</p>`;
  const action = options.action ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="background:#99532f;border-radius:8px;"><a href="${esc(options.action.url)}" style="display:inline-block;padding:16px 24px;color:#fff;font-size:18px;font-weight:bold;text-decoration:none;">${esc(options.action.label)}</a></td></tr></table>` : "";
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#292725;font-size:18px;line-height:1.6;">` +
    `<p style="font-size:16px;font-weight:bold;color:#35563d;">GATEHOUSE HOME CLEANING</p><p>Hi ${esc(options.firstName)},</p><h1 style="font-size:28px;line-height:1.25;margin:18px 0;">${esc(options.heading)}</h1>` +
    paragraphs.slice(0, 2).map(paragraph).join("") + action + paragraphs.slice(2).map(paragraph).join("") +
    `<p style="border-top:1px solid #e6d8c9;padding-top:20px;font-size:16px;">Questions? Reply to this email or contact <a href="mailto:hello@gatehousehomecleaning.com">hello@gatehousehomecleaning.com</a>.</p>` +
    (options.action ? `<p style="font-size:16px;color:#4c4945;">Keep this email — its private link is for this visit.</p>` : "") + `<p>Gatehouse Home Cleaning</p></div>`;
}

export function reportEmail(options: {
  firstName: string; link: string; amount: string; deadline: string; autoChargeBlocked: boolean;
}): { text: string; html: string } {
  const amount = options.amount || "the visit amount shown on your report";
  const paragraphs = [
    "Your cleaning is finished. Open your photos and checklist below.",
    `If everything looks good, choose \"Approve & pay\" on your report. This charges your card ${amount} immediately.`,
    options.autoChargeBlocked
      ? "Automatic charging is blocked for this visit because an issue was reported. Closing the issue does not restart it. You choose when to approve the report and pay."
      : `If you do not approve or report an issue, your card is charged automatically 24 hours after we send the report. Review by ${options.deadline} (Atlanta time).`,
    "Something missed? Choose \"Report an issue\" on your visit page. This blocks automatic charging for this visit; it does not resume on its own.",
  ];
  return {
    text: `Hi ${options.firstName},\n\nYour cleaning report is ready.\n\n${paragraphs.join("\n\n")}\n\nReview my cleaning:\n${options.link}\n\nQuestions? Reply to this email.\n\nGatehouse Home Cleaning\n`,
    html: emailDocument({ firstName: options.firstName, heading: "Your cleaning report is ready", paragraphs, action: { url: options.link, label: "Review my cleaning" } }),
  };
}
