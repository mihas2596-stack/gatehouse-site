// @vitest-environment node
// O-008: the Stripe Checkout Session idempotency key must never be
// determined by the booking alone. Before this fix the key was
// sha256([base, bt, request_id ?? ""]) and the ThankYou page sent no
// request_id at all, so a repeat save-card for the same booking got
// Stripe to replay the original — possibly expired — session.
// Now: a client-supplied request_id (one fresh UUID per save-card
// attempt) pins retries of the same attempt to the same session, a
// fresh request_id gets a fresh session, and a request with no
// request_id gets a fresh server nonce per request.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { signBooking } from "../../api/create-checkout-session";

const LINK_SECRET = "test-link-secret-o008-2026";
const BID = "bid-o008";
const RID_A = "11111111-2222-4333-8444-555555555555";
const RID_B = "99999999-8888-4777-8666-555555555555";

let sessionKeys: string[];
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
  sessionKeys = [];
  sessionCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    const u = new URL(String(url));
    const ok = (data: unknown) => ({
      ok: true, status: 200,
      json: async () => data, text: async () => JSON.stringify(data),
    });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && table === "gh_visits") {
        return ok([{ id: "row-o008", booking_id: BID, status: "requested" }]);
      }
      return ok([]);
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname === "/v1/customers" && (init?.method ?? "GET") === "GET") {
        return ok({ data: [] });
      }
      if (u.pathname === "/v1/customers" && init?.method === "POST") {
        return ok({ id: "cus_o008" });
      }
      if (u.pathname === "/v1/checkout/sessions") {
        sessionCalls++;
        sessionKeys.push(init?.headers?.["Idempotency-Key"] ?? "");
        return ok({ id: "cs_test_o008", url: "https://checkout.stripe.com/pay/cs_test_o008" });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("O-008: setup-session idempotency key is per attempt, not per booking", () => {
  // One token value reused across calls: v2 tokens carry a random IV,
  // so minting a fresh token per call would change bt and hide the
  // key behaviour under test.
  const token = signBooking(LINK_SECRET, {
    bid: BID, email: "client@example.com", name: "Casey Client",
  }).token;
  const req = (extra: Record<string, unknown> = {}) => ({
    method: "POST", headers: {}, body: { bt: token, ...extra },
  });

  it("a retry of one attempt (same request_id) replays the same session key", async () => {
    const r1 = res();
    await handler(req({ request_id: RID_A }) as never, r1 as never);
    expect(r1.code).toBe(200);
    const r2 = res();
    await handler(req({ request_id: RID_A }) as never, r2 as never);
    expect(r2.code).toBe(200);
    expect(sessionCalls).toBe(2);
    expect(sessionKeys[0]).toMatch(/^setup_/);
    expect(sessionKeys[1]).toBe(sessionKeys[0]);
  });

  it("a repeat save-card for the same booking (fresh request_id) gets a fresh session key", async () => {
    await handler(req({ request_id: RID_A }) as never, res() as never);
    await handler(req({ request_id: RID_B }) as never, res() as never);
    expect(sessionCalls).toBe(2);
    expect(sessionKeys[0]).toMatch(/^setup_/);
    expect(sessionKeys[1]).toMatch(/^setup_/);
    expect(sessionKeys[1]).not.toBe(sessionKeys[0]);
  });

  it("a request with no request_id never replays the booking-determined key", async () => {
    await handler(req() as never, res() as never);
    await handler(req() as never, res() as never);
    expect(sessionCalls).toBe(2);
    expect(sessionKeys[0]).toMatch(/^setup_/);
    expect(sessionKeys[1]).toMatch(/^setup_/);
    expect(sessionKeys[1]).not.toBe(sessionKeys[0]);
  });
});
