// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import autoChargeHandler from "../../api/auto-charge";

// Early-reminder pass (4h after the report is sent):
//  - fires once inside the 4h..20h window, with its OWN flag + journal event;
//  - never satisfies the 20h reminder pass or the charge guard;
//  - a report discovered after 20h gets the 20h reminder only;
//  - issue open/ever, bounce, paid state, or "too early" all suppress it.

const CRON = ["cron", "secret"].join("-");

type Cust = { id: string; email: string; name: string; metadata: Record<string, string> };
let store: Cust[];
let dbRows: Record<string, unknown>[];
let dbEvents: Record<string, unknown>[];
let resendCalls: string[];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function cust(over: Record<string, string> = {}): Cust {
  return {
    id: "cus_early", email: "client@example.com", name: "Casey Client",
    metadata: {
      gh_state: "report_sent",
      gh_booking_id: "bid-early",
      gh_payment_method: "pm_test_1",
      gh_first_price_cents: "18900",
      gh_report_amount_cents: "18900",
      gh_report_version: "1",
      gh_report_sent_at: hoursAgo(5),
      ...over,
    },
  };
}

function visitRow(sentAt: string): Record<string, unknown> {
  return {
    id: "row-early", booking_id: "bid-early", visit_no: 1, status: "report_sent",
    report_status: "sent", amount_cents: 18900, client_email: "client@example.com",
    report_sent_at: sentAt, issue_open: false, issue_ever: false,
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
  store = [cust()];
  dbRows = [visitRow(hoursAgo(5))];
  dbEvents = [];
  resendCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; method?: string }) => {
    const u = new URL(String(url));
    const sbRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : [];
      if (method === "GET") {
        let out = [...list];
        const bid = u.searchParams.get("booking_id");
        if (bid) { const dot = bid.indexOf("."); out = out.filter((r) => String(r["booking_id"] ?? "") === decodeURIComponent(bid.slice(dot + 1))); }
        const ev = u.searchParams.get("event");
        if (ev) { const dot = ev.indexOf("."); out = out.filter((r) => String(r["event"] ?? "") === decodeURIComponent(ev.slice(dot + 1))); }
        const st = u.searchParams.get("report_status");
        if (st) { const dot = st.indexOf("."); out = out.filter((r) => String(r["report_status"] ?? "") === decodeURIComponent(st.slice(dot + 1))); }
        const order = u.searchParams.get("order");
        if (order) { const [field, dir] = order.split("."); out.sort((a, b) => { const c = String(a[field] ?? "").localeCompare(String(b[field] ?? "")); return dir === "desc" ? -c : c; }); }
        const limit = u.searchParams.get("limit");
        if (limit) out = out.slice(0, parseInt(limit, 10));
        return sbRes(out);
      }
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, created_at: new Date().toISOString() };
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = [...list];
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
const subjects = () => resendCalls.map((b) => (JSON.parse(b) as { subject: string }).subject);

describe("early reminder (4h after report)", () => {
  it("sends exactly one early reminder at 5h, journals it, charges nothing", async () => {
    const res = response();
    await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(cronReq(), res);
    expect(res.code).toBe(200);
    expect(res.body["early_reminded"]).toBe(1);
    expect(res.body["reminded"]).toBe(0);
    expect(res.body["charged"]).toBe(0);
    expect(subjects()).toEqual(["Your cleaning report is ready — a quick look"]);
    expect(store[0]!.metadata["gh_early_reminded_at"]).toBeTruthy();
    expect(store[0]!.metadata["gh_reminded_at"]).toBeUndefined();
    expect(dbEvents.some((e) => e["event"] === "early_reminder_sent")).toBe(true);
    expect(dbEvents.some((e) => e["event"] === "reminder_sent")).toBe(false);
  });

  it("does not fire before 4h", async () => {
    store = [cust({ gh_report_sent_at: hoursAgo(2) })];
    dbRows = [visitRow(hoursAgo(2))];
    const res = response();
    await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(cronReq(), res);
    expect(res.body["early_reminded"]).toBe(0);
    expect(resendCalls).toHaveLength(0);
  });

  it("does not fire with an open issue or a bounce", async () => {
    store = [cust({ gh_issue_open: "1" })];
    const res = response();
    await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(cronReq(), res);
    expect(res.body["early_reminded"]).toBe(0);
    store = [cust({ gh_report_bounced: "1" })];
    const res2 = response();
    await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(cronReq(), res2);
    expect(res2.body["early_reminded"]).toBe(0);
    expect(resendCalls).toHaveLength(0);
  });

  it("does not duplicate on a second run after the early flag is set", async () => {
    store = [cust({ gh_early_reminded_at: new Date().toISOString() })];
    const res = response();
    await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(cronReq(), res);
    expect(res.body["early_reminded"]).toBe(0);
    expect(resendCalls).toHaveLength(0);
  });

  it("a report discovered after 20h gets only the 20h reminder, no charge this run", async () => {
    store = [cust({ gh_report_sent_at: hoursAgo(25) })];
    dbRows = [visitRow(hoursAgo(25))];
    const res = response();
    await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(cronReq(), res);
    expect(res.body["early_reminded"]).toBe(0);
    expect(res.body["reminded"]).toBe(1);
    expect(res.body["charged"]).toBe(0);
    expect(subjects()).toEqual(["Reminder: your cleaning report is waiting"]);
  });
});
