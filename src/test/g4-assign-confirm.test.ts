// @vitest-environment node
// G4 (assign_confirm half): a change of person is decided by the stable
// roster ID, not the name. Two roster cleaners sharing a name must still
// rotate the cleaner link — otherwise the second person silently
// inherits the first one's access. Kept in its own file because
// booking-action rate-limits 30 calls/min per module instance.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const SECRET = "test-cleaner-secret-123";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const BID = "bid-g4-assign";

type Row = Record<string, unknown>;

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end: vi.fn(),
  };
}

const CUSTOMER = {
  id: "cus_test_g4",
  email: "client@example.com",
  name: "Casey Client",
  metadata: { gh_booking_id: BID, gh_state: "card_ready" },
};

describe("G4: assign_confirm rotates on roster-ID change, not name change", () => {
  let rows: Row[];
  let roster: Row[];

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("CLEANER_LINK_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "requested",
      report_status: "none",
      visit_date: "2027-01-15",
      window: "midday",
      cleaner_name: null,
      cleaner_token_hash: null,
      cleaner_token_expires: null,
      cleaner_link_version: null,
      cleaner_link_issuance: null,
      cleaner_profile: null,
      checklist: { rooms: [] },
    }];
    roster = [
      { id: "roster-ana-1", name: "Ana", phone: "+1 404 555 0100", photo_url: "https://example.com/ana1.jpg", active: true },
      { id: "roster-ana-2", name: "Ana", phone: "+1 404 555 0200", photo_url: "https://example.com/ana2.jpg", active: true },
    ];
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
      if (u.includes("/rest/v1/gh_cleaners")) {
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const id = qs.get("id");
        const out = id && id.startsWith("eq.")
          ? roster.filter((r) => r["id"] === decodeURIComponent(id.slice(3)))
          : [...roster];
        return supRes(out.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          for (const r of rows) {
            if (r["id"] === rows[0]["id"] || r["booking_id"] === BID) Object.assign(r, patch);
          }
          return supRes(null);
        }
        return supRes(rows.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") return supRes([{ id: 1 }]);
        return supRes([]);
      }
      return supRes({}, false, 404);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const call = async (body: Record<string, unknown>) => {
    const r = res();
    await bookingAction(
      { method: "POST", headers: { authorization: "Bearer adm-secret" }, body } as never,
      r as never,
    );
    return r;
  };

  it("same name, different roster ID rotates the link instead of no-op", async () => {
    const r1 = await call({
      action: "assign_confirm", booking_id: BID, cleaner_id: "roster-ana-1",
      confirmed_date: "2027-01-15", confirmed_window: "midday",
    });
    expect(r1.body["ok"]).toBe(true);
    expect(rows[0]["status"]).toBe("confirmed");
    const firstIssuance = rows[0]["cleaner_link_issuance"];
    expect(firstIssuance).toBeTruthy();

    // Same name, same date/window, different person: NOT an idempotent
    // re-confirm — the link rotates and the new ID is recorded.
    const r2 = await call({
      action: "assign_confirm", booking_id: BID, cleaner_id: "roster-ana-2",
      confirmed_date: "2027-01-15", confirmed_window: "midday",
    });
    expect(r2.body["ok"]).toBe(true);
    expect(r2.body["already_confirmed"]).toBe(false);
    expect(rows[0]["cleaner_id"]).toBe("roster-ana-2");
    expect(rows[0]["cleaner_link_issuance"]).not.toBe(firstIssuance);
  });
});
