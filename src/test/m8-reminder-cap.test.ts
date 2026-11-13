// @vitest-environment node
// M8: the auto-charge reminder passes (early 4h + 20h) were unlimited —
// only charges were capped at MAX_PER_RUN = 25. One cron run must send
// at most 25 reminders (early + 20h combined), like the charges.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import autoChargeHandler from "../../api/auto-charge";

const CRON = ["cron", "secret"].join("-");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

type Cust = { id: string; email: string; name: string; metadata: Record<string, string> };
let store: Cust[];
let dbRows: Record<string, unknown>[];
let dbEvents: Record<string, unknown>[];
let resendCalls: string[];

function cust(i: number, sentHoursAgo: number): Cust {
  return {
    id: `cus_m8_${i}`, email: `client-${i}@example.com`, name: "Casey Client",
    metadata: {
      gh_state: "report_sent",
      gh_booking_id: `bid-m8-${i}`,
      gh_payment_method: "pm_test_1",
      gh_first_price_cents: "18900",
      gh_report_amount_cents: "18900",
      gh_report_sent_at: hoursAgo(sentHoursAgo),
    },
  };
}

function visitRow(i: number, sentHoursAgo: number): Record<string, unknown> {
  return {
    id: `row-m8-${i}`, booking_id: `bid-m8-${i}`, visit_no: 1, status: "report_sent",
    report_status: "sent", amount_cents: 18900, client_email: `client-${i}@example.com`,
    report_sent_at: hoursAgo(sentHoursAgo), issue_open: false, issue_ever: false,
    report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    visit_date: "2027-01-15", window: "midday", cleaner_name: null,
  };
}

function response() {
  const res = {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  return res;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", ["adm", "secret"].join("-"));
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = [];
  dbRows = [];
  dbEvents = [];
  resendCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; method?: string }) => {
    const u = new URL(String(url));
    const sbRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        // The main DB pass (report_status=eq.sent) finds nothing here —
        // candidates come from the Stripe search below.
        if (u.searchParams.get("report_status")) return sbRes([]);
        if (u.searchParams.get("status")) return sbRes([]);
        const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : [];
        let out = [...list];
        const bid = u.searchParams.get("booking_id");
        if (bid) {
          const dot = bid.indexOf(".");
          out = out.filter((r) => String(r["booking_id"] ?? "") === decodeURIComponent(bid.slice(dot + 1)));
        }
        const limit = u.searchParams.get("limit");
        if (limit) out = out.slice(0, parseInt(limit, 10));
        return sbRes(out);
      }
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, created_at: new Date().toISOString() };
        if (table === "gh_events") dbEvents.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = [...dbRows];
        for (const t of matched) Object.assign(t, body);
        return sbRes(matched);
      }
      return sbRes([]);
    }
    if (u.hostname === "api.resend.com") {
      resendCalls.push(String(init?.body ?? ""));
      return { ok: true, status: 200, json: async () => ({ id: "email-uuid-1" }) };
    }
    if (u.pathname.endsWith("/customers/search")) {
      const query = u.searchParams.get("query") ?? "";
      if (query.includes("email:'")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      const stateM = /gh_state'\]:'([^']+)'/.exec(query) ?? /gh_state'\s*:\s*'([^']+)'/.exec(query);
      const found = stateM ? store.filter((c) => c.metadata["gh_state"] === stateM[1]) : store;
      return { ok: true, status: 200, json: async () => ({ data: found.map((c) => ({ id: c.id, email: c.email, name: c.name, metadata: c.metadata })) }) };
    }
    const custMatch = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
    if (custMatch) {
      const found = store.find((c) => c.id === custMatch[1]);
      if (!found) return { ok: false, status: 404, json: async () => ({}) };
      if (init?.body) {
        const params = new URLSearchParams(String(init.body));
        for (const [k, v] of params.entries()) {
          const mm = /^metadata\[(.+)\]$/.exec(k);
          if (mm) found.metadata[mm[1]] = v;
        }
        return { ok: true, status: 200, json: async () => ({ id: found.id }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...found }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const cronReq = () => ({ method: "GET", headers: { authorization: `Bearer ${CRON}` } });

const run = async () => {
  const res = response();
  await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(cronReq(), res);
  return res;
};

describe("M8 reminder passes are capped at 25 per run", () => {
  it("30 early-eligible reports: at most 25 early reminders, no unbounded burst", async () => {
    store = Array.from({ length: 30 }, (_, i) => cust(i, 5));
    dbRows = Array.from({ length: 30 }, (_, i) => visitRow(i, 5));
    const r = await run();
    expect(r.code).toBe(200);
    expect(r.body["early_reminded"]).toBe(25);
    expect(r.body["reminded"]).toBe(0);
    expect(resendCalls).toHaveLength(25);
    expect(r.body["charged"]).toBe(0);
  });

  it("30 20h-eligible reports: at most 25 reminders", async () => {
    store = Array.from({ length: 30 }, (_, i) => cust(i, 21));
    dbRows = Array.from({ length: 30 }, (_, i) => visitRow(i, 21));
    const r = await run();
    expect(r.code).toBe(200);
    expect(r.body["early_reminded"]).toBe(0);
    expect(r.body["reminded"]).toBe(25);
    expect(resendCalls).toHaveLength(25);
    expect(r.body["charged"]).toBe(0);
  });

  it("15 early + 15 20h-eligible: the cap is shared, 25 reminders total", async () => {
    store = [
      ...Array.from({ length: 15 }, (_, i) => cust(i, 5)),
      ...Array.from({ length: 15 }, (_, i) => cust(100 + i, 21)),
    ];
    dbRows = [
      ...Array.from({ length: 15 }, (_, i) => visitRow(i, 5)),
      ...Array.from({ length: 15 }, (_, i) => visitRow(100 + i, 21)),
    ];
    const r = await run();
    expect(r.code).toBe(200);
    expect(r.body["early_reminded"]).toBe(15);
    expect(r.body["reminded"]).toBe(10);
    expect(resendCalls).toHaveLength(25);
    expect(r.body["charged"]).toBe(0);
  });
});
