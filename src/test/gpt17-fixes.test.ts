// @vitest-environment node
// GPT-17 (26.10.2026 audit) regressions: the charge path must never mint
// a second payment obligation from a caller-supplied report version, a
// stale approval, a bounced report, a missing row amount, or another
// booking's shared metadata. Each test pins one dangerous input and the
// safe expected result. Own file: booking-action's 30-calls/min/module
// rate limit makes a shared file impractical.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";
import { visitMomentMs } from "../../api/visit";

const BID = "bid-gpt17";
const VISIT_ID = "55555555-6666-7777-8888-999999999999";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let piCalls: { amount: string; idem: string | undefined }[];
let resendBodies: string[];
let searchIntents: Array<{ id: string; status: string; amount: number; version: string; kind?: string }>;

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
    id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 20000,
    cleaner_name: null, client_email: "client@example.com",
    report_sent_at: hoursAgo(30), report_bounced: false, report_status: "sent",
    visit_date: "2027-01-15", window: "midday", issue_open: false, issue_ever: false,
    receipt_email_id: null,
  };
  events = [created(), ev("report_sent", { version: 1 }, hoursAgo(30))];
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent", gh_report_sent_at: hoursAgo(30),
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
    gh_recurring_price_cents: "12000", gh_payment_method: "pm_1", gh_report_version: "1",
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
            metadata: { gh_booking_id: BID, gh_report_version: p.version, ...(p.kind ? { gh_kind: p.kind } : {}) },
          })),
        });
      }
      if (u.pathname.endsWith("/payment_intents")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        piCalls.push({ amount: params.get("amount") ?? "", idem: headers["Idempotency-Key"] });
        return okRes({ id: "pi_new", status: "succeeded" });
      }
      if (u.pathname.includes("/payment_intents/") && u.pathname.endsWith("/confirm")) {
        return okRes({ id: "pi_live", status: "succeeded" });
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
    if (u.pathname.includes("/storage/v1/object/sign/")) {
      return okRes({ signedURL: "https://test.supabase.co/signed/photo.jpg" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        Object.assign(row, JSON.parse(String(init?.body ?? "{}")) as Row);
        return okRes([row]);
      }
      const qBid = u.searchParams.get("booking_id");
      if (qBid && qBid.startsWith("eq.")) {
        return okRes(decodeURIComponent(qBid.slice(3)) === BID ? [row] : []);
      }
      return okRes([]);
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

describe("P04: the payment version comes from the journal, never the request", () => {
  it("a caller-supplied report_version 999 does not mint a second obligation", async () => {
    events = [created(), ev("report_sent", { version: 2 }, hoursAgo(30))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 999 });
    expect(r.code).toBe(200);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].idem).toBe(`charge_${BID}_v2`);
    expect(piCalls[0].amount).toBe("20000");
  });

  it("an already-succeeded intent for this booking and amount is adopted, not re-charged", async () => {
    searchIntents = [{ id: "pi_old", status: "succeeded", amount: 20000, version: "1" }];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(r.body["adopted"]).toBe(true);
    expect(piCalls).toHaveLength(0);
    expect(row["status"]).toBe("paid");
  });

  it("a cancellation-fee intent is never adopted as the cleaning payment", async () => {
    searchIntents = [{ id: "pi_fee", status: "succeeded", amount: 20000, version: "1", kind: "cancellation_fee" }];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(r.body["adopted"]).not.toBe(true);
    expect(piCalls).toHaveLength(1);
  });
});

describe("P01: an approval superseded by a newer publication is not consent", () => {
  it("approval v1 + republication 30 minutes ago does not authorize a charge", async () => {
    row = { ...row, report_sent_at: hoursAgo(0.5) };
    storeMeta = { ...storeMeta, gh_report_sent_at: hoursAgo(0.5) };
    events = [
      created(),
      ev("report_sent", { version: 1 }, hoursAgo(30)),
      ev("report_approved", {}, hoursAgo(2)),
      ev("report_sent", { version: 2 }, hoursAgo(0.5)),
    ];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 2 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_basis_missing");
    expect(piCalls).toHaveLength(0);
  });

  it("a fresh client approval on the current publication does authorize", async () => {
    row = { ...row, report_sent_at: hoursAgo(0.5) };
    storeMeta = { ...storeMeta, gh_report_sent_at: hoursAgo(0.5) };
    events = [
      created(),
      ev("report_sent", { version: 1 }, hoursAgo(30)),
      ev("report_sent", { version: 2 }, hoursAgo(0.5)),
      ev("report_approved", {}, hoursAgo(0.25)),
    ];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 2 });
    expect(r.code).toBe(200);
    expect(piCalls).toHaveLength(1);
  });
});

