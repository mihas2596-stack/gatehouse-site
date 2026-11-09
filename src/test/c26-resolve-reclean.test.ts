// @vitest-environment node
// C26 / Terms §7: resolve validates the agreed re-clean date —
// YYYY-MM-DD, a real calendar date, not in the past, and within 72h
// of the issue being reported (issue_opened event). An invalid date is
// 400, a date past the 72h window is 409 reclean_date_too_late.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";

const BID = "bid-c26-reclean";
const VISIT_ID = "c26c26c2-6666-7777-8888-999999999999";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const daysFromNow = (d: number) => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
  ({ event, detail, created_at });
const created = () => ev("visit_created", {}, hoursAgo(50));

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

const call = async (body: Record<string, unknown>) => {
  const r = res();
  await handler(
    { method: "POST", headers: { authorization: "Bearer adm-secret" }, body: { booking_id: BID, ...body } },
    r as never,
  );
  return r;
};

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  row = {
    id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 20000,
    cleaner_name: null, client_email: "client@example.com",
    report_sent_at: hoursAgo(30), report_bounced: false, report_status: "sent",
    visit_date: "2027-01-15", window: "midday",
    issue_open: true, issue_ever: true,
  };
  // Issue reported 2h ago: the 72h re-clean window runs to +70h.
  events = [created(), ev("issue_opened", { reason: "streaks", room: "Kitchen" }, hoursAgo(2))];
  storeMeta = {
    gh_booking_id: BID, gh_state: "issue_open", gh_issue_open: "1",
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
    gh_payment_method: "pm_1", gh_report_version: "1",
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") return okRes({ id: "email-1" });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: "cus_c26", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
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
          return okRes({ id: "cus_c26" });
        }
        return okRes({ id: "cus_c26", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_c26" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        Object.assign(row, JSON.parse(String(init?.body ?? "{}")) as Row);
        return okRes([row]);
      }
      return okRes([row]);
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
    if (u.pathname.includes("/rest/v1/gh_photos")) return okRes([]);
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("C26 resolve validates reclean_date (Terms §7, 72h)", () => {
  it("a re-clean date within 72h of the issue resolves", async () => {
    const r = await call({ action: "resolve", reclean_date: daysFromNow(1) });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("approved");
    expect(row["issue_open"]).toBe(false);
    expect(storeMeta["gh_reclean_date"]).toBe(daysFromNow(1));
  });

  it("a non-date string is 400 invalid_reclean_date", async () => {
    const r = await call({ action: "resolve", reclean_date: "tomorrow-ish" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_reclean_date");
    expect(row["issue_open"]).toBe(true);
  });

  it("an impossible calendar date is 400 invalid_reclean_date", async () => {
    const r = await call({ action: "resolve", reclean_date: "2026-02-30" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_reclean_date");
  });

  it("a past date is 400 invalid_reclean_date", async () => {
    const r = await call({ action: "resolve", reclean_date: daysFromNow(-1) });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("invalid_reclean_date");
  });

  it("a date past 72h after the issue is 409 reclean_date_too_late", async () => {
    // Issue opened 2h ago: +4 days is past the +72h deadline.
    const r = await call({ action: "resolve", reclean_date: daysFromNow(4) });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("reclean_date_too_late");
    expect(r.body["reclean_by"]).toBeTruthy();
    expect(row["issue_open"]).toBe(true);
  });

  it("no reclean_date still resolves (it stays optional)", async () => {
    const r = await call({ action: "resolve" });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("approved");
  });
});
