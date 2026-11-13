// @vitest-environment node
// M11 (maximal test 12.11.2026): concurrent cancels gave a confusing
// 503. When the conditional cancel update loses a race to another
// cancel, owner_cancel must re-read the row and return the current
// state — an already-cancelled visit is an idempotent cancel (200
// with the cancelled state), not an error — and the loser must not
// re-journal, re-sync Stripe or re-email. Only a row that is still
// cancellable on re-read (a real DB failure) keeps the 503.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";

const BID = "bid-m11";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const VISIT = "2027-01-15";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let resendBodies: string[];
let stripeCustomerPosts: string[];
let patchCalls: number;
// "normal" | "race-journaled" (winner flipped the row AND journaled)
// | "race-unjournaled" (winner flipped the row, journal not yet written)
// | "db-fail" (the PATCH itself errors).
let mode: "normal" | "race-journaled" | "race-unjournaled" | "db-fail";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const created = (): Ev => ({ event: "visit_created", detail: {}, created_at: hoursAgo(50) });

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
  vi.stubEnv("ADMIN_TOKEN", "adm-" + "secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  row = {
    id: VISIT_ID, booking_id: BID, status: "confirmed", amount_cents: 20000,
    cleaner_name: null, client_email: "client@example.com",
    report_sent_at: null, report_bounced: false, report_status: "none",
    visit_date: VISIT, window: "morning", issue_open: false, issue_ever: false,
    fee_status: null, fee_intent_id: null, fee_amount_cents: null,
  };
  events = [created()];
  storeMeta = { gh_booking_id: BID, gh_state: "confirmed" };
  resendBodies = [];
  stripeCustomerPosts = [];
  patchCalls = 0;
  mode = "normal";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      resendBodies.push(String(init?.body ?? ""));
      return okRes({ id: "email-1" });
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return okRes({ data: [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
      }
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          stripeCustomerPosts.push(String(init.body));
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
        patchCalls += 1;
        if (mode === "db-fail") {
          return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        }
        if ((mode === "race-journaled" || mode === "race-unjournaled") && patchCalls === 1) {
          // The race winner committed between our read and our write:
          // our conditional update matches 0 rows, but the row is
          // now cancelled. The winner's journal event may or may not
          // have landed yet.
          row = { ...row, status: "cancelled" };
          if (mode === "race-journaled") {
            events.push({ event: "visit_cancelled", detail: { scope: "once", fee_cents: 2500 }, created_at: new Date().toISOString() });
          }
          return okRes([]);
        }
        Object.assign(row, JSON.parse(String(init?.body ?? "{}")) as Row);
        return okRes([row]);
      }
      const qBid = u.searchParams.get("booking_id");
      if (qBid?.startsWith("eq.")) {
        return okRes(decodeURIComponent(qBid.slice(3)) === BID ? [row] : []);
      }
      return okRes([row]);
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { booking_id?: string; event?: string; detail?: Record<string, unknown> | null };
        events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString() });
        return okRes([{ id: events.length }]);
      }
      const out = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return okRes(out);
    }
    if (u.pathname.includes("/rest/v1/gh_visit_access")) {
      return okRes([]);
    }
    if (u.pathname.includes("/rest/v1/gh_photos")) {
      return okRes([]);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = async (body: Record<string, unknown>) => {
  const r = res();
  await handler(
    { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body: { booking_id: BID, ...body } },
    r as never,
  );
  return r;
};

// The visit is 2027-01-15, morning window; 2027-01-13T12:30:00Z is
// 47.5h before the 7 AM window start, so the fee is $25.
const withNow = async (iso: string, fn: () => Promise<ReturnType<typeof res>>) => {
  const spy = vi.spyOn(Date, "now").mockReturnValue(Date.parse(iso));
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
};

describe("M11: concurrent owner_cancel is an idempotent cancel, not a 503", () => {
  it("race lost to another cancel whose journal already landed: 200, same fee, no duplicate side effects", async () => {
    mode = "race-journaled";
    const r = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["already_cancelled"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(2500);
    // The loser journals nothing, syncs nothing to Stripe and emails nobody.
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(1);
    expect(stripeCustomerPosts).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
    expect(row["status"]).toBe("cancelled");
  });

  it("race lost before the winner journaled: 200 with the fee from this request's own snapshot", async () => {
    mode = "race-unjournaled";
    const r = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["already_cancelled"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(0);
    expect(stripeCustomerPosts).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
  });

  it("a real DB failure (row still cancellable on re-read) still returns 503", async () => {
    mode = "db-fail";
    const r = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(503);
    expect(r.body["error"]).toBe("cancellation_not_saved");
    expect(row["status"]).toBe("confirmed");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(0);
    expect(stripeCustomerPosts).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
  });

  it("a normal (uncontested) owner_cancel still succeeds exactly as before", async () => {
    mode = "normal";
    const r = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["already_cancelled"]).toBeUndefined();
    expect(r.body["fee_cents"]).toBe(2500);
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(1);
    expect(row["status"]).toBe("cancelled");
  });
});
