// @vitest-environment node
// S13 follow-up (audit 09.11.2026): creating the card-save Checkout
// session pins the Stripe customer on the booking row
// (gh_visits.stripe_customer_id), so the C13 row binding fires for
// every booking — not only cleaner-link ones. Populate-only: an
// existing pin is never overwritten. Best-effort: a failed write
// must not block the card save.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { signBooking } from "../../api/create-checkout-session";

const EMAIL = "client@example.com";
const NAME = "Casey Client";

let supabasePatches: Array<{ url: string; body: Record<string, unknown> }>;
let stripeCustomersCreated: string[];

function response() {
  const res = {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

function installFetch(opts: { reuseCustomer?: { id: string }; patchFails?: boolean } = {}) {
  supabasePatches = [];
  stripeCustomersCreated = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.hostname.includes("supabase")) {
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        supabasePatches.push({ url: String(url), body });
        if (opts.patchFails) return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        return { ok: true, status: 200, json: async () => [{ id: "row-1" }], text: async () => "[{\"id\":\"row-1\"}]" };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname === "/v1/customers" && method === "GET") {
        const data = opts.reuseCustomer ? [{ id: opts.reuseCustomer.id, email: EMAIL }] : [];
        return { ok: true, status: 200, json: async () => ({ data }) };
      }
      if (u.pathname === "/v1/customers" && method === "POST") {
        stripeCustomersCreated.push("cus_new_1");
        return { ok: true, status: 200, json: async () => ({ id: "cus_new_1" }) };
      }
      const custM = u.pathname.match(/^\/v1\/customers\/(cus_[A-Za-z0-9_]+)$/);
      if (custM && method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: custM[1] }) };
      }
      if (u.pathname === "/v1/checkout/sessions" && method === "POST") {
        return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.com/pay/cs_test_1" }) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const token = () => signBooking("link-secret", { email: EMAIL, name: NAME }).token;

describe("S13: card-save pins stripe_customer_id on the booking row", () => {
  it("pins a newly created customer on the row, populate-only", async () => {
    installFetch();
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: {}, body: { bt: token() } } as any, res as any);
    expect(res.code).toBe(200);
    expect(typeof res.body["url"]).toBe("string");
    expect(supabasePatches).toHaveLength(1);
    expect(supabasePatches[0].url).toContain("/rest/v1/gh_visits?");
    expect(supabasePatches[0].url).toContain("stripe_customer_id=is.null");
    expect(supabasePatches[0].url).toContain("booking_id=eq.");
    expect(supabasePatches[0].body["stripe_customer_id"]).toBe("cus_new_1");
  });

  it("pins a reused customer too", async () => {
    installFetch({ reuseCustomer: { id: "cus_existing" } });
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: {}, body: { bt: token() } } as any, res as any);
    expect(res.code).toBe(200);
    expect(supabasePatches).toHaveLength(1);
    expect(supabasePatches[0].body["stripe_customer_id"]).toBe("cus_existing");
  });

  it("standalone save (no booking token) writes nothing to the DB", async () => {
    installFetch();
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: {}, body: { name: NAME, email: EMAIL } } as any, res as any);
    expect(res.code).toBe(200);
    expect(supabasePatches).toHaveLength(0);
  });

  it("a failed DB write does not block the card save", async () => {
    installFetch({ patchFails: true });
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: {}, body: { bt: token() } } as any, res as any);
    expect(res.code).toBe(200);
    expect(typeof res.body["url"]).toBe("string");
    expect(supabasePatches).toHaveLength(1);
  });
});
