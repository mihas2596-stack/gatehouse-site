// @vitest-environment node
// G3: a Checkout Session must never be created for a cancelled,
// already-paid, refunded, or payment-in-flight booking (409).
// A live/requested booking, a token-only booking with no DB row, and
// a standalone (name/email, no token) request still get a session.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { signBooking } from "../../api/create-checkout-session";

const LINK_SECRET = "link-secret";
const BID = "bid-g3y-checkout";

let dbRow: Record<string, unknown> | null;
let dbError: boolean;
let sessionCalls: number;
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
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbRow = null;
  dbError = false;
  sessionCalls = 0;
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
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["url"]).toBe("https://checkout.stripe.com/pay/cs_test_x");
    expect(sessionCalls).toBe(1);
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
