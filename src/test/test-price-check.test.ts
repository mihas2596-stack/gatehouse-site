import { describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "crypto";
import handler from "../../api/test-price-check";

vi.stubEnv("ADMIN_TOKEN", "test-admin-token");

const makeToken = (exp: number, email = "owner@example.com"): string => {
  const key = createHash("sha256").update("gatehouse-test-price:test-admin-token").digest();
  const emailB64 = Buffer.from(email, "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(`tp1.${exp}.${emailB64}`).digest("base64url");
  return `tp1.${exp}.${emailB64}.${sig}`;
};

const call = async (token: string) => {
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
  } as never;
  await handler({ method: "GET", query: { token } } as never, res);
  return { status, body: body as { ok: boolean; expired?: boolean } };
};

describe("test-price-check", () => {
  it("accepts a valid signed token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const r = await call(makeToken(exp));
    expect(r.body.ok).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const good = makeToken(exp);
    const bad = good.slice(0, -2) + "xx";
    const r = await call(bad);
    expect(r.body.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const r = await call(makeToken(exp));
    expect(r.body.ok).toBe(false);
    expect(r.body.expired).toBe(true);
  });

  it("rejects a token without the tp1 shape", async () => {
    const r = await call("garbage");
    expect(r.body.ok).toBe(false);
  });
});
