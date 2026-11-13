// @vitest-environment node
// Task 1 (ChatGPT pre-ads report): the $25 late-cancellation fee must
// never be taken from another booking's card, and the 48h threshold
// must be the same in both cabinets (owner and client).
//
// (a) charge_fee charges THIS booking's card — its card_confirmed
// journal event — never the shared customer's gh_payment_method,
// which the most recent card save of ANY booking overwrites. With
// no confirmed card for the booking the fee is not charged at all:
// the owner gets a clear reason (no_card_for_booking) instead of a
// charge against a card that is not this booking's.
// (b) owner_cancel counts 48h to the START of the confirmed arrival
// window (morning 7 AM, midday 11 AM, afternoon 2 PM Atlanta time),
// exactly like the client cancel — never to midday. The row's
// visit_date is the effective (confirmed) date and its window is the
// confirmed window, so both cabinets read the same visit moment.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";
import { cancelFeeCents } from "../../api/visit";

const BID = "bid-task1";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
// Booking A's own card (its card_confirmed event) vs booking B's card
// (the shared customer's gh_payment_method after B saved a card).
const PM_A = "pm_booking_a";
const PM_B = "pm_booking_b";

// Winter (EST, UTC-5): 2027-01-15 7 AM ET = 12:00Z, 11 AM ET = 16:00Z,
// 2 PM ET = 19:00Z, midday = 17:00Z. Same fixed dates as C24.
const VISIT = "2027-01-15";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let piCalls: { amount: string; idem: string | undefined; paymentMethod: string; customer: string }[];
let resendBodies: string[];
let searchIntents: Array<{ id: string; status: string; amount: number }>;

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

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
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
  storeMeta = {
    gh_booking_id: BID, gh_state: "confirmed",
    gh_first_price_cents: "20000", gh_payment_method: PM_B,
  };
  piCalls = [];
  resendBodies = [];
  searchIntents = [];
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
      if (u.pathname.includes("/payment_intents/search")) {
        return okRes({
          data: searchIntents.map((p) => ({
            id: p.id, status: p.status, amount: p.amount, created: 1,
            currency: "usd", customer: "cus_v",
            metadata: { gh_booking_id: BID },
          })),
        });
      }
      if (u.pathname.endsWith("/payment_intents")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        piCalls.push({
          amount: params.get("amount") ?? "",
          idem: headers["Idempotency-Key"],
          paymentMethod: params.get("payment_method") ?? "",
          customer: params.get("customer") ?? "",
        });
        return okRes({ id: "pi_fee", status: "succeeded" });
      }
      if (u.pathname.includes("/payment_intents/") && u.pathname.endsWith("/confirm")) {
        return okRes({ id: "pi_fee", status: "succeeded" });
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
        Object.assign(row, JSON.parse(String(init?.body ?? "{}")) as Row);
        return okRes([row]);
      }
      const qBid = u.searchParams.get("booking_id");
      const qId = u.searchParams.get("id");
      if (qBid?.startsWith("eq.")) {
        return okRes(decodeURIComponent(qBid.slice(3)) === BID ? [row] : []);
      }
      if (qId?.startsWith("eq.")) {
        return okRes(decodeURIComponent(qId.slice(3)) === row["id"] ? [row] : []);
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
    { method: "POST", headers: { authorization: "Bearer adm-secret" }, body: { booking_id: BID, ...body } },
    r as never,
  );
  return r;
};

