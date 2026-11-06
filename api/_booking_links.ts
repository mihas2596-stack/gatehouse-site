import { createCipheriv, createHash, randomBytes } from "crypto";

/** Fresh encrypted link, containing only this visit's verified context. */
export function clientVisitLink(stripeKey: string, booking: { bid: string; email: string; name?: string }, anchor = ""): string {
  const secret = process.env["BOOKING_LINK_SECRET"] || stripeKey;
  const key = createHash("sha256").update(`gatehouse-booking-link:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ ...booking, name: booking.name ?? "", ts: Math.floor(Date.now() / 1000) })), cipher.final()]);
  const token = `v2.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
  return `https://www.gatehousehomecleaning.com/visit?bt=${token}${anchor}`;
}
