// @vitest-environment node
// Starting another card setup must preserve any earlier payment and booking state.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { signBooking } from "../../api/create-checkout-session";

const LINK_SECRET = "test-link-secret-rebind-2026";
const BID = "bid-g3z-rebind";

let dbRow: Record<string, unknown> | null;
let customerMeta: Record<string, string> | null;
let customerMetaFails: boolean;
let rebindBody: URLSearchParams | null;
let sessionCalls: number;
let sessionKeys: string[];
let sessionCustomers: string[];

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
  dbRow = { id: "row-g3z-1", booking_id: BID, status: "requested", amount_cents: 2190 };
  customerMeta = { gh_last_payment: "pi_old_123", gh_fee_last_payment: "pi_fee_456", gh_booking_confirmed: "1" };
  customerMetaFails = false;
  rebindBody = null;
  sessionCalls = 0;
  sessionKeys = [];
  sessionCustomers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string,string> }) => {
    const u = new URL(String(url));
    const ok = (data: unknown) => ({
      ok: true, status: 200,
      json: async () => data, text: async () => JSON.stringify(data),
    });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && table === "gh_visits") return ok(dbRow ? [dbRow] : []);
      return ok([]);
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "GET") {
        return ok({ data: [{ id: "cus_old", email: "client@example.com" }] });
      }
      if (u.pathname === "/v1/customers/cus_old" && (init?.method ?? "GET") === "GET") {
        if (customerMetaFails) return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        return ok({ id: "cus_old", email: "client@example.com", metadata: customerMeta });
      }
      if (u.pathname === "/v1/customers/cus_old" && (init?.method ?? "GET") === "POST") {
        rebindBody = new URLSearchParams(String(init?.body ?? ""));
        return ok({ id: "cus_old" });
      }
      if (u.pathname === "/v1/customers" && init?.method === "POST") return ok({ id: "cus_new" });
      if (u.pathname === "/v1/checkout/sessions") {
        sessionCalls++;
        sessionKeys.push(init?.headers?.["Idempotency-Key"] ?? "");
        sessionCustomers.push(new URLSearchParams(String(init?.body)).get("customer") ?? "");
        return ok({ id: "cs_test_x", url: "https://checkout.stripe.com/pay/cs_test_x" });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const token = () => signBooking(LINK_SECRET, {
  bid: BID, email: "client@example.com", name: "Casey Client",
}).token;
// O-008: the attempt identity is the client-supplied request_id — the
// same request_id is one attempt (same key, Stripe replays the session),
// a fresh request_id is a fresh attempt (fresh key, fresh session).
const RID = "11111111-2222-4333-8444-555555555555";
const reqWithToken = (requestId: string = RID) => ({ method: "POST", headers: {}, body: { bt: token(), request_id: requestId } });

describe("card setup preserves payment history", () => {
  it("does not rebind an unrelated same-email customer or mutate its payment history", async () => {
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(200);
    expect(sessionCalls).toBe(1);
    expect(sessionCustomers).toEqual(["cus_new"]);
    expect(rebindBody).toBeNull();
  });

  it("reuses the visit's stored customer without resetting its lifecycle", async () => {
    dbRow!.stripe_customer_id = "cus_old";
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(200);
    expect(sessionCalls).toBe(1);
    expect(sessionCustomers).toEqual(["cus_old"]);
    expect(rebindBody).toBeNull();
  });

  it("retries one setup with the same key and starts a fresh one for a reissued link", async () => {
    const request = reqWithToken();
    await handler(request as never, res() as never);
    await handler(request as never, res() as never);
    await handler(reqWithToken("99999999-8888-4777-8666-555555555555") as never, res() as never);
    expect(sessionKeys[0]).toMatch(/^setup_/);
    expect(sessionKeys[1]).toBe(sessionKeys[0]);
    expect(sessionKeys[2]).not.toBe(sessionKeys[0]);
  });

  it("stops when an existing customer binding cannot be verified", async () => {
    dbRow!.stripe_customer_id = "cus_old";
    customerMetaFails = true;
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(503);
    expect(sessionCalls).toBe(0);
    expect(rebindBody).toBeNull();
  });
});
