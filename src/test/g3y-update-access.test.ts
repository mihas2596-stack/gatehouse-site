// @vitest-environment node
// M12 (maximal test 12.11.2026): update_access wrote the no-photo
// zones into Stripe metadata BEFORE the entry_not_available check, and
// the visit-row write was unchecked (a failed row update still
// returned 200). Now: validate first (entry check), then Stripe
// (checked), then the row (checked, 502 when it does not apply).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-g3y-access";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const LINK_SECRET = "link-secret";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string; booking_id?: string };

let row: Row;
let events: Ev[];
let accessRows: Row[];
let storeMeta: Record<string, string>;
let stripePosts: string[];
// When true, PATCH gh_visits matches nothing (simulates a failed row write).
let patchVisitsFail: boolean;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const future = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

function matchCond(r: Row, field: string, op: string, val: string): boolean {
  const v = r[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  return false;
}
function applyDbFilters(list: Row[], u: URL): Row[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

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

function setupRow(reportSent: boolean) {
  const visitDate = future(10);
  row = {
    id: VISIT_ID, booking_id: BID, status: "confirmed", amount_cents: 18900,
    cleaner_name: "Ana", client_email: "client@example.com",
    report_sent_at: reportSent ? new Date().toISOString() : null,
    report_bounced: false, report_status: reportSent ? "sent" : "none",
    visit_date: visitDate, window: "morning", issue_open: false, issue_ever: false,
    no_photo_zones: null,
  };
  events = [
    { event: "visit_created", detail: {}, created_at: hoursAgo(50), booking_id: BID },
    { event: "visit_confirmed", detail: { date: visitDate, window: "morning" }, created_at: hoursAgo(49), booking_id: BID },
  ];
  storeMeta = {
    gh_booking_id: BID, gh_state: "confirmed",
    gh_confirmed_date: visitDate, gh_confirmed_window: "morning",
    gh_payment_method: "pm_test_1", gh_first_price_cents: "18900",
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", LINK_SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  accessRows = [];
  stripePosts = [];
  patchVisitsFail = false;
  setupRow(false);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const sbRes = (data: unknown) => ({
      ok: true, status: 200,
      json: async () => data, text: async () => JSON.stringify(data),
    });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const list = table === "gh_visits" ? [row] : table === "gh_events" ? events : accessRows;
      if (method === "GET") return sbRes(applyDbFilters(list, u));
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, id: `row-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString() };
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        if (table === "gh_visits" && patchVisitsFail) return sbRes([]);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = applyDbFilters(list, u);
        for (const target of matched) Object.assign(target, body);
        return sbRes(matched);
      }
      if (method === "DELETE") {
        const matched = applyDbFilters(list, u);
        for (const d of matched) { const i = list.indexOf(d); if (i >= 0) list.splice(i, 1); }
        return sbRes(matched);
      }
      return sbRes([]);
    }
    if (u.hostname === "api.resend.com") return sbRes({ id: "email-1" });
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return sbRes({ data: [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
      }
      if (u.pathname.endsWith("/payment_methods")) return sbRes({ data: [] });
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          stripePosts.push(String(init.body));
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
        }
        return sbRes({ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const bt = () => signBooking(LINK_SECRET, {
  bid: BID, email: "client@example.com", name: "Casey Client",
}).token;
const post = (body: Record<string, unknown>) => ({
  method: "POST", headers: {}, body: { bt: bt(), ...body },
});

describe("M12: update_access validates before writing, checks the row write", () => {
  it("happy path: zones go to Stripe AND the row, notes go to gh_visit_access", async () => {
    const r = res();
    await visitHandler(post({ action: "update_access", notes: "Lockbox 1234", no_photo_zones: "Office" }) as never, r as never);
    expect(r.code).toBe(200);
    expect(storeMeta["gh_no_photo_zones"]).toBe("Office");
    expect(row["no_photo_zones"]).toBe("Office");
    expect(storeMeta["gh_access_notes"]).toBeUndefined();
    const note = accessRows.find((a) => a["entry_note"] === "Lockbox 1234");
    expect(note).toBeTruthy();
  });

  it("entry closed: notes+zones is rejected BEFORE any write — no leaked zones", async () => {
    setupRow(true); // report sent -> entry closed
    const r = res();
    await visitHandler(post({ action: "update_access", notes: "Lockbox 1234", no_photo_zones: "Office" }) as never, r as never);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("entry_not_available");
    expect(storeMeta["gh_no_photo_zones"]).toBeUndefined();
    expect(row["no_photo_zones"]).toBeNull();
    expect(accessRows).toHaveLength(0);
  });

  it("zones-only still saves when entry is closed (zones are not gated by entry)", async () => {
    setupRow(true);
    const r = res();
    await visitHandler(post({ action: "update_access", no_photo_zones: "Garage" }) as never, r as never);
    expect(r.code).toBe(200);
    expect(storeMeta["gh_no_photo_zones"]).toBe("Garage");
    expect(row["no_photo_zones"]).toBe("Garage");
  });

  it("a failed row write fails visibly with 502 and leaves the row unchanged", async () => {
    patchVisitsFail = true;
    const r = res();
    await visitHandler(post({ action: "update_access", notes: "Lockbox 1234", no_photo_zones: "Office" }) as never, r as never);
    expect(r.code).toBe(502);
    expect(r.body["error"]).toBe("db_error");
    expect(row["no_photo_zones"]).toBeNull();
  });
});
