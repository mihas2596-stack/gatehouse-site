// @vitest-environment node
// N2: unknown paths are answered with a real HTTP 404 and a small branded
// page — no longer HTTP 200 with the SPA shell. The handler lives in
// api/_not_found.ts (an underscore helper, not a function: the Hobby plan
// allows only 12 functions) and the catch-all rewrite in vercel.json
// points at /api/owner-auth?notfound=1, answered by the owner-auth
// handler before any origin/auth check.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { notFoundHandler } from "../../api/_not_found";
import ownerAuthHandler from "../../api/owner-auth";

function mockRes() {
  return {
    code: 0,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    jsonBody: undefined as unknown,
    ended: false,
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.jsonBody = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(body?: string) { this.body = body; this.ended = true; },
  };
}

describe("api/not-found (via api/_not_found)", () => {
  it("GET returns 404 with a branded noindex page linking home and /quote", async () => {
    const res = mockRes();
    await notFoundHandler({ method: "GET", headers: {}, query: {} }, res);
    expect(res.code).toBe(404);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.body).toContain("404 — Page not found");
    expect(res.body).toContain('href="/"');
    expect(res.body).toContain('href="/quote"');
    expect(res.body).toContain('content="noindex"');
    expect(res.body).not.toContain("<script");
  });

  it("GET page carries the site header and footer (09.11 live finding)", async () => {
    const res = mockRes();
    await notFoundHandler({ method: "GET", headers: {}, query: {} }, res);
    // Header: logo + nav + See My Price, matching Header.tsx.
    expect(res.body).toContain("<header>");
    expect(res.body).toContain("Gatehouse Home Cleaning");
    expect(res.body).toContain('href="/services"');
    expect(res.body).toContain('href="/whats-included"');
    expect(res.body).toContain('href="/areas"');
    expect(res.body).toContain('href="/faq"');
    expect(res.body).toContain("See My Price");
    // Footer: phone, email, cities and footer nav, matching Footer.tsx.
    expect(res.body).toContain("<footer>");
    expect(res.body).toContain('href="tel:+17705258599"');
    expect(res.body).toContain("(770) 525-8599");
    expect(res.body).toContain("hello@gatehousehomecleaning.com");
    expect(res.body).toContain("Sugar Hill");
    expect(res.body).toContain('href="/terms"');
    expect(res.body).toContain('href="/privacy"');
    expect(res.body).toContain("Gatehouse Home Cleaning. All rights reserved.");
  });

  it("HEAD returns 404 headers with no body", async () => {
    const res = mockRes();
    await notFoundHandler({ method: "HEAD", headers: {}, query: {} }, res);
    expect(res.code).toBe(404);
    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
  });
});

describe("api/owner-auth routes ?notfound=1 to the 404", () => {
  it("GET ?notfound=1 answers 404 with the branded page", async () => {
    const res = mockRes();
    await ownerAuthHandler({ method: "GET", headers: {}, query: { notfound: "1" } }, res);
    expect(res.code).toBe(404);
    expect(res.body).toContain("404 — Page not found");
  });

  it("GET without notfound keeps the test-price check behavior", async () => {
    const res = mockRes();
    await ownerAuthHandler({ method: "GET", headers: {}, query: {} }, res);
    expect(res.code).toBe(200);
    expect(res.jsonBody).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe("vercel.json catch-all rewrite", () => {
  it("points unknown paths at owner-auth with ?notfound=1 (12-function limit)", () => {
    const cfg = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")) as {
      rewrites?: Array<{ source?: string; destination?: string }>;
    };
    const catchAll = (cfg.rewrites ?? []).find((r) => r.source === "/(.*)");
    expect(catchAll?.destination).toBe("/api/owner-auth?notfound=1");
    const functions = (cfg as { functions?: Record<string, unknown> }).functions ?? {};
    expect(Object.keys(functions)).not.toContain("api/not-found.ts");
  });
});
