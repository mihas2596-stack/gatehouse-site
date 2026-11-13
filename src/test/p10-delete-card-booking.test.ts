// @vitest-environment node
// P10: delete_card can unbind someone else's card — it took the card
// from the client's shared metadata, not from this booking's card.
// The card to detach is this booking's own card_confirmed event; the
// shared pointer is cleared only when it names THIS card; with no
// card_confirmed for this booking there is nothing to detach.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const TOKEN = "adm-" + "secret";
const VISIT_ID = "55555555-6666-7777-8888-999999999999";
const BID = "bid-p10";
const PM_THIS = "pm_this_booking_123";
const PM_OTHER = "pm_other_booking_456";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

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

const CUSTOMER = {
  id: "cus_test_p10",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready", gh_payment_method: PM_OTHER },
};

describe("P10: delete_card detaches this booking's card, never another booking's", () => {
  let rows: Row[];
  let events: Ev[];
  let stripeCalls: Array<{ url: string; method: string; body: string }>;

  const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
    ({ event, detail, created_at });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "confirmed",
      report_status: "none",
      visit_date: "2027-01-15",
      window: "midday",
      cleaner_name: "Ana",
      amount_cents: 14900,
      client_email: "client@example.com",
      client_name: "Casey Client",
    }];
    events = [
      ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-11-17T10:00:00.000Z"),
      ev("card_confirmed", { payment_method_id: PM_THIS }, "2026-11-17T11:00:00.000Z"),
    ];
    stripeCalls = [];
    const supRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.stripe.com")) {
        stripeCalls.push({ url: u, method, body: String(init?.body ?? "") });
        if (u.includes("/customers/search")) return supRes({ data: [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
        if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
        if (u.includes("/payment_methods")) return supRes({ data: [] });
        return supRes({ id: CUSTOMER.id });
      }
      if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
      if (u.includes("/rest/v1/gh_visits")) return supRes(rows.slice(0, 1));
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") return supRes([{ id: events.length }]);
        return supRes([...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 60));
      }
      return supRes({}, false, 404);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const call = async (body: Record<string, unknown>) => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body } as never,
      r as never,
    );
    return r;
  };

  const detachCalls = () => stripeCalls.filter((c) => c.url.includes("/payment_methods/") && c.url.includes("/detach"));
  const customerPosts = () => stripeCalls.filter((c) => c.url.includes(`/customers/${CUSTOMER.id}`) && c.method === "POST");

  it("detaches THIS booking's card even when the shared pointer names another booking's card", async () => {
    const r = await call({ action: "delete_card", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(detachCalls()).toHaveLength(1);
    expect(detachCalls()[0].url).toContain(`/payment_methods/${PM_THIS}/detach`);
    expect(detachCalls()[0].url).not.toContain(PM_OTHER);
    // The other booking's pointer survives untouched.
    const posts = customerPosts();
    expect(posts.length).toBeGreaterThan(0);
    const last = posts[posts.length - 1];
    expect(last.body).not.toContain("metadata%5Bgh_payment_method%5D=");
    expect(last.body).toContain("metadata%5Bgh_state%5D=awaiting_card");
  });

  it("clears the shared pointer when it names this booking's card", async () => {
    CUSTOMER.metadata.gh_payment_method = PM_THIS;
    const r = await call({ action: "delete_card", booking_id: BID });
    expect(r.body["ok"]).toBe(true);
    expect(detachCalls()[0].url).toContain(`/payment_methods/${PM_THIS}/detach`);
    const posts = customerPosts();
    const last = posts[posts.length - 1];
    expect(last.body).toContain("metadata%5Bgh_payment_method%5D=");
  });

  it("refuses when this booking never confirmed a card — nothing is detached", async () => {
    events = events.filter((e) => e.event !== "card_confirmed");
    const r = await call({ action: "delete_card", booking_id: BID });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("no_card_for_booking");
    expect(detachCalls()).toHaveLength(0);
  });
});
