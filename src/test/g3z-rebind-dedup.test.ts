// @vitest-environment node
// G3 (rebind dedup marker): rebinding a shared Stripe customer to a new
// booking used to clear gh_last_payment / gh_fee_last_payment, so a
// redelivered payment_intent.succeeded could no longer be recognised
// from metadata. The rebind now carries the live dedup markers back
// into the patch (after the stale-lifecycle clear); other lifecycle
// keys are still cleared.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { signBooking } from "../../api/create-checkout-session";

const LINK_SECRET = "test-link-secret-rebind-2026";
const BID = "bid-g3z-rebind";

let dbRow: Record<string, unknown> | null;
let customerMeta: Record<string, string> | null;
let customerMetaFails: boolean;
let rebindBody: URLSearchParams | null;
let sessionCalls: number;

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
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
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
        return ok({ id: "cus_old", metadata: customerMeta });
      }
      if (u.pathname === "/v1/customers/cus_old" && (init?.method ?? "GET") === "POST") {
        rebindBody = new URLSearchParams(String(init?.body ?? ""));
        return ok({ id: "cus_old" });
      }
      if (u.pathname === "/v1/checkout/sessions") {
        sessionCalls++;
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
const reqWithToken = () => ({ method: "POST", headers: {}, body: { bt: token() } });

describe("G3: rebind carries the dedup markers", () => {
  it("re-asserts gh_last_payment / gh_fee_last_payment and still clears other lifecycle keys", async () => {
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(200);
    expect(sessionCalls).toBe(1);
    expect(rebindBody).not.toBeNull();
    expect(rebindBody!.get("metadata[gh_last_payment]")).toBe("pi_old_123");
    expect(rebindBody!.get("metadata[gh_fee_last_payment]")).toBe("pi_fee_456");
    expect(rebindBody!.get("metadata[gh_booking_confirmed]")).toBe("");
    expect(rebindBody!.get("metadata[gh_booking_id]")).toBe(BID);
  });

  it("still completes the rebind when the customer read fails (DB row stays the dedup authority)", async () => {
    customerMetaFails = true;
    const r = res();
    await handler(reqWithToken() as never, r as never);
    expect(r.code).toBe(200);
    expect(sessionCalls).toBe(1);
    expect(rebindBody).not.toBeNull();
    expect(rebindBody!.get("metadata[gh_last_payment]")).toBe("");
  });
});
