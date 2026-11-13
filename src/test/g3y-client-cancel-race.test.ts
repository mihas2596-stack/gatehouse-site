// @vitest-environment node
// M11 twin (maximal test 12.11.2026): the CLIENT cancel had the same
// race as owner_cancel — a concurrent cancel lost the conditional
// update and returned a confusing 503 cancellation_not_saved. Like
// owner_cancel it must now re-read the row and return the current
// state: already-cancelled -> 200 (idempotent, no duplicate journal /
// Stripe sync / email), still-cancellable on re-read -> 503 (a genuine
// DB failure).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-g3y-cancel";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const LINK_SECRET = "link-secret";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string; booking_id?: string };

let row: Row;
let events: Ev[];
let accessRows: Row[];
let storeMeta: Record<string, string>;
let resendBodies: string[];
let stripePosts: string[];
// "normal" | "race-journaled" (winner flipped the row AND journaled
// the fee) | "race-unjournaled" (winner flipped the row, journal not
// yet written) | "db-fail" (the PATCH itself errors, row untouched).
let mode: "normal" | "race-journaled" | "race-unjournaled" | "db-fail";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const future = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

function matchCond(r: Row, field: string, op: string, val: string): boolean {
  const v = r[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
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
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => {
      const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
      return dir === "desc" ? -cmp : cmp;
    });
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

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", LINK_SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const visitDate = future(1); // inside 48h of the morning window -> $25 fee
  row = {
    id: VISIT_ID, booking_id: BID, status: "confirmed", amount_cents: 18900,
    cleaner_name: "Ana", client_email: "client@example.com",
    report_sent_at: null, report_bounced: false, report_status: "none",
    visit_date: visitDate, window: "morning", issue_open: false, issue_ever: false,
    no_photo_zones: null,
  };
  events = [
    { event: "visit_created", detail: {}, created_at: hoursAgo(50), booking_id: BID },
    { event: "visit_confirmed", detail: { date: visitDate, window: "morning" }, created_at: hoursAgo(49), booking_id: BID },
  ];
  accessRows = [];
  storeMeta = {
    gh_booking_id: BID, gh_state: "confirmed",
    gh_confirmed_date: visitDate, gh_confirmed_window: "morning",
    gh_payment_method: "pm_test_1", gh_first_price_cents: "18900",
  };
  resendBodies = [];
  stripePosts = [];
  mode = "normal";
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
        const inserted = { ...body, id: `ev-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString() };
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        // The client-cancel CAS: status=eq.confirmed -> cancelled.
        if (table === "gh_visits" && u.search.includes("status=eq.confirmed") && mode !== "normal") {
          if (mode === "race-journaled") {
            row.status = "cancelled";
            events.push({ event: "visit_cancelled", detail: { scope: "once", fee_cents: 2500 }, created_at: new Date().toISOString(), booking_id: BID });
          } else if (mode === "race-unjournaled") {
            row.status = "cancelled";
          }
          // db-fail: the row is untouched, the PATCH matched nothing.
          return sbRes([]);
        }
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
    if (u.hostname === "api.resend.com") {
      resendBodies.push(String(init?.body ?? ""));
      return sbRes({ id: "email-1" });
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return sbRes({ data: [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
      }
      if (u.pathname.endsWith("/payment_methods")) {
        return sbRes({ data: [] });
      }
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
const cancelReq = () => ({ method: "POST", headers: {}, body: { bt: bt(), action: "cancel", scope: "once" } });

describe("M11 twin: concurrent client cancels", () => {
  it("normal cancel still works: 200, fee $25, journal + Stripe sync + emails", async () => {
    const r = res();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(row.status).toBe("cancelled");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(1);
    expect(stripePosts.some((b) => b.includes("gh_state") && b.includes("cancelled"))).toBe(true);
    expect(resendBodies.length).toBeGreaterThan(0);
  });

  it("losing a race to a journaled cancel returns 200 already_cancelled with the winner's fee and no side effects", async () => {
    mode = "race-journaled";
    const r = res();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["already_cancelled"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(r.body["state"]).toBe("cancelled");
    // The loser must not re-journal, re-sync Stripe or re-email.
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(1);
    expect(stripePosts).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
  });

  it("losing a race to an unjournaled cancel still returns 200 with the computed fee", async () => {
    mode = "race-unjournaled";
    const r = res();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["already_cancelled"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(0);
    expect(stripePosts).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
  });

  it("a genuine DB failure (row still cancellable on re-read) keeps the 503", async () => {
    mode = "db-fail";
    const r = res();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(503);
    expect(r.body["error"]).toBe("cancellation_not_saved");
    expect(row.status).toBe("confirmed");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(0);
    expect(stripePosts).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
  });
});
