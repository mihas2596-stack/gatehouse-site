// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";

// RA19: with a visit row, receipt_sent and postpay_issue come ONLY
// from that visit (row + journal). One shared customer record carries
// booking A's receipt id and postpay flag; booking B's report view
// must NOT inherit them, while booking A's view still shows its own.

const EMAIL = "client@example.com";
const BID_A = "bid-ra19-a";
const BID_B = "bid-ra19-b";
const ROW_A = "99999999-9999-4999-8999-999999999999";
const ROW_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;

let rows: Row[];
let evts: Evt[];
let custMeta: Record<string, string>;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
  }
  if (u.searchParams.get("order")?.startsWith("created_at.desc")) {
    out.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") {
    if (u.pathname.includes("/customers/search")) {
      const q = u.searchParams.get("query") ?? "";
      const bidM = q.match(/gh_booking_id'\]:'([^']+)'/);
      const emailM = q.match(/email:'([^']+)'/);
      // The shared record is bound to booking A; booking B finds it
      // only via the email fallback — exactly the contamination path.
      if (bidM && custMeta["gh_booking_id"] !== bidM[1]) return res(200, { data: [] });
      if (emailM && emailM[1] !== EMAIL) return res(200, { data: [] });
      return res(200, { data: [{ id: "cus_ra19_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } }] });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      if (custM[2]) return res(200, { data: [] });
      if (method === "GET") return res(200, { id: "cus_ra19_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } });
      return res(200, { id: "cus_ra19_1" });
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

async function getView(bid: string) {
  const bt = signBooking("link-secret", { bid, email: EMAIL, name: "Casey Client" }).token;
  const r = response();
  await reportHandler({ method: "GET", headers: {}, query: { bt } }, r as never);
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
  const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
  rows = [
    {
      id: ROW_A, booking_id: BID_A, client_email: EMAIL, status: "paid", report_status: "sent",
      amount_cents: 20000, visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, receipt_email_id: "email_receipt_a",
    },
    {
      id: ROW_B, booking_id: BID_B, client_email: EMAIL, status: "report_sent", report_status: "sent",
      amount_cents: 20000, visit_date: "2027-01-22", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, receipt_email_id: null,
    },
  ];
  evts = [
    { visit_id: ROW_A, booking_id: BID_A, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
    { visit_id: ROW_A, booking_id: BID_A, event: "payment_succeeded", detail: {}, created_at: sentAt },
    { visit_id: ROW_A, booking_id: BID_A, event: "postpay_issue", detail: {}, created_at: sentAt },
    { visit_id: ROW_B, booking_id: BID_B, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
  ];
  // Shared metadata contaminated by booking A: its receipt id and
  // postpay flag sit on the customer record both bookings share.
  custMeta = {
    gh_booking_id: BID_A, gh_state: "report_sent", gh_payment_method: "pm_ra19_1",
    gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
    gh_report_version: "1", gh_report_amount_cents: "20000",
    gh_receipt_email_id: "email_receipt_a", gh_postpay_issue: "1",
  };
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA19 per-booking receipt and postpay flags", () => {
  it("booking B does not inherit booking A's receipt or postpay flag", async () => {
    const view = await getView(BID_B);
    expect(view.code).toBe(200);
    expect(view.body["receipt_sent"]).toBe(false);
    expect(view.body["postpay_issue"]).toBe(false);
  });

  it("booking A still shows its own receipt and postpay flag", async () => {
    const view = await getView(BID_A);
    expect(view.code).toBe(200);
    expect(view.body["receipt_sent"]).toBe(true);
    expect(view.body["postpay_issue"]).toBe(true);
  });
});
