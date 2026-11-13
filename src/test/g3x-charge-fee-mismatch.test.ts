// @vitest-environment node
// G3X (top-5 round): charge_fee must verify the fee before charging.
//
// The bug: fee intents were verified with verifyIntentForObligation,
// the CLEANING obligation's verifier, which returns "wrong_kind" for ANY
// gh_kind=cancellation_fee intent — so every genuine fee intent was
// silently dropped and charge_fee created a fresh intent on top of it
// (a succeeded fee intent was ignored and charged twice; a processing
// one was doubled too). Fee intents are now verified as fees (kind must
// BE cancellation_fee; amount/currency/customer/booking must match),
// and the amount is checked against the journal basis and the amount a
// previous claim pinned on the row. Any mismatch is a 409 with the
// reason — never a charge of the wrong amount.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";

const BID = "bid-g3x-fee";
const VISIT_ID = "11111111-2222-3333-4444-555555555555";
const PM_A = "pm_booking_a";
const VISIT = "2027-01-15";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let piCalls: { amount: string; idem: string | undefined; paymentMethod: string; customer: string }[];
let resendBodies: string[];
let searchIntents: Array<{ id: string; status: string; amount: number; kind?: string; customer?: string }>;
let knownIntent: { id: string; status: string; amount: number; kind?: string; customer?: string } | null;

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

const cancelledWithFee = (feeCents = 2500) => {
  row = { ...row, status: "cancelled" };
  events = [
    created(),
    ev("card_confirmed", { payment_method_id: PM_A, brand: "visa", last4: "4242" }, hoursAgo(2)),
    ev("visit_cancelled", { fee_cents: feeCents }, hoursAgo(1)),
  ];
};

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
    gh_first_price_cents: "20000", gh_payment_method: "pm_other_booking",
  };
  piCalls = [];
  resendBodies = [];
  searchIntents = [];
  knownIntent = null;
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
            currency: "usd", customer: p.customer ?? "cus_v",
            metadata: { gh_booking_id: BID, ...(p.kind ? { gh_kind: p.kind } : {}) },
          })),
        });
      }
      const getM = /\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (getM && method === "GET") {
        if (!knownIntent) return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
        return okRes({
          id: knownIntent.id, status: knownIntent.status, amount: knownIntent.amount, created: 1,
          currency: "usd", customer: knownIntent.customer ?? "cus_v",
          metadata: { gh_booking_id: BID, ...(knownIntent.kind ? { gh_kind: knownIntent.kind } : {}) },
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
    if (u.pathname.includes("/rest/v1/gh_visit_access")) return okRes([]);
    if (u.pathname.includes("/rest/v1/gh_photos")) return okRes([]);
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

describe("G3X charge_fee verifies the fee before charging", () => {
  it("adopts a succeeded fee intent for the right amount — no second charge", async () => {
    cancelledWithFee();
    row = { ...row, fee_intent_id: "pi_fee_known" };
    knownIntent = { id: "pi_fee_known", status: "succeeded", amount: 2500, kind: "cancellation_fee" };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(r.body["payment_intent"]).toBe("pi_fee_known");
    expect(r.body["adopted"]).toBe(true);
    expect(piCalls).toHaveLength(0);
    expect(row["fee_status"]).toBe("fee_paid");
  });

  it("a succeeded fee intent found by search is adopted, not duplicated", async () => {
    cancelledWithFee();
    searchIntents = [{ id: "pi_fee_search", status: "succeeded", amount: 2500, kind: "cancellation_fee" }];
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(r.body["payment_intent"]).toBe("pi_fee_search");
    expect(r.body["adopted"]).toBe(true);
    expect(piCalls).toHaveLength(0);
    expect(row["fee_status"]).toBe("fee_paid");
  });

  it("a known fee intent for the WRONG amount is refused (409), never charged", async () => {
    cancelledWithFee();
    row = { ...row, fee_intent_id: "pi_fee_known" };
    knownIntent = { id: "pi_fee_known", status: "succeeded", amount: 5000, kind: "cancellation_fee" };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_intent_mismatch");
    expect(r.body["reason"]).toBe("amount_mismatch");
    expect(piCalls).toHaveLength(0);
    expect(row["fee_status"]).toBe("fee_failed");
  });

  it("a searched fee intent for the WRONG amount is refused (409), no second intent", async () => {
    cancelledWithFee();
    searchIntents = [{ id: "pi_fee_search", status: "processing", amount: 5000, kind: "cancellation_fee" }];
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_intent_mismatch");
    expect(r.body["reason"]).toBe("amount_mismatch");
    expect(piCalls).toHaveLength(0);
  });

  it("a non-fee intent id on the fee row is refused (409 wrong_kind)", async () => {
    cancelledWithFee();
    row = { ...row, fee_intent_id: "pi_cleaning" };
    knownIntent = { id: "pi_cleaning", status: "succeeded", amount: 2500 };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_intent_mismatch");
    expect(r.body["reason"]).toBe("wrong_kind");
    expect(piCalls).toHaveLength(0);
  });

  it("a cancelled known fee intent does not block a retry — a fresh intent is created", async () => {
    cancelledWithFee();
    row = { ...row, fee_intent_id: "pi_fee_dead" };
    knownIntent = { id: "pi_fee_dead", status: "canceled", amount: 2500, kind: "cancellation_fee" };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].amount).toBe("2500");
  });

  it("a pinned fee amount that disagrees with the journal is refused (409)", async () => {
    cancelledWithFee();
    row = { ...row, fee_amount_cents: 5000 };
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("fee_basis_mismatch");
    expect(r.body["reason"]).toBe("pinned_amount_mismatch");
    expect(r.body["journal_cents"]).toBe(2500);
    expect(r.body["pinned_cents"]).toBe(5000);
    expect(piCalls).toHaveLength(0);
  });

  it("with no prior intent and no mismatch, the fee is charged once for the journal amount", async () => {
    cancelledWithFee();
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].amount).toBe("2500");
    expect(piCalls[0].paymentMethod).toBe(PM_A);
    expect(row["fee_status"]).toBe("fee_paid");
  });
});
