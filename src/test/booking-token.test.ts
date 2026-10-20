// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { signBooking, verifyBooking } from "../../api/create-checkout-session";

const SECRET = ["unit", "test", "key", "alpha"].join("-");
const OTHER = "a-different-secret-value";
const payload = {
  email: "client@example.com",
  name: "Jane Client",
  first: "153",
  recurring: "132",
  service: "Standard cleaning",
  date: "2026-10-28",
};

describe("booking link token v2 (encrypted)", () => {
  it("round-trips: sign then verify returns the payload", () => {
    const { token, bid } = signBooking(SECRET, payload);
    const r = verifyBooking(SECRET, token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.bid).toBe(bid);
      expect(r.payload.email).toBe(payload.email);
      expect(r.payload.first).toBe("153");
    }
  });

  it("is opaque: no readable name, email or price in the token", () => {
    const { token } = signBooking(SECRET, payload);
    expect(token.startsWith("v2.")).toBe(true);
    expect(token).not.toContain("Jane");
    expect(token).not.toContain("client@example.com");
    // The payload segment must not base64-decode to JSON containing PII.
    const decoded = Buffer.from(token.slice(3), "base64url").toString("utf8");
    expect(decoded).not.toContain("Jane");
    expect(decoded).not.toContain("client@example.com");
    expect(() => JSON.parse(decoded)).toThrow();
  });

  it("rejects a token verified with the wrong secret", () => {
    const { token } = signBooking(SECRET, payload);
    expect(verifyBooking(OTHER, token).ok).toBe(false);
  });

  it("rejects a tampered token", () => {
    const { token } = signBooking(SECRET, payload);
    const i = token.length - 4;
    const flipped = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
    expect(verifyBooking(SECRET, flipped).ok).toBe(false);
  });

  it("rejects an expired v2 token (older than 30 days)", () => {
    const old = Math.floor(Date.now() / 1000) - 31 * 24 * 3600;
    const { token } = signBooking(SECRET, { ...payload, ts: old });
    const r = verifyBooking(SECRET, token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });
});

describe("booking link token v1 (legacy signed plaintext)", () => {
  function v1Token(secret: string, ts: number): string {
    const full = { ...payload, bid: "legacy-bid-1", ts };
    const b64 = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
    const sig = createHmac("sha256", secret).update(b64).digest("base64url");
    return `${b64}.${sig}`;
  }

  it("still accepts a valid legacy token so emailed links keep working", () => {
    const now = Math.floor(Date.now() / 1000);
    const r = verifyBooking(SECRET, v1Token(SECRET, now));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.email).toBe(payload.email);
  });

  it("rejects a legacy token with a bad signature", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyBooking(OTHER, v1Token(SECRET, now)).ok).toBe(false);
  });

  it("rejects a legacy token older than 60 days", () => {
    const old = Math.floor(Date.now() / 1000) - 61 * 24 * 3600;
    const r = verifyBooking(SECRET, v1Token(SECRET, old));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });
});
