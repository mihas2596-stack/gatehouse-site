// @vitest-environment node
// P8: decline_date without a status check lets the owner decline the
// date after the report is sent (or the visit is paid) — the client
// page moves to date_declined and accept_alt_date can then move the
// visit date while the sent report and its 24h charge timer still
// point at the old one. Declines are only for unconfirmed, unreported
// requests.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const TOKEN = "adm-" + "secret";
const VISIT_ID = "33333333-4444-5555-6666-777777777777";
const BID = "bid-p8-decline";

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
  id: "cus_test_p8",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "requested" },
};

describe("P8: decline_date refuses a sent report or a paid visit", () => {
  let rows: Row[];
  let events: Ev[];
  let resendCalls: number;

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
      report_status: "sent",
      report_sent_at: "2026-11-18T12:00:00.000Z",
      visit_date: "2027-01-15",
      window: "midday",
      cleaner_name: "Ana",
      amount_cents: 14900,
      client_email: "client@example.com",
      client_name: "Casey Client",
    }];
    events = [
      ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-11-17T10:00:00.000Z"),
      ev("report_sent", { version: 1, email_sent: true }, "2026-11-18T12:00:00.000Z"),
    ];
    resendCalls = 0;
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
        if (u.includes(`/customers/${CUSTOMER.id}`) && method === "GET") return supRes({ ...CUSTOMER, metadata: { ...CUSTOMER.metadata } });
        return supRes({ id: CUSTOMER.id });
      }
      if (u.includes("api.resend.com")) { resendCalls++; return supRes({ id: "email-1" }); }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          for (const r of rows) Object.assign(r, patch);
          return supRes(rows);
        }
        return supRes(rows.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          events.push({ event: String(body["event"] ?? ""), detail: (body["detail"] as Record<string, unknown> | null) ?? null, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
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

  it("refuses to decline the date once the report is sent — no email, no event", async () => {
    const r = await call({ action: "decline_date", booking_id: BID, alt_dates: ["2027-01-20"] });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_already_sent");
    expect(resendCalls).toBe(0);
    expect(events.some((e) => e.event === "date_proposed")).toBe(false);
  });

  it("refuses to decline the date once the visit is paid", async () => {
    rows[0]["status"] = "paid";
    rows[0]["report_status"] = "sent";
    const r = await call({ action: "decline_date", booking_id: BID, alt_dates: ["2027-01-20"] });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_already_sent");
    expect(resendCalls).toBe(0);
  });

  it("refuses to decline the date while a charge is in flight", async () => {
    rows[0]["status"] = "payment_pending";
    const r = await call({ action: "decline_date", booking_id: BID, alt_dates: ["2027-01-20"] });
    expect(r.code).toBe(409);
    expect(resendCalls).toBe(0);
  });

  it("still declines the date for an unreported request", async () => {
    rows[0]["report_status"] = "none";
    rows[0]["report_sent_at"] = null;
    const r = await call({ action: "decline_date", booking_id: BID, alt_dates: ["2027-01-20"] });
    expect(r.body["ok"]).toBe(true);
    expect(resendCalls).toBe(1);
    expect(events.some((e) => e.event === "date_proposed")).toBe(true);
  });
});
