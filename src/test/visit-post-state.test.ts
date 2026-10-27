// @vitest-environment node
// POST actions on /api/visit must derive state from the booking's own
// row + journal, not from the shared Stripe customer metadata: one
// booking's stale "cancelled" used to block another booking's cancel
// (409 already_cancelled). A decline (date_proposed carrying alt_dates)
// must survive the row override, or the client could never accept an
// offered date.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-post-state";
const VISIT_ID = "33333333-4444-5555-6666-777777777777";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let rows: Row[];
let events: Ev[];
let storeMeta: Record<string, string>;
let resendCalls: number;

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

function makeRow(overrides: Row = {}): Row {
  return {
    id: VISIT_ID,
    booking_id: BID,
    visit_no: 1,
    status: "requested",
    report_status: "none",
    report_sent_at: null,
    report_bounced: false,
    visit_date: "2027-01-15",
    window: "midday",
    service: "Standard cleaning",
    client_name: "Casey Client",
    client_email: "client@example.com",
    amount_cents: 14900,
    cleaner_name: null,
    cleaner_profile: null,
    access_notes: null,
    no_photo_zones: null,
    ...overrides,
  };
}

const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
  ({ event, detail, created_at });
const created = ev("visit_created", {}, "2026-10-20T10:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [makeRow()];
  events = [created];
  storeMeta = { gh_booking_id: BID, gh_state: "card_ready", gh_first_price_cents: "14900" };
  resendCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") { resendCalls++; return okRes({ id: "email-1" }); }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        const query = u.searchParams.get("query") ?? "";
        const bidM = /gh_booking_id'\]:'([^']+)'/.exec(query);
        const found = bidM
          ? (storeMeta["gh_booking_id"] === bidM[1] ? [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] : [])
          : [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }];
        return okRes({ data: found });
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
          return okRes({ id: "cus_v" });
        }
        return okRes({ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_v" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const matched: Row[] = [];
        for (const r of rows) {
          const qBid = u.searchParams.get("booking_id");
          const qId = u.searchParams.get("id");
          if ((qBid && qBid === `eq.${r["booking_id"]}`) || (qId && qId === `eq.${r["id"]}`)) { Object.assign(r, patch); matched.push(r); }
        }
        return okRes(matched);
      }
      const qBid = u.searchParams.get("booking_id");
      let out = [...rows];
      if (qBid && qBid.startsWith("eq.")) out = out.filter((r) => r["booking_id"] === decodeURIComponent(qBid.slice(3)));
      return okRes(out.slice(0, 1));
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { booking_id?: string; event?: string; detail?: Record<string, unknown> | null };
        events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString() });
        return okRes([{ id: events.length }]);
      }
      const qBid = u.searchParams.get("booking_id");
      let out = [...events];
      if (qBid && qBid.startsWith("eq.")) out = out.filter((e) => true);
      out = [...out].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return okRes(out);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const bt = () => signBooking("link-secret", { bid: BID, email: "client@example.com", name: "Casey Client", date: "2027-01-15" }).token;
const call = async (method: "GET" | "POST", body?: Record<string, unknown>) => {
  const r = res();
  await visitHandler(
    method === "GET"
      ? { method, headers: {}, query: { bt: bt() } }
      : { method, headers: {}, body: { bt: bt(), ...body } },
    r as never,
  );
  return r;
};

