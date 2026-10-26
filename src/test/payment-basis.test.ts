// @vitest-environment node
// G2/G3/O4: a charge needs a saved payment basis — the CLIENT's own
// report approval, or the 24h timer rule (report sent 24h+ ago, no issue
// ever). An operator approval is not a basis, and a (re-)send never
// re-prices the visit: the pinned row amount wins over the recurring
// price. A payment_failed retry passes on the same saved basis.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/booking-action";

const BID = "bid-basis";
const VISIT_ID = "55555555-6666-7777-8888-999999999999";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let photoRows: Row[];
let storeMeta: Record<string, string>;
let piCalls: { amount: string }[];
let resendBodies: string[];

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
    visit_date: "2027-01-15", window: "midday",
  };
  events = [created()];
  photoRows = [{ room: "Kitchen", storage_path: "visits/x/after.jpg", note: null }];
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent", gh_report_sent_at: hoursAgo(30),
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
    gh_recurring_price_cents: "12000", gh_payment_method: "pm_1", gh_report_version: "1",
  };
  piCalls = [];
  resendBodies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      resendBodies.push(String(init?.body ?? ""));
      return okRes({ id: "email-1" });
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        const query = u.searchParams.get("query") ?? "";
        const bidM = /gh_booking_id'\]:'([^']+)'/.exec(query);
        const found = bidM
          ? (storeMeta["gh_booking_id"] === bidM[1] ? [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] : [])
          : [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }];
        return okRes({ data: found });
      }
      if (u.pathname.endsWith("/payment_intents")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        piCalls.push({ amount: params.get("amount") ?? "" });
        return okRes({ id: "pi_1", status: "succeeded" });
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
        return okRes(null);
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
      return okRes(photoRows);
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

describe("G3: charge needs a saved payment basis", () => {
  it("card_ready booking with no sent report cannot be charged", async () => {
    row = { ...row, status: "requested", report_sent_at: null, report_status: "none" };
    storeMeta = { ...storeMeta, gh_state: "card_ready", gh_report_sent_at: "" };
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_basis_missing");
    expect(piCalls).toHaveLength(0);
  });

  it("report sent <24h ago with no client approval cannot be charged", async () => {
    row = { ...row, report_sent_at: hoursAgo(5) };
    storeMeta = { ...storeMeta, gh_report_sent_at: hoursAgo(5) };
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_basis_missing");
    expect(piCalls).toHaveLength(0);
  });

  it("report sent 30h ago with no issue charges on the timer rule", async () => {
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].amount).toBe("20000");
  });

  it("client approval charges immediately, without waiting 24h", async () => {
    row = { ...row, report_sent_at: hoursAgo(5) };
    storeMeta = { ...storeMeta, gh_report_sent_at: hoursAgo(5) };
    events = [created(), ev("report_approved", {}, hoursAgo(1))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(piCalls).toHaveLength(1);
  });

  it("an operator approval event alone is not a basis", async () => {
    row = { ...row, report_sent_at: hoursAgo(5) };
    storeMeta = { ...storeMeta, gh_report_sent_at: hoursAgo(5) };
    events = [created(), ev("report_approved", { via: "operator_approve" }, hoursAgo(1))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_basis_missing");
    expect(piCalls).toHaveLength(0);
  });

  it("operator approve is closed", async () => {
    const r = await call({ action: "approve" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("operator_approve_disabled");
  });

  it("an already-paid row never charges again, even with a new report version", async () => {
    row = { ...row, status: "paid" };
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 2 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("already_paid");
    expect(piCalls).toHaveLength(0);
  });
});

describe("G2: a resend never re-prices the visit", () => {
  it("resend of a $200 visit with a $120 recurring price pins $200", async () => {
    const r = await call({ action: "send_report", photos: [] });
    expect(r.code).toBe(200);
    expect(r.body["report_version"]).toBe(2);
    expect(storeMeta["gh_report_amount_cents"]).toBe("20000");
    expect(resendBodies.join(" ")).toContain("$200");
    expect(resendBodies.join(" ")).not.toContain("$120");
  });

  it("charge with the recurring price instead of the pinned price is refused", async () => {
    events = [created(), ev("report_approved", {}, hoursAgo(1))];
    // Simulate the old buggy resend pin (meta says 12000): the quoted
    // check passes, but the row-pinned layer must still refuse.
    storeMeta = { ...storeMeta, gh_report_amount_cents: "12000" };
    const r = await call({ action: "charge", amount_cents: 12000, report_version: 1 });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("price_review_required");
    expect(r.body["pinned_cents"]).toBe(20000);
    expect(piCalls).toHaveLength(0);
  });
});

describe("O1: resolve gate is booking-scoped; a published report can return for fixes", () => {
  it("resolve works when the row has an open issue even if shared state says otherwise", async () => {
    row = { ...row, issue_open: true, issue_ever: true };
    storeMeta = { ...storeMeta, gh_state: "report_sent", gh_issue_open: "" };
    events = [created(), ev("issue_opened", { reason: "streaks", room: "Kitchen" }, hoursAgo(2))];
    const r = await call({ action: "resolve" });
    expect(r.code).toBe(200);
    expect(row["issue_open"]).toBe(false);
  });
  it("resolve refuses when the row has no open issue even if shared state says issue_open", async () => {
    row = { ...row, issue_open: false, issue_ever: false };
    storeMeta = { ...storeMeta, gh_state: "issue_open", gh_issue_open: "1" };
    events = [created()];
    const r = await call({ action: "resolve" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("nothing_to_resolve");
  });
  it("a sent report with an open issue returns to the cleaner for fixes", async () => {
    row = { ...row, report_status: "sent", issue_open: true, issue_ever: true };
    events = [created(), ev("issue_opened", { reason: "streaks", room: "Kitchen" }, hoursAgo(2))];
    const sentAt = row["report_sent_at"];
    const r = await call({ action: "return_report", note: "Redo the kitchen floor" });
    expect(r.code).toBe(200);
    expect(r.body["report_status"]).toBe("returned");
    expect(row["report_status"]).toBe("returned");
    expect(row["issue_open"]).toBe(true);
    expect(row["report_sent_at"]).toBe(sentAt);
  });
  it("a sent report without an open issue cannot return (the clock would run mid-fix)", async () => {
    row = { ...row, report_status: "sent", issue_open: false, issue_ever: false };
    events = [created()];
    const r = await call({ action: "return_report", note: "Redo" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_not_submitted");
  });
});

describe("O4: payment_failed retry passes on the saved basis", () => {
  it("retry after a failed charge succeeds when the client approved", async () => {
    storeMeta = { ...storeMeta, gh_state: "payment_failed" };
    events = [created(), ev("report_approved", {}, hoursAgo(2)), ev("payment_failed", { reason: "card declined" }, hoursAgo(1))];
    const r = await call({ action: "charge", amount_cents: 20000, report_version: 1 });
    expect(r.code).toBe(200);
    expect(r.body["state"]).toBe("paid");
    expect(piCalls).toHaveLength(1);
  });
});
