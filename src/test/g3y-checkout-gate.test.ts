// @vitest-environment node
// G3: a Checkout Session must never be created for a cancelled,
// already-paid, refunded, or payment-in-flight booking (409).
// A live/requested booking, a token-only booking with no DB row, and
// a standalone (name/email, no token) request still get a session.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { signBooking } from "../../api/create-checkout-session";

const LINK_SECRET = "link-secret";
const BID = "bid-g3y-checkout";
const PUBLIC_SITE = "https://www.gatehousehomecleaning.com";
const PREVIEW_DEPLOYMENT = "https://gatehouse-site-example-team.vercel.app";
const PREVIEW_BRANCH = "https://gatehouse-site-git-review-team.vercel.app";

let dbRow: Record<string, unknown> | null;
let dbError: boolean;
let sessionCalls: number;
let sessionParams: URLSearchParams;
let customerCreateCalls: number;

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("BOOKING_LINK_SECRET", LINK_SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("VERCEL_URL", undefined);
  vi.stubEnv("VERCEL_BRANCH_URL", undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbRow = null;
  dbError = false;
  sessionCalls = 0;
  sessionParams = new URLSearchParams();
  customerCreateCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const ok = (data: unknown) => ({
      ok: true, status: 200,
      json: async () => data, text: async () => JSON.stringify(data),
    });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && table === "gh_visits") {
        if (dbError) return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        return ok(dbRow ? [dbRow] : []);
      }
      // The stripe_customer_id pin at the end is best-effort.
      return ok([]);
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "GET") {
        return ok({ data: [] });
      }
      if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "POST") {
        customerCreateCalls++;
        return ok({ id: "cus_new" });
      }
      if (u.pathname === "/v1/checkout/sessions") {
        sessionCalls++;
        sessionParams = new URLSearchParams(String(init?.body ?? ""));
        return ok({ id: "cs_test_x", url: "https://checkout.stripe.com/pay/cs_test_x" });
      }
      if (u.pathname.startsWith("/v1/customers/")) return ok({ id: "cus_new" });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const token = () => signBooking(LINK_SECRET, {
  bid: BID, email: "client@example.com", name: "Casey Client",
}).token;
const reqWithToken = () => ({ method: "POST", headers: {}, body: { bt: token() } });
const rowWith = (status: string): Record<string, unknown> => ({
  id: "row-g3y-1", booking_id: BID, status, amount_cents: 2190,
});

function expectReturnLinks(site: string, bookingToken: string) {
  const bt = encodeURIComponent(bookingToken);
  expect(sessionParams.get("mode")).toBe("setup");
  expect(sessionParams.get("success_url")).toBe(`${site}/save-card?saved=1&session_id={CHECKOUT_SESSION_ID}&bt=${bt}`);
  expect(sessionParams.get("cancel_url")).toBe(`${site}/save-card?canceled=1&bt=${bt}`);
}

describe("G3: checkout refused for over bookings", () => {
  it.each([
    ["cancelled", "visit_cancelled"],
    ["paid", "already_paid"],
    ["refunded", "already_refunded"],
    ["payment_pending", "payment_in_progress"],
  ])("status %s -> 409 %s and no Checkout Session is created", async (status, error) => {
    dbRow = rowWith(status);
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe(error);
    expect(sessionCalls).toBe(0);
    expect(customerCreateCalls).toBe(0);
  });

  it("a requested booking still gets a session", async () => {
    dbRow = rowWith("requested");
    const r = res();
    const req = reqWithToken();
    await handler(req as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["url"]).toBe("https://checkout.stripe.com/pay/cs_test_x");
    expect(sessionCalls).toBe(1);
    expectReturnLinks(PUBLIC_SITE, req.body.bt);
  });

  it("a token-only booking with no DB row still gets a session (legacy path)", async () => {
    dbRow = null;
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(200);
    expect(sessionCalls).toBe(1);
  });

  it("an unreadable DB fails closed with 503 instead of issuing a session blind", async () => {
    dbRow = rowWith("requested");
    dbError = true;
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(503);
    expect(r.body["error"]).toBe("db_unreadable");
    expect(sessionCalls).toBe(0);
  });

  it("a standalone name/email request (no token) is unaffected by the gate", async () => {
    const r = res();
    await handler({ method: "POST", headers: {}, body: { name: "Casey Client", email: "client@example.com" } } as never, r as never);
    expect(r.code).toBe(200);
    expect(sessionCalls).toBe(1);
  });
});

describe("Checkout return links", () => {
  it.each([PUBLIC_SITE, "https://gatehousehomecleaning.com", "http://localhost:8080"])(
    "preserves the supported origin %s",
    async (origin) => {
      const req = { ...reqWithToken(), headers: { origin } };
      const r = res();
      await handler(req, r);
      expect(r.code).toBe(200);
      expectReturnLinks(origin, req.body.bt);
    },
  );

  it.each([PREVIEW_DEPLOYMENT, PREVIEW_BRANCH, undefined])(
    "uses the deployment's preview site for origin %s",
    async (origin) => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("VERCEL_URL", new URL(PREVIEW_DEPLOYMENT).host);
      vi.stubEnv("VERCEL_BRANCH_URL", new URL(PREVIEW_BRANCH).host);
      const req = { ...reqWithToken(), headers: origin ? { origin } : {} };
      const r = res();
      await handler(req, r);
      expect(r.code).toBe(200);
      expectReturnLinks(origin ?? PREVIEW_DEPLOYMENT, req.body.bt);
      if (origin) expect(r.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", origin);
    },
  );

  it.each([PUBLIC_SITE, "https://gatehouse-site-other-team.vercel.app"])(
    "refuses an origin outside the running preview: %s",
    async (origin) => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("VERCEL_URL", new URL(PREVIEW_DEPLOYMENT).host);
      const r = res();
      await handler({ ...reqWithToken(), headers: { origin } }, r);
      expect(r.code).toBe(403);
      expect(r.body["error"]).toBe("origin_not_allowed");
      expect(sessionCalls).toBe(0);
    },
  );

  it("refuses a preview origin on the production deployment", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_URL", new URL(PREVIEW_DEPLOYMENT).host);
    const r = res();
    await handler({ ...reqWithToken(), headers: { origin: PREVIEW_DEPLOYMENT } }, r);
    expect(r.code).toBe(403);
    expect(sessionCalls).toBe(0);
  });

  it("does not start Stripe from a preview with no trusted host", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const r = res();
    await handler(reqWithToken(), r);
    expect(r.code).toBe(503);
    expect(sessionCalls).toBe(0);
  });
});