describe("Task 1 (a): charge_fee uses this booking's card, never another booking's", () => {
  const cancelledWithFee = () => {
    row = { ...row, status: "cancelled" };
    events = [
      created(),
      ev("card_confirmed", { payment_method_id: PM_A, brand: "visa", last4: "4242" }, hoursAgo(2)),
      ev("visit_cancelled", { fee_cents: 2500 }, hoursAgo(1)),
    ];
  };

  it("two bookings, one email, two cards: cancelling the first charges only its card", async () => {
    cancelledWithFee();
    // The shared customer currently carries booking B's card (B saved
    // a card after A did, overwriting gh_payment_method).
    storeMeta = { ...storeMeta, gh_state: "cancelled", gh_payment_method: PM_B };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].amount).toBe("2500");
    expect(piCalls[0].paymentMethod).toBe(PM_A);
    expect(piCalls[0].customer).toBe("cus_v");
    expect(piCalls[0].idem).toBe(`fee_${BID}`);
  });

  it("no card confirmed for this booking: no charge, a clear reason, nothing created", async () => {
    row = { ...row, status: "cancelled" };
    // No card_confirmed event at all — only the shared card of another
    // booking sits on the customer.
    events = [created(), ev("visit_cancelled", { fee_cents: 2500 }, hoursAgo(1))];
    storeMeta = { ...storeMeta, gh_state: "cancelled", gh_payment_method: PM_B };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("no_card_for_booking");
    expect(typeof r.body["detail"]).toBe("string");
    expect(piCalls).toHaveLength(0);
    // The fee stays due (not paid, not failed): the owner can retry
    // after the client confirms a card for this booking.
    expect(row["fee_status"]).toBeNull();
    expect(events.some((e) => e.event === "fee_no_card_for_booking")).toBe(true);
  });

  it("a second charge_fee after a paid fee reports already and creates no second intent", async () => {
    cancelledWithFee();
    storeMeta = { ...storeMeta, gh_state: "cancelled", gh_payment_method: PM_B };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(piCalls).toHaveLength(1);
    const again = await call({ action: "charge_fee" });
    expect(again.code).toBe(200);
    expect(again.body["already"]).toBe(true);
    expect(piCalls).toHaveLength(1);
    expect(row["fee_status"]).toBe("fee_paid");
  });
});

describe("Task 1 (b): owner_cancel counts 48h to the window start, like the client", () => {
  // The visit is 2027-01-15; Date.now is pinned per test so the
  // threshold is exact, not "about N days out".
  const withNow = async (iso: string, fn: () => Promise<ReturnType<typeof res>>) => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.parse(iso));
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  };

  it("morning, 47.5h before the 7 AM window start: $25 (midday rule said $0)", async () => {
    row = { ...row, visit_date: VISIT, window: "morning" };
    const r = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
  });

  it("afternoon, 49h before the 2 PM window start: $0 (midday rule said $25)", async () => {
    row = { ...row, visit_date: VISIT, window: "afternoon" };
    const r = await withNow("2027-01-13T18:00:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(0);
  });

  it("exactly 48h before the window start: $0", async () => {
    row = { ...row, visit_date: VISIT, window: "morning" };
    const r = await withNow("2027-01-13T12:00:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(0);
  });

  it("47h before the window start: $25", async () => {
    row = { ...row, visit_date: VISIT, window: "morning" };
    const r = await withNow("2027-01-13T13:00:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
  });

  it("49h before the window start: $0", async () => {
    row = { ...row, visit_date: VISIT, window: "morning" };
    const r = await withNow("2027-01-13T11:00:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(0);
  });

  it("owner and client agree for the same visit and moment", async () => {
    // The client cancel reads the confirmed window from metadata (or
    // the row's window) — the same inputs the owner cancel now uses.
    const now = Date.parse("2027-01-13T12:30:00Z");
    const clientMeta = { gh_state: "card_ready", gh_confirmed_date: VISIT, gh_confirmed_window: "morning" };
    expect(cancelFeeCents(clientMeta, VISIT, now)).toBe(2500);
    expect(cancelFeeCents(clientMeta, VISIT, now, "morning")).toBe(2500);
    row = { ...row, visit_date: VISIT, window: "morning" };
    const r = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(r.body["fee_cents"]).toBe(2500);
  });

  it("a repeated owner_cancel does not create a second fee", async () => {
    row = { ...row, visit_date: VISIT, window: "morning" };
    const r = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(1);
    const again = await withNow("2027-01-13T12:30:00Z", () => call({ action: "owner_cancel" }));
    expect(again.code).toBe(409);
    expect(again.body["error"]).toBe("already_cancelled");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(1);
  });
});
