// @vitest-environment node
// C16: a manual owner charge on the TIMER basis requires the 20h
// reminder to have gone out first (the cron's reminder-before-charge
// guard, applied to the manual charge). Without a reminder_sent journal
// event the charge is refused with needs_reminder_confirm and only
// proceeds on an explicit confirm_no_reminder. A client approval is the
// client's own engagement, so approved charges skip the guard; a charge
// with no basis at all keeps its existing payment_basis_missing error.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";

const BID = "bid-c16-reminder";
const VISIT_ID = "c16c16c1-6666-7777-8888-999999999999";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let piCalls: { amount: string }[];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
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
  };
  events = [created(), ev("report_sent", { version: 1 }, hoursAgo(30))];
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent", gh_report_sent_at: hoursAgo(30),
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
    gh_payment_method: "pm_1", gh_report_version: "1",
  };
  piCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") return okRes({ id: "email-1" });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: "cus_c16", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
      }
      if (u.pathname.endsWith("/payment_intents/search")) return okRes({ data: [] });
      if (u.pathname.endsWith("/payment_intents")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        piCalls.push({ amount: params.get("amount") ?? "" });
        return okRes({ id: "pi_1", status: "succeeded" });
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
          return okRes({ id: "cus_c16" });
        }
        return okRes({ id: "cus_c16", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_c16" });
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

describe("C16 manual charge reminder guard", () => {
  it("timer basis with no reminder is refused with needs_reminder_confirm, no intent", async () => {
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("needs_reminder_confirm");
    expect(r.body["needs_reminder_confirm"]).toBe(true);
    expect(piCalls).toHaveLength(0);
  });

  it("timer basis with confirm_no_reminder charges once and journals the override", async () => {
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1, confirm_no_reminder: true });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piCalls).toHaveLength(1);
    expect(events.some((e) => e.event === "charge_without_reminder")).toBe(true);
  });

  it("timer basis with a reminder_sent event charges without confirmation", async () => {
    events = [...events, ev("reminder_sent", {}, hoursAgo(10))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piCalls).toHaveLength(1);
  });

  it("client approval charges without a reminder and without confirmation", async () => {
    row = { ...row, report_sent_at: hoursAgo(5) };
    storeMeta = { ...storeMeta, gh_report_sent_at: hoursAgo(5) };
    events = [created(), ev("report_sent", { version: 1 }, hoursAgo(5)), ev("report_approved", {}, hoursAgo(1))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(piCalls).toHaveLength(1);
  });

  it("no basis at all keeps payment_basis_missing, not the reminder error", async () => {
    row = { ...row, report_sent_at: hoursAgo(5) };
    storeMeta = { ...storeMeta, gh_report_sent_at: hoursAgo(5) };
    events = [created(), ev("report_sent", { version: 1 }, hoursAgo(5))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_basis_missing");
    expect(piCalls).toHaveLength(0);
  });
});
