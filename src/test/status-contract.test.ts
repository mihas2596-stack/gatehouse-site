// @vitest-environment node
// O2: the status action returns state at the ROOT of the response, not
// under ops. (Kept in its own file: booking-action rate-limits 30 calls
// per minute per module instance, and the main booking-action suite
// already uses that budget.)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";

const BID = "bid-status-contract";
const CUSTOMER = {
  id: "cus_test_1",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready", gh_first_price_cents: "18900" },
};

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

let currentMeta: Record<string, string>;

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  currentMeta = { ...CUSTOMER.metadata };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("/customers/search")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: CUSTOMER.id, metadata: currentMeta }] }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`) && init?.body) {
      const params = new URLSearchParams(String(init.body));
      for (const [k, v] of params.entries()) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m) currentMeta[m[1]] = v;
      }
      return { ok: true, status: 200, json: async () => ({ id: CUSTOMER.id }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`)) {
      return { ok: true, status: 200, json: async () => ({ ...CUSTOMER, metadata: currentMeta }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("O2: status action returns state at the root", () => {
  it("state is top-level, not under ops", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body: { action: "status", booking_id: BID } } as any, res as any);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["state"]).toBe("card_ready");
    expect((res.body["ops"] as Record<string, unknown>)["state"]).toBeUndefined();
  });
});
