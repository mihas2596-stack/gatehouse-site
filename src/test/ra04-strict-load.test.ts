// @vitest-environment node
// RA04: a failed visit-row read must fail closed. When Supabase
// answers 500 for gh_visits, a client approve and an owner charge
// both surface 502 db_unreadable and create no PaymentIntent — they
// must NOT silently fall back to shared customer metadata (which
// would hide an issue_ever ban stored only in the row). A genuine
// "no row" (empty array) is a different outcome: the legacy path
// proceeds, and the error is never db_unreadable.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import bookingAction from "../../api/booking-action";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-ra04";
const SENT_AT = new Date(Date.now() - 30 * 3600 * 1000).toISOString();

let visitsFail: boolean;
let piCalls: number;

function response() {
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
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  visitsFail = false;
  piCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.stripe.com") {
      const meta = {
        gh_booking_id: BID, gh_state: "report_sent", gh_report_sent_at: SENT_AT,
        gh_report_version: "1", gh_report_amount_cents: "20000",
        gh_first_price_cents: "20000", gh_payment_method: "pm_1",
      };
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: "cus_ra04", email: "client@example.com", name: "Casey Client", metadata: meta }] });
      }
      if (u.pathname.endsWith("/payment_intents/search")) return okRes({ data: [] });
      if (u.pathname.endsWith("/payment_intents")) {
        piCalls++;
        return okRes({ id: "pi_ra04", status: "succeeded" });
      }
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) return okRes({ id: "cus_ra04", email: "client@example.com", name: "Casey Client", metadata: meta });
      return okRes({ id: "cus_ra04" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (visitsFail) return okRes({ error: { message: "db down" } }, 500);
      return okRes([]);
    }
    if (u.pathname.includes("/rest/v1/gh_events")) return okRes([]);
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA04 strict row load", () => {
  it("client approve fails closed when the visit row cannot be read", async () => {
    visitsFail = true;
    const bt = signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client" }).token;
    const res = response();
    await reportHandler({ method: "POST", headers: {}, body: { bt, action: "approve", seen_publication_id: SENT_AT } }, res as never);
    expect(res.code).toBe(502);
    expect(res.body["error"]).toBe("db_unreadable");
    expect(piCalls).toBe(0);
  });

  it("owner charge fails closed when the visit row cannot be read", async () => {
    visitsFail = true;
    const res = response();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer adm-secret", origin: "https://www.gatehousehomecleaning.com" }, body: { booking_id: BID, action: "charge", amount_cents: 20000 } },
      res as never,
    );
    expect(res.code).toBe(502);
    expect(res.body["error"]).toBe("db_unreadable");
    expect(piCalls).toBe(0);
  });

  it("a genuine no-row result is not a read error", async () => {
    visitsFail = false;
    const bt = signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client" }).token;
    const res = response();
    await reportHandler({ method: "POST", headers: {}, body: { bt, action: "approve", seen_publication_id: SENT_AT } }, res as never);
    expect(res.body["error"]).not.toBe("db_unreadable");
  });
});
