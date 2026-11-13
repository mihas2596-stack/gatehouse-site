// @vitest-environment node
// H7: dbSelect swallows errors as "no rows" — every GET showed a
// wrong empty state on a DB failure (cleaner saw invalid_link, owner
// saw an empty list, client saw card_needed, report empty). Primary
// reads on GET are now strict and return 502 on DB errors.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import cleanerHandler from "../../api/cleaner";
import ownerHandler from "../../api/owner";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";

const TOKEN = "adm-" + "secret";
const BID = "bid-h7";
const VISIT_ID = "99999999-0000-1111-2222-333333333333";

type Row = Record<string, unknown>;

let dbFailVisits: boolean;
let dbFailCleaners: boolean;
let rows: Row[];

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
  id: "cus_test_h7",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "report_sent" },
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", TOKEN);
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbFailVisits = false;
  dbFailCleaners = false;
  rows = [{
    id: VISIT_ID, booking_id: BID, visit_no: 1, status: "confirmed",
    report_status: "none", report_sent_at: null, visit_date: "2027-01-15",
    window: "midday", cleaner_name: "Ana", client_email: "client@example.com",
    client_name: "Casey Client", amount_cents: 14900,
  }];
  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("api.stripe.com")) {
      if (u.includes("/customers/search")) return supRes({ data: [{ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } }] });
      if (u.includes("/payment_methods")) return supRes({ data: [] });
      if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
      return supRes({ id: CUSTOMER.id });
    }
    if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
    if (u.includes("/rest/v1/gh_visits")) {
      if (dbFailVisits) return supRes({ error: { message: "db down" } }, false, 500);
      return supRes(rows.slice(0, 1));
    }
    if (u.includes("/rest/v1/gh_cleaners")) {
      if (dbFailCleaners) return supRes({ error: { message: "db down" } }, false, 500);
      return supRes([{ id: "roster-ana-1", name: "Ana", active: true }]);
    }
    if (u.includes("/rest/v1/gh_events")) return supRes([]);
    if (u.includes("/rest/v1/gh_photos")) return supRes([]);
    if (u.includes("/rest/v1/gh_visit_access")) return supRes([]);
    return supRes({}, false, 404);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const bt = () => signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client", date: "2027-01-15" }).token;

describe("H7: strict GET reads return 502 on DB errors, never a wrong empty state", () => {
  it("visit GET: a failed row read is 502 db_unreadable, not card_needed", async () => {
    dbFailVisits = true;
    const r = res();
    await visitHandler({ method: "GET", headers: {}, query: { bt: bt() } } as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_unreadable");
    expect(r.body["state"]).not.toBe("card_needed");
  });

  it("visit GET: a readable row still loads (no regression)", async () => {
    const r = res();
    await visitHandler({ method: "GET", headers: {}, query: { bt: bt() } } as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
  });

  it("cleaner GET: a failed row read is 502 db_unavailable, not invalid_link", async () => {
    dbFailVisits = true;
    const r = res();
    await cleanerHandler({ method: "GET", headers: {}, query: { ct: "test-cleaner-token-1234567890" } } as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_unavailable");
  });

  it("cleaner GET: a missing row is still invalid_link (no row, not a DB error)", async () => {
    rows = [];
    const r = res();
    await cleanerHandler({ method: "GET", headers: {}, query: { ct: "test-cleaner-token-1234567890" } } as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["error"]).toBe("invalid_link");
  });

  it("owner list: a failed read is 502 db_error, not an empty list", async () => {
    dbFailVisits = true;
    const r = res();
    await ownerHandler({ method: "GET", headers: { authorization: "Bearer " + TOKEN }, query: { view: "list" } } as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
    expect(r.body["visits"]).toBeUndefined();
  });

  it("owner roster: a failed read is 502 db_error, not an empty directory", async () => {
    dbFailCleaners = true;
    const r = res();
    await ownerHandler({ method: "GET", headers: { authorization: "Bearer " + TOKEN }, query: { view: "roster" } } as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
    expect(r.body["cleaners"]).toBeUndefined();
  });

  it("report GET: a failed row read is 502 db_unreadable, not an empty report", async () => {
    dbFailVisits = true;
    const r = res();
    await reportHandler({ method: "GET", headers: {}, query: { bt: bt() } } as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_unreadable");
    expect(r.body["state"]).not.toBe("not_ready");
  });
});
