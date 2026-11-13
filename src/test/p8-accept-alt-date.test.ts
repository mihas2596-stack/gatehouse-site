// @vitest-environment node
// P8: accept_alt_date moves the visit date without changing status —
// after a sent report it lets the timer charge before the new date.
// Accepting an alternative date must be refused once a report is
// sent; the idempotent replay (the row already has THIS date) still
// heals the shared metadata.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-p8-alt";
const VISIT_ID = "44444444-5555-6666-7777-888888888888";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let rows: Row[];
let events: Ev[];
let storeMeta: Record<string, string>;

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

const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
  ({ event, detail, created_at });

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID, booking_id: BID, visit_no: 1, status: "confirmed",
    report_status: "none", report_sent_at: null, report_bounced: false,
    visit_date: "2027-01-15", window: "midday", service: "Standard cleaning",
    client_name: "Casey Client", client_email: "client@example.com",
    amount_cents: 14900, cleaner_name: "Taylor Allen", cleaner_id: "cleaner-1",
    cleaner_profile: null, access_notes: null, no_photo_zones: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T00:00:00Z"));
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("ADMIN_TOKEN", "adm-" + "secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [makeRow()];
  events = [
    ev("visit_created", {}, "2026-10-20T10:00:00.000Z"),
    ev("visit_confirmed", { date: "2027-01-15", window: "midday" }, "2026-10-23T10:00:00.000Z"),
    // The owner's decline, with the offered alternative dates — the
    // decline is live only while this event is newer than the latest
    // confirmation (buildEffectiveMeta).
    ev("date_proposed", { date: "2027-01-15", alt_dates: "2027-01-20" }, "2026-11-18T09:00:00.000Z"),
  ];
  storeMeta = {
    gh_booking_id: BID, gh_state: "date_declined", gh_alt_dates: "2027-01-20",
    gh_confirmed_window: "midday", gh_first_price_cents: "14900",
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") return okRes({ id: "email-1" });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
      }
      if (u.pathname.endsWith("/payment_methods")) return okRes({ data: [] });
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return okRes({ id: "cus_v" });
        }
        return okRes({ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_v" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const matched: Row[] = [];
        for (const r of rows) {
          const qId = u.searchParams.get("id");
          if (qId && qId === `eq.${r["id"]}`) { Object.assign(r, patch); matched.push(r); }
        }
        return okRes(matched);
      }
      return okRes([...rows].slice(0, 1));
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null };
        events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString() });
        return okRes([{ id: events.length }]);
      }
      const out = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return okRes(out);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const bt = () => signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client", date: "2027-01-15" }).token;

const call = async (body: Record<string, unknown>) => {
  const r = res();
  await visitHandler({ method: "POST", headers: {}, body: { bt: bt(), ...body } } as never, r as never);
  return r;
};

describe("P8: accept_alt_date refuses to move the date after a report is sent", () => {
  it("409s when the report is already sent — the row date is untouched", async () => {
    rows[0]["report_status"] = "sent";
    rows[0]["report_sent_at"] = "2026-11-18T12:00:00.000Z";
    events.push(ev("report_sent", { version: 1, email_sent: true }, "2026-11-18T12:00:00.000Z"));
    const r = await call({ action: "accept_alt_date", date: "2027-01-20" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_already_sent");
    expect(rows[0]["visit_date"]).toBe("2027-01-15");
    expect(storeMeta["gh_confirmed_date"]).toBeUndefined();
  });

  it("still accepts the alternative date when no report is sent", async () => {
    const r = await call({ action: "accept_alt_date", date: "2027-01-20" });
    expect(r.code).toBe(200);
    expect(rows[0]["visit_date"]).toBe("2027-01-20");
    expect(storeMeta["gh_confirmed_date"]).toBe("2027-01-20");
    expect(storeMeta["gh_alt_dates"]).toBe("");
  });

  it("the idempotent replay still heals metadata when the row already has this date", async () => {
    // A prior attempt wrote the row + journal but the meta write
    // failed; the decline is consumed. The replay must not 409.
    rows[0]["visit_date"] = "2027-01-20";
    events.push(ev("visit_confirmed", { date: "2027-01-20", window: "midday" }, "2026-11-19T00:00:00.000Z"));
    const r = await call({ action: "accept_alt_date", date: "2027-01-20" });
    expect(r.code).toBe(200);
    expect(storeMeta["gh_confirmed_date"]).toBe("2027-01-20");
  });
});
