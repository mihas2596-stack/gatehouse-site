// GET /api/test-price-check?token= — verifies an owner test-price token's
// signature and expiry WITHOUT creating anything. The quote page calls it
// before scaling any displayed price, so an unverified token can never
// show test prices to an ordinary visitor.
import { createHash, createHmac, timingSafeEqual } from "crypto";

type Req = { method?: string; query?: Record<string, string | string[] | undefined> };
type Res = { status(code: number): Res; json(body: unknown): void };

export default async function handler(req: Req, res: Res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }
  const token = typeof req.query?.["token"] === "string" ? (req.query["token"] as string) : "";
  const adminToken = process.env["ADMIN_TOKEN"] ?? "";
  if (!token || !adminToken) {
    res.status(200).json({ ok: false });
    return;
  }
  const parts = token.split(".");
  // tp1.{expiry}.{base64url(email)}.{sig} — mirrors verifyTestPriceToken.
  if (parts.length !== 4 || parts[0] !== "tp1") {
    res.status(200).json({ ok: false });
    return;
  }
  const exp = parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() || exp > Math.floor(Date.now() / 1000) + 48 * 3600) {
    res.status(200).json({ ok: false, expired: true });
    return;
  }
  const key = createHash("sha256").update(`gatehouse-test-price:${adminToken}`).digest();
  const expected = createHmac("sha256", key).update(`tp1.${parts[1]}.${parts[2]}`).digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parts[3] ?? "", "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);
  res.status(200).json({ ok });
}
