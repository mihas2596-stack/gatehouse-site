// @vitest-environment node
// N2: unknown paths are answered by /api/not-found (the terminal rewrite
// target in vercel.json) with a real HTTP 404 and a small branded page —
// no longer HTTP 200 with the SPA shell.
import { describe, it, expect } from "vitest";
import handler from "../../api/not-found";

function mockRes() {
  return {
    code: 0,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    ended: false,
    status(code: number) { this.code = code; return this; },
    json() { throw new Error("not-found must not answer JSON"); },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(body?: string) { this.body = body; this.ended = true; },
  };
}

describe("api/not-found", () => {
  it("GET returns 404 with a branded noindex page linking home and /quote", async () => {
    const res = mockRes();
    await handler({ method: "GET", headers: {}, query: {} }, res);
    expect(res.code).toBe(404);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.body).toContain("404 — Page not found");
    expect(res.body).toContain('href="/"');
    expect(res.body).toContain('href="/quote"');
    expect(res.body).toContain('content="noindex"');
    expect(res.body).not.toContain("<script");
  });

  it("HEAD returns 404 headers with no body", async () => {
    const res = mockRes();
    await handler({ method: "HEAD", headers: {}, query: {} }, res);
    expect(res.code).toBe(404);
    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
  });
});
