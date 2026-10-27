// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import autoChargeHandler from "../../api/auto-charge";

// RA11 (N08): shared Stripe customer metadata is NO LONGER proof of
// payment. Sync-recovery mirrors a row to paid ONLY when the named
// intent is verified at Stripe (this booking, this customer, pinned
// amount, USD, cleaning kind, succeeded) — never from meta alone,
// and it never creates a new charge.

const BID = "bid-ra11-1";
const ROW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTH = "Bearer " + "adm-" + "secret";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;
type Cust = { id: string; metadata: Record<string, string> };

let rows: Row[];
let evts: Evt[];
let customers: Cust[];
let piCalls: string[];
let evSeq: number;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
    if (v.startsWith("lt.")) out = out.filter((r) => String(r[k] ?? "") < decodeURIComponent(v.slice(3)));
  }
  if (u.searchParams.get("order")?.startsWith("created_at.desc")) {
    out.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

function parseForm(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body && typeof body === "object") return new URLSearchParams(body as Record<string, string>);
  return new URLSearchParams();
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") {
    if (u.pathname.includes("/customers/search")) {
      const q = u.searchParams.get("query") ?? "";
      const stateM = q.match(/metadata\['gh_state'\]:'([^']+)'/);
      const found = customers.filter((c) => (stateM ? c.metadata["gh_state"] === stateM[1] : true));
      return res(200, { data: found.map((c) => ({ ...c, metadata: c.metadata })) });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      const cust = customers.find((c) => c.id === custM[1]);
      if (!cust) return res(404, { error: { message: "not found" } });
      if (custM[2]) return res(200, { data: [] });
      if (method === "GET") return res(200, { ...cust, metadata: cust.metadata });
      const params = parseForm(init?.body);
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) cust.metadata[mm[1]] = v;
      }
      return res(200, { ...cust, metadata: cust.metadata });
    }
    const piM = u.pathname.match(/^\/v1\/payment_intents\/(pi_[^/]+)$/);
    if (piM && method === "GET") {
      const found = (globalThis as unknown as { __ra11Intents?: Record<string, unknown> }).__ra11Intents?.[piM[1]];
      if (found) return res(200, found);
      return res(404, { error: { message: "not found" } });
    }
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      piCalls.push("created");
      return res(200, { id: "pi_new_1", status: "succeeded" });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") return res(200, { id: "email_1" });

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") return res(200, applyFilters(rows, u));
      if (table === "gh_events") return res(200, applyFilters(evts, u));
      if (table === "gh_photos") return res(200, []);
      return res(200, []);
    }
    if (method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (table === "gh_events") {
        evSeq += 1;
        const inserted = { ...body, created_at: new Date(Date.now() + evSeq).toISOString() };
        evts.push(inserted);
        return res(201, [inserted]);
      }
      return res(201, {});
    }
    if (method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const matched = applyFilters(rows, u);
      for (const target of matched) Object.assign(target, body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const prefer = headers["Prefer"] ?? headers["prefer"] ?? "";
      return res(200, prefer.includes("return=representation") ? matched : {});
    }
  }
  return res(404, { error: { message: "route not stubbed" } });
}

function response() {
  const r = {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  return r;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = []; evts = []; customers = []; piCalls = []; evSeq = 0;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA11 cron sync recovery", () => {
  it("meta paid alone does NOT sync: no verified intent, row stays payment_pending, charges nothing", async () => {
    const sentAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    rows = [{
      id: ROW_ID, booking_id: BID, status: "payment_pending", report_status: "sent",
      amount_cents: 20000, visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, payment_intent_id: null,
    }];
    customers = [{
      id: "cus_ra11_1",
      metadata: {
        gh_booking_id: BID, gh_state: "paid", gh_payment_method: "pm_ra11_1",
        gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
        gh_report_version: "1", gh_report_amount_cents: "20000",
        gh_last_payment: "pi_sync_1", gh_paid_at: sentAt,
        gh_receipt_email_id: "email_receipt_1",
      },
    }];
    evts = [
      { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    ];
    const r = response();
    await autoChargeHandler({ method: "GET", headers: { authorization: AUTH } }, r as never);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["charged"]).toBe(0);
    expect(r.body["synced"]).toBe(0);
    expect(piCalls).toHaveLength(0);
    expect(rows[0]["status"]).toBe("payment_pending");
    expect(rows[0]["payment_intent_id"]).toBe(null);
    expect(evts.some((e) => e.event === "payment_succeeded")).toBe(false);
  });

  it("verified succeeded intent DOES sync: row mirrors to paid, charges nothing", async () => {
    const sentAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    rows = [{
      id: ROW_ID, booking_id: BID, status: "payment_pending", report_status: "sent",
      amount_cents: 20000, visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, payment_intent_id: null,
    }];
    customers = [{
      id: "cus_ra11_1",
      metadata: {
        gh_booking_id: BID, gh_state: "paid", gh_payment_method: "pm_ra11_1",
        gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
        gh_report_version: "1", gh_report_amount_cents: "20000",
        gh_last_payment: "pi_sync_1", gh_paid_at: sentAt,
        gh_receipt_email_id: "email_receipt_1",
      },
    }];
    evts = [
      { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    ];
    (globalThis as unknown as { __ra11Intents?: Record<string, unknown> }).__ra11Intents = {
      pi_sync_1: { id: "pi_sync_1", status: "succeeded", amount: 20000, currency: "usd", customer: "cus_ra11_1", metadata: { gh_booking_id: BID } },
    };
    const r = response();
    await autoChargeHandler({ method: "GET", headers: { authorization: AUTH } }, r as never);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["charged"]).toBe(0);
    expect(r.body["synced"]).toBe(1);
    expect(piCalls).toHaveLength(0);
    expect(rows[0]["status"]).toBe("paid");
    expect(rows[0]["payment_intent_id"]).toBe("pi_sync_1");
    expect(evts.some((e) => e.event === "payment_succeeded"
      && (e.detail as Record<string, unknown>)?.["via"] === "timer_sync_recovery")).toBe(true);
    delete (globalThis as unknown as { __ra11Intents?: Record<string, unknown> }).__ra11Intents;
  });

  it("an already-paid row is left alone by the sync pass", async () => {
    const sentAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    rows = [{
      id: ROW_ID, booking_id: BID, status: "paid", report_status: "sent",
      amount_cents: 20000, visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, payment_intent_id: "pi_sync_1",
    }];
    customers = [{
      id: "cus_ra11_1",
      metadata: {
        gh_booking_id: BID, gh_state: "paid", gh_payment_method: "pm_ra11_1",
        gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
        gh_report_version: "1", gh_report_amount_cents: "20000",
        gh_last_payment: "pi_sync_1", gh_paid_at: sentAt,
        gh_receipt_email_id: "email_receipt_1",
      },
    }];
    evts = [];
    const r = response();
    await autoChargeHandler({ method: "GET", headers: { authorization: AUTH } }, r as never);
    expect(r.code).toBe(200);
    expect(r.body["synced"]).toBe(0);
    expect(piCalls).toHaveLength(0);
  });
});
