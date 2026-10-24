// Owner email-link login tokens (owner order 2026-10-24): link tokens (ol1,
// 30 min) exchange for session tokens (os1, 24h); owner APIs accept the
// hand-typed key or a valid session via isOwnerAuth.
import { describe, expect, it } from "vitest";
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