describe("P02: a bounced report blocks the timer basis but not an explicit approval", () => {
  it("bounced + 30h + no approval charges nothing", async () => {
    row = { ...row, report_bounced: true };
    storeMeta = { ...storeMeta, gh_report_bounced: "1" };
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_basis_missing");
    expect(piCalls).toHaveLength(0);
  });

  it("bounced + explicit client approval still charges (the client got the report another way)", async () => {
    row = { ...row, report_bounced: true };
    storeMeta = { ...storeMeta, gh_report_bounced: "1" };
    events = [created(), ev("report_sent", { version: 1 }, hoursAgo(30)), ev("report_approved", {}, hoursAgo(1))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(piCalls).toHaveLength(1);
  });
});

describe("P07: a row-backed booking without a pinned amount cannot be charged", () => {
  it("row amount null + rich shared metadata still blocks every charge path", async () => {
    row = { ...row, amount_cents: null };
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("quote_missing");
    expect(piCalls).toHaveLength(0);
  });
});

describe("P08: the cancellation fee comes from this booking's journal", () => {
  it("a $0 cancel is not charged another booking's $25 from shared metadata", async () => {
    row = { ...row, status: "cancelled" };
    storeMeta = { ...storeMeta, gh_state: "cancelled", gh_cancel_fee_cents: "2500", gh_fee_charged: "" };
    events = [created(), ev("visit_cancelled", { fee_cents: 0 }, hoursAgo(1))];
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("no_fee_due");
    expect(piCalls).toHaveLength(0);
  });

  it("a $25 cancel charges exactly $25 once; the second call reports already", async () => {
    row = { ...row, status: "cancelled" };
    storeMeta = { ...storeMeta, gh_state: "cancelled" };
    events = [created(), ev("visit_cancelled", { fee_cents: 2500 }, hoursAgo(1))];
    const r = await call({ action: "charge_fee" });
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].amount).toBe("2500");
    const again = await call({ action: "charge_fee" });
    expect(again.body["already"]).toBe(true);
    expect(piCalls).toHaveLength(1);
  });
});

describe("P10: another booking's receipt flag does not suppress this booking's receipt", () => {
  it("shared gh_receipt_email_id set, row receipt empty -> the receipt is still sent", async () => {
    storeMeta = { ...storeMeta, gh_receipt_email_id: "email-from-another-booking" };
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(resendBodies.length).toBeGreaterThan(0);
    expect(row["receipt_email_id"]).toBe("email-1");
  });
});

describe("P12: the 48h cancel threshold uses the real New York midday", () => {
  it("winter midday is 17:00Z (EST), summer midday is 16:00Z (EDT)", () => {
    expect(visitMomentMs({}, "2027-01-15")).toBe(Date.parse("2027-01-15T17:00:00Z"));
    expect(visitMomentMs({}, "2026-07-15")).toBe(Date.parse("2026-07-15T16:00:00Z"));
  });

  it("DST transition days keep midday local, not a fixed offset", () => {
    // 2026-03-08: spring forward (EDT from 2am) -> midday is 16:00Z.
    expect(visitMomentMs({}, "2026-03-08")).toBe(Date.parse("2026-03-08T16:00:00Z"));
    // 2026-11-01: fall back (EST from 2am) -> midday is 17:00Z.
    expect(visitMomentMs({}, "2026-11-01")).toBe(Date.parse("2026-11-01T17:00:00Z"));
  });

  it("a confirmed date in metadata wins over the requested date", () => {
    expect(visitMomentMs({ gh_confirmed_date: "2027-01-15" }, "2026-07-15"))
      .toBe(Date.parse("2027-01-15T17:00:00Z"));
  });
});
