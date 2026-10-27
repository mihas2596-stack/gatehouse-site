// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import autoChargeHandler from "../../api/auto-charge";
import bookingAction from "../../api/booking-action";
import { signBooking } from "../../api/create-checkout-session";

// Race coverage for the GPT-17 fixes: a client Approve racing the
// 24h auto-charge cron on the same due visit must produce exactly one
// PaymentIntent. Both paths mint the same idempotency key
// (charge_<bid>_v<version>) and both re-check the row's paid status,
// so the loser either adopts the winner's intent or skips — it must
// never mint a second charge. Shared mocked world, same shape as the
// cabinet-scenarios harness.

const BID = "bid-race-1";
const EMAIL = "client@example.com";
const ROW_ID = "33333333-3333-4333-8333-333333333333";
const AUTH = "Bearer " + "adm-" + "secret";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;
type Cust = { id: string; email: string; name: string; pm: string; metadata: Record<string, string> };

let rows: Row[];
let evts: Evt[];
let customers: Cust[];
let piCalls: Array<{ booking: string; version: string; amount: string; id: string; ok: boolean; idemKey?: string; pm?: string }>;
let evSeq: number;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === v.slice(3));
    if (v.startsWith("in.(") && v.endsWith(")")) {
      const set = new Set(v.slice(4, -1).split(","));
      out = out.filter((r) => set.has(String(r[k] ?? "")));
    }
    if (v.startsWith("lt.")) out = out.filter((r) => String(r[k] ?? "") < v.slice(3));
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
      const bidM = q.match(/gh_booking_id'\]:'([^']+)'/);
      const emailM = q.match(/email:'([^']+)'/);
      const stateM = q.match(/metadata\['gh_state'\]:'([^']+)'/);
      const found = customers.filter((c) =>
        (bidM ? c.metadata["gh_booking_id"] === bidM[1] : true) &&
        (emailM ? c.email === emailM[1] : true) &&
        (stateM ? c.metadata["gh_state"] === stateM[1] : true),
      );
      return res(200, { data: found.map((c) => ({ ...c, metadata: c.metadata })) });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      const cust = customers.find((c) => c.id === custM[1]);
      if (!cust) return res(404, { error: { message: "not found" } });
      if (custM[2]) return res(200, { data: [{ id: cust.pm, type: "card" }] });
      if (method === "GET") return res(200, { ...cust, metadata: cust.metadata });
      const params = parseForm(init?.body);
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) cust.metadata[mm[1]] = v;
      }
      return res(200, { ...cust, metadata: cust.metadata });
    }
    if (u.pathname === "/v1/payment_intents/search" && method === "GET") {
      const q = u.searchParams.get("query") ?? "";
      const bidM = q.match(/gh_booking_id'\]:'([^']+)'/);
      const data = piCalls
        .filter((p) => (bidM ? p.booking === bidM[1] : true))
        .map((p) => ({
          id: p.id,
          status: p.ok ? "succeeded" : "requires_payment_method",
          amount: Number(p.amount),
          created: 1,
          metadata: { gh_booking_id: p.booking, gh_report_version: p.version },
        }));
      return res(200, { data });
    }
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      const params = parseForm(init?.body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const idemKey = headers["Idempotency-Key"] ?? headers["idempotency-key"];
      const booking = params.get("metadata[gh_booking_id]") ?? "";
      const version = params.get("metadata[gh_report_version]") ?? "1";
      const amount = params.get("amount") ?? "";
      const pm = params.get("payment_method") ?? "";
      if (idemKey) {
        const prev = piCalls.find((p) => p.idemKey === idemKey);
        if (prev) {
          if (prev.amount === amount && prev.pm === pm) {
            return res(200, { id: prev.id, status: prev.ok ? "succeeded" : "requires_payment_method" });
          }
          return res(400, { error: { message: "Keys for idempotent requests can only be used with the same parameters" } });
        }
      }
      const id = `pi_ok_${piCalls.length + 1}`;
      piCalls.push({ booking, version, amount, id, ok: true, idemKey, pm });
      return res(200, { id, status: "succeeded" });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") {
    return res(200, { id: "email_1" });
  }

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
        evts.push({ ...body, created_at: new Date(Date.now() + evSeq).toISOString() });
        return res(201, {});
      }
      if (table === "gh_visits") {
        rows.push(body);
        return res(201, body);
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

async function call(handler: (req: unknown, res: unknown) => Promise<void> | void, req: Record<string, unknown>) {
  const r = response();
  await handler(req, r as never);
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
  rows = []; evts = []; customers = [];
  piCalls = []; evSeq = 0;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("approve vs timer race", () => {
  it("client Approve racing the 24h cron charges exactly once", async () => {
    // A due visit: report sent 30h ago, reminder already sent (so the
    // reminder-before-charge rule does not skip this run), card on file.
    const sentAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    const remindedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    rows = [{
      id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
      status: "report_sent", report_status: "sent", amount_cents: 20000,
      visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, checklist: { rooms: [] },
    }];
    customers = [{
      id: "cus_race_1", email: EMAIL, name: "Casey Client", pm: "pm_race_1",
      metadata: {
        gh_booking_id: BID, gh_state: "report_sent", gh_payment_method: "pm_race_1",
        gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
        gh_report_version: "1", gh_report_amount_cents: "20000",
        gh_reminded_at: remindedAt,
      },
    }];
    evts = [
      { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
      { visit_id: ROW_ID, booking_id: BID, event: "reminder_sent", detail: {}, created_at: remindedAt },
    ];
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const [approve, cron] = await Promise.all([
      call(reportHandler, { method: "POST", headers: {}, body: { bt, action: "approve", seen_publication_id: sentAt } }),
      call(autoChargeHandler, { method: "GET", headers: { authorization: AUTH } }),
    ]);
    // Exactly one charge exists, however the two paths interleaved:
    // the loser adopts the winner's intent or skips on the paid row.
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(piCalls.filter((p) => p.ok)[0].amount).toBe("20000");
    expect(rows[0]["status"]).toBe("paid");
    expect(cron.body["ok"]).toBe(true);
    expect(approve.code === 200 || approve.code === 409).toBe(true);
  });

  it("owner charge racing the 24h cron charges exactly once", async () => {
    // Same due visit, same claim, same idempotency key — the caller
    // (owner panel vs cron) must not change the outcome.
    const sentAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    const remindedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    rows = [{
      id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
      status: "report_sent", report_status: "sent", amount_cents: 20000,
      visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, checklist: { rooms: [] },
    }];
    customers = [{
      id: "cus_race_1", email: EMAIL, name: "Casey Client", pm: "pm_race_1",
      metadata: {
        gh_booking_id: BID, gh_state: "report_sent", gh_payment_method: "pm_race_1",
        gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
        gh_report_version: "1", gh_report_amount_cents: "20000",
        gh_reminded_at: remindedAt,
      },
    }];
    evts = [
      { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
      { visit_id: ROW_ID, booking_id: BID, event: "reminder_sent", detail: {}, created_at: remindedAt },
    ];
    const [charge, cron] = await Promise.all([
      call(bookingAction, {
        method: "POST",
        headers: { authorization: AUTH, origin: "https://www.gatehousehomecleaning.com" },
        body: { action: "charge", booking_id: BID, amount_cents: 20000 },
      }),
      call(autoChargeHandler, { method: "GET", headers: { authorization: AUTH } }),
    ]);
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(piCalls.filter((p) => p.ok)[0].amount).toBe("20000");
    expect(rows[0]["status"]).toBe("paid");
    expect(cron.body["ok"]).toBe(true);
    expect(charge.code === 200 || charge.code === 409).toBe(true);
  });
});
