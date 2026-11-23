import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string" || !/^[+\d().\s-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? "+1" + digits : null;
}
export function same(a: string, b: string): boolean {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export function validSignature(url: string, fields: Record<string, string>, token: string, signature: string): boolean {
  const data = Object.keys(fields).sort().reduce((s, k) => s + k + fields[k], url);
  return !!token && same(createHmac("sha1", token).update(data).digest("base64"), signature);
}
export type Payload = {
  id: string; kind: string; audience: string; phone: string; visit: string; booking: string; date: string;
  window: string; name: string; email: string; amount: number; issuance: string; hash: string; expiry: string; test: boolean
};
export function message(p: Payload, link: string): string {
  const when = [p.date, p.window].filter(Boolean).join(", ");
  const lines: Record<string, string> = {
    confirmed: `Your cleaning is confirmed for ${when}. View details: ${link}`,
    assigned: p.audience === "cleaner" ? `New cleaning assigned for ${when}. Open your cleaner dashboard: ${link}` : `${p.name || "A cleaner"} has been assigned to your cleaning. Details: ${link}`,
    reminder: `Reminder — your cleaning is scheduled for tomorrow, ${p.window}. Details: ${link}`,
    rescheduled: `Your cleaning schedule has changed to ${when}. Details: ${link}`,
    complete: `Your cleaning is complete. Review your photos and approve payment or report an issue: ${link}`,
    payment_reminder: `Please review your cleaning report. Under your booking terms, payment is scheduled automatically after 24 hours unless you report an issue: ${link}`,
    issue: "We received your issue report. Payment is on hold while we review it.",
    paid: `Your payment of $${(p.amount / 100).toFixed(2)} was successful. Thank you!`,
    cancelled: `Your cleaning assignment for ${when} was cancelled.`,
    report_returned: `Your cleaning report needs an update. Review the owner’s note: ${link}`,
    cleaner_action: `A return visit requires your attention. Open your cleaner dashboard: ${link}`,
  };
  if (!lines[p.kind]) throw new Error("unsupported_event");
  return "Gatehouse Home Cleaning: " + lines[p.kind] + " Reply STOP to opt out.";
}
export function linkMac(id: string, until: string, binding: string, secret: string): string {
  return createHmac("sha256", secret).update(["sms-link-v1", id, until, binding].join("\n")).digest("base64url");
}