describe("POST state comes from the row, not shared customer metadata", () => {
  it("bound booking with stale shared 'cancelled' still cancels (was 409)", async () => {
    storeMeta = { gh_booking_id: BID, gh_state: "cancelled", gh_first_price_cents: "14900" };
    const r = await call("POST", { action: "cancel", scope: "once" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(0);
    expect(rows[0]["status"]).toBe("cancelled");
  });

  it("unbound booking with stale shared 'cancelled' still cancels (was 409)", async () => {
    storeMeta = { gh_booking_id: "bid-other", gh_state: "cancelled", gh_first_price_cents: "14900" };
    const r = await call("POST", { action: "cancel", scope: "once" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
  });

  it("a genuinely cancelled row still answers 409 (no double cancel)", async () => {
    rows = [makeRow({ status: "cancelled" })];
    events = [created, ev("visit_cancelled", { scope: "once", fee_cents: 0 }, "2026-10-21T10:00:00.000Z")];
    const r = await call("POST", { action: "cancel", scope: "once" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("already_cancelled");
  });

  it("a row marked cancelled without an event still answers 409", async () => {
    rows = [makeRow({ status: "cancelled" })];
    const r = await call("POST", { action: "cancel", scope: "once" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("already_cancelled");
  });
});

describe("G1: hydrate must not clobber the real payment-method ID", () => {
  it("unbound POST keeps the real pm id (was overwritten with \"1\")", async () => {
    storeMeta = { gh_booking_id: "bid-other", gh_state: "requested", gh_first_price_cents: "14900", gh_payment_method: "pm_real" };
    const r = await call("POST", { action: "cancel", scope: "once" });
    expect(r.code).toBe(200);
    expect(storeMeta["gh_payment_method"]).toBe("pm_real");
  });
});

describe("decline survives the row override", () => {
  it("GET shows date_declined with the offered dates", async () => {
    events = [created, ev("date_proposed", { alt_dates: "2027-01-20,2027-01-21" }, "2026-10-22T10:00:00.000Z")];
    const r = await call("GET");
    expect(r.body["state"]).toBe("date_declined");
    expect(r.body["alt_dates"]).toEqual(["2027-01-20", "2027-01-21"]);
  });

  it("a later confirmation wins over an older decline", async () => {
    events = [
      created,
      ev("date_proposed", { alt_dates: "2027-01-20,2027-01-21" }, "2026-10-22T10:00:00.000Z"),
      ev("visit_confirmed", { date: "2027-01-20", window: "midday" }, "2026-10-23T10:00:00.000Z"),
    ];
    const r = await call("GET");
    expect(r.body["state"]).toBe("confirmed");
  });
});

describe("V1: card_failed and accept-after-reload", () => {
  it("a webhook card_failed survives the row override when nothing stronger applies", async () => {
    // No payment method on file, no report, no confirmation: the only
    // card_failed signal is the webhook's shared-metadata flag, which
    // the row override used to swallow (client saw "card needed").
    storeMeta = { gh_booking_id: BID, gh_state: "card_failed", gh_first_price_cents: "14900" };
    const r = await call("GET");
    expect(r.body["state"]).toBe("card_failed");
  });

  it("accepting an offered date persists after reload and clears stale offers", async () => {
    events = [created, ev("date_proposed", { alt_dates: "2027-01-20,2027-01-21" }, "2026-10-22T10:00:00.000Z")];
    const post = await call("POST", { action: "accept_alt_date", date: "2027-01-20" });
    expect(post.code).toBe(200);
    const r = await call("GET");
    expect(r.body["state"]).toBe("confirmed");
    const booking = r.body["booking"] as Record<string, unknown>;
    expect(booking["confirmed_date"]).toBe("2027-01-20");
    expect(r.body["alt_dates"]).toEqual([]);
  });
});

describe("V2: a client proposal is pending, not a new agreement", () => {
  it("propose keeps the old confirmed date and surfaces the pending date after reload", async () => {
    events = [
      created,
      ev("visit_confirmed", { date: "2027-01-20", window: "midday" }, "2026-10-23T10:00:00.000Z"),
    ];
    const post = await call("POST", { action: "propose_date", date: "2027-02-01" });
    expect(post.code).toBe(200);
    const r = await call("GET");
    const booking = r.body["booking"] as Record<string, unknown>;
    expect(booking["confirmed_date"]).toBe("2027-01-20");
    expect(r.body["proposed_date"]).toBe("2027-02-01");
    expect(r.body["proposed_pending"]).toBe(true);
  });
});

describe("V8: confirm_by is pinned to the request time", () => {
  it("GET quotes the deadline from visit_created, not from today", async () => {
    // Request 2026-10-20 (Tuesday) → next business day 6 PM ET is
    // Wednesday, October 21 — whatever day this test runs on.
    const r = await call("GET");
    expect(r.body["confirm_by"]).toBe("Wednesday, October 21 at 6:00 PM ET");
  });
});
