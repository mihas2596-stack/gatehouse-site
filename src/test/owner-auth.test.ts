// @vitest-environment node
// Owner email-link login tokens (owner order 2026-10-24): link tokens (ol1,
// 30 min) exchange for session tokens (os1, 24h); owner APIs accept the
// hand-typed key or a valid session via isOwnerAuth. The HTTP handler lives
// in api/owner-auth.ts (merged from owner-login + owner-login-verify +
// test-price-check: the Vercel Hobby plan allows only 12 functions).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHash, createHmac } from "crypto";
import handler from "../../api/owner-auth";
import {
  mintOwnerLoginToken,
  verifyOwnerLoginToken,
  mintOwnerSessionToken,
  verifyOwnerSessionToken,
  isOwnerAuth,
  OWNER_LOGIN_LINK_TTL_SEC,
  OWNER_SESSION_TTL_SEC,
} from "../../api/_owner_auth";

const ADMIN = "test-admin-token";
const NOW = 1_790_000_000;

describe("owner login tokens (ol1)", () => {
  it("verifies a freshly minted link and rejects it after expiry", () => {
    const tok = mintOwnerLoginToken(ADMIN, NOW);
    expect(verifyOwnerLoginToken(tok, ADMIN, NOW)).toBe(true);
    expect(verifyOwnerLoginToken(tok, ADMIN, NOW + OWNER_LOGIN_LINK_TTL_SEC)).toBe(true);
    expect(verifyOwnerLoginToken(tok, ADMIN, NOW + OWNER_LOGIN_LINK_TTL_SEC + 1)).toBe(false);
  });
  it("rejects a tampered signature, a wrong key, and a wrong prefix", () => {
    const tok = mintOwnerLoginToken(ADMIN, NOW);
    const tampered = `${tok.slice(0, -1)}${tok.endsWith("A") ? "B" : "A"}`;
    expect(verifyOwnerLoginToken(tampered, ADMIN, NOW)).toBe(false);
    expect(verifyOwnerLoginToken(tok, "other-admin", NOW)).toBe(false);
    expect(verifyOwnerLoginToken(tok.replace("ol1", "os1"), ADMIN, NOW)).toBe(false);
    expect(verifyOwnerLoginToken("", ADMIN, NOW)).toBe(false);
  });
  it("link TTL is 30 minutes", () => {
    expect(OWNER_LOGIN_LINK_TTL_SEC).toBe(1800);
  });
});

describe("owner session tokens (os1)", () => {
  it("verifies a freshly minted session and rejects it after expiry", () => {
    const tok = mintOwnerSessionToken(ADMIN, NOW);
    expect(verifyOwnerSessionToken(tok, ADMIN, NOW)).toBe(true);
    expect(verifyOwnerSessionToken(tok, ADMIN, NOW + OWNER_SESSION_TTL_SEC)).toBe(true);
    expect(verifyOwnerSessionToken(tok, ADMIN, NOW + OWNER_SESSION_TTL_SEC + 1)).toBe(false);
  });
  it("a login token is not a session token and vice versa", () => {
    const login = mintOwnerLoginToken(ADMIN, NOW);
    const session = mintOwnerSessionToken(ADMIN, NOW);
    expect(verifyOwnerSessionToken(login, ADMIN, NOW)).toBe(false);
    expect(verifyOwnerLoginToken(session, ADMIN, NOW)).toBe(false);
  });
  it("session TTL is 24 hours", () => {
    expect(OWNER_SESSION_TTL_SEC).toBe(24 * 3600);
  });
});

describe("isOwnerAuth", () => {
  it("accepts the hand-typed key and a valid session, rejects the rest", () => {
    const session = mintOwnerSessionToken(ADMIN, NOW);
    expect(isOwnerAuth(`Bearer ${ADMIN}`, ADMIN, NOW)).toBe(true);
    expect(isOwnerAuth(`Bearer ${session}`, ADMIN, NOW)).toBe(true);
    expect(isOwnerAuth(`Bearer ${mintOwnerSessionToken(ADMIN, NOW - OWNER_SESSION_TTL_SEC - 1)}`, ADMIN, NOW)).toBe(false);
    expect(isOwnerAuth(`Bearer ${mintOwnerLoginToken(ADMIN, NOW)}`, ADMIN, NOW)).toBe(false);
    expect(isOwnerAuth(`Bearer wrong`, ADMIN, NOW)).toBe(false);
    expect(isOwnerAuth(`${session}`, ADMIN, NOW)).toBe(false);
    expect(isOwnerAuth("", ADMIN, NOW)).toBe(false);
    expect(isOwnerAuth(`Bearer ${session}`, "", NOW)).toBe(false);
  });
});

describe("owner-auth handler", () => {
  const callAuth = async (req: Record<string, unknown>) => {
    let body: unknown = null;
    let status = 0;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(b: unknown) {
        body = b;
      },
      setHeader: vi.fn(),
      end: vi.fn(),
    } as never;
    await handler(req as never, res);
    return { status, body: body as Record<string, unknown> };
  };

  const makeTpToken = (exp: number, email = "owner@example.com"): string => {
    const key = createHash("sha256").update("gatehouse-test-price:test-admin-token").digest();
    const emailB64 = Buffer.from(email, "utf8").toString("base64url");
    const sig = createHmac("sha256", key).update(`tp1.${exp}.${emailB64}`).digest("base64url");
    return `tp1.${exp}.${emailB64}.${sig}`;
  };

  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", "test-admin-token");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("GET verifies a test-price token (folded from test-price-check)", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const good = await callAuth({ method: "GET", headers: {}, query: { token: makeTpToken(exp) } });
    expect(good.body.ok).toBe(true);
    const bad = await callAuth({ method: "GET", headers: {}, query: { token: `${makeTpToken(exp).slice(0, -2)}xx` } });
    expect(bad.body.ok).toBe(false);
    const expired = await callAuth({ method: "GET", headers: {}, query: { token: makeTpToken(Math.floor(Date.now() / 1000) - 60) } });
    expect(expired.body.ok).toBe(false);
    expect(expired.body.expired).toBe(true);
    const garbage = await callAuth({ method: "GET", headers: {}, query: { token: "garbage" } });
    expect(garbage.body.ok).toBe(false);
  });

  it("POST verify exchanges a valid link for a session, rejects the rest", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const ol = mintOwnerLoginToken("test-admin-token", nowSec);
    const good = await callAuth({ method: "POST", headers: {}, body: { action: "verify", ol } });
    expect(good.body.ok).toBe(true);
    expect(typeof good.body.session).toBe("string");
    expect((good.body.session as string).startsWith("os1.")).toBe(true);
    const bad = await callAuth({ method: "POST", headers: {}, body: { action: "verify", ol: "ol1.1.x" } });
    expect(bad.status).toBe(401);
    expect(bad.body.ok).toBe(false);
  });

  it("POST send answers ok (link email path)", async () => {
    const r = await callAuth({ method: "POST", headers: {}, body: { action: "send" } });
    expect(r.body.ok).toBe(true);
  });
});
