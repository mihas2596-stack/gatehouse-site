// @vitest-environment node
// MA-02 / DA-14 (high) + MB-01 / N-1 (medium) — maximal audit 14.11.2026.
//   MA-02: client cancel blocked only paid/report_sent/approved/
//     payment_unknown, but deriveVisitState returns issue_open BEFORE
//     report_sent (waived earlier still, refunded earlier still), so a
//     report-sent visit with an open dispute — or a waived / refunded
//     visit — could be cancelled by a crafted POST, journaling
//     visit_cancelled with a $25 fee. The guard must block on the
//     DERIVED state: issue_open, waived, refunded.
//   MB-01: payment_intent.succeeded could mirror a cancelled visit as
//     paid (webhook CAS was status=neq.paid, basis check knew only
//     refunded). A cancelled visit now has NO payment basis, and the
//     webhook journals payment_succeeded_no_basis with reason
//     "cancelled" instead of marking paid.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import visitHandler from "../../api/visit";
import webhookHandler from "../../api/stripe-webhook";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-ma02-cancel-webhook";
const VISIT_ID = "22222222-3333-4444-5555-666666666666";
const LINK_SECRET = "link-secret-ma02";
const WHSEC = "whsec_test_ma02";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const future = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

function response() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

function matchCond(r: Record<string, unknown>, field: string, op: string, val: string): boolean {
  const v = r[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  return false;
}
function applyDbFilters(list: Record<string, unknown>[], u: URL): Record<string, unknown>[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select" || k === "offset") continue;
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => {
      const c = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
      return dir === "desc" ? -c : c;
    });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

// ---------------------------------------------------------------------------
// MA-02: client cancel
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string; booking_id?: string };

let row: Row;
let events: Ev[];
let accessRows: Row[];
let storeMeta: Record<string, string>;
let resendBodies: string[];
let stripePosts: string[];

function installVisitFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const sbRes = (data: unknown) => ({
      ok: true, status: 200,
      json: async () => data, text: async () => JSON.stringify(data),
    });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const list: Record<string, unknown>[] = table === "gh_visits" ? [row] : table === "gh_events" ? events : accessRows;
      if (method === "GET") return sbRes(applyDbFilters(list, u));
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, id: `ev-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString() };
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
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
        return sbRes({ data: [{ id: "cus_ma02", email: "client@example.com", name: "Casey Client", metadata: storeMeta }] });
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
        return sbRes({ id: "cus_ma02", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
}

const bt = () => signBooking(LINK_SECRET, {
  bid: BID, email: "client@example.com", name: "Casey Client",
}).token;
const cancelReq = () => ({ method: "POST", headers: {}, body: { bt: bt(), action: "cancel", scope: "once" } });

describe("MA-02: client cancel on derived terminal/disputed states", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("BOOKING_LINK_SECRET", LINK_SECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Report sent 30h ago for a past visit, approved by the client.
    row = {
      id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 20000,
      cleaner_name: "Ana", client_email: "client@example.com",
      report_sent_at: hoursAgo(30), report_bounced: false, report_status: "sent",
      visit_date: "2026-11-10", window: "morning", issue_open: false, issue_ever: false,
      charge_waived: false, no_photo_zones: null,
    };
    events = [
      { event: "visit_created", detail: {}, created_at: hoursAgo(50), booking_id: BID },
      { event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: hoursAgo(30), booking_id: BID },
      { event: "report_approved", detail: {}, created_at: hoursAgo(29), booking_id: BID },
    ];
    accessRows = [];
    storeMeta = {
      gh_booking_id: BID, gh_state: "report_sent",
      gh_confirmed_date: "2026-11-10", gh_confirmed_window: "morning",
      gh_report_sent_at: hoursAgo(30),
      gh_payment_method: "pm_test_1", gh_first_price_cents: "20000",
    };
    resendBodies = [];
    stripePosts = [];
    installVisitFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("report sent + open issue derives issue_open and cancel is refused (409, no fee, no journal)", async () => {
    // The dispute: deriveVisitState returns issue_open BEFORE report_sent.
    row["issue_open"] = true;
    row["issue_ever"] = true;
    storeMeta["gh_issue_open"] = "1";
    events.push({ event: "issue_opened", detail: { reason: "Streaks" }, created_at: hoursAgo(5), booking_id: BID });
    const r = response();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_already_done");
    expect(row["status"]).toBe("report_sent");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(0);
    expect(stripePosts).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
  });

  it("waived visit derives waived and cancel is refused (409)", async () => {
    // The waive mirror writes gh_state "approved"; gh_charge_waived
    // is what makes deriveVisitState return "waived" first.
    storeMeta["gh_state"] = "approved";
    storeMeta["gh_charge_waived"] = "1";
    row["charge_waived"] = true;
    events.push({ event: "issue_opened", detail: { reason: "Streaks" }, created_at: hoursAgo(5), booking_id: BID });
    events.push({ event: "issue_decision", detail: { decision: "waived", resolution: "On us" }, created_at: hoursAgo(4), booking_id: BID });
    const r = response();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_already_done");
    expect(row["status"]).toBe("report_sent");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(0);
    expect(stripePosts).toHaveLength(0);
  });

  it("refunded visit derives refunded and cancel is refused (409, refund record kept)", async () => {
    row["status"] = "refunded";
    row["payment_intent_id"] = "pi_ma02_1";
    storeMeta["gh_state"] = "refunded";
    const r = response();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_already_done");
    expect(row["status"]).toBe("refunded");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(0);
    expect(stripePosts).toHaveLength(0);
  });

  it("control: a confirmed visit still cancels (200, $25 fee inside 48h)", async () => {
    const visitDate = future(1);
    row["status"] = "confirmed";
    row["report_sent_at"] = null;
    row["report_status"] = "none";
    row["visit_date"] = visitDate;
    storeMeta["gh_state"] = "confirmed";
    storeMeta["gh_confirmed_date"] = visitDate;
    delete storeMeta["gh_report_sent_at"];
    events = [
      { event: "visit_created", detail: {}, created_at: hoursAgo(50), booking_id: BID },
      { event: "visit_confirmed", detail: { date: visitDate, window: "morning" }, created_at: hoursAgo(49), booking_id: BID },
    ];
    const r = response();
    await visitHandler(cancelReq() as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["fee_cents"]).toBe(2500);
    expect(row["status"]).toBe("cancelled");
    expect(events.filter((e) => e.event === "visit_cancelled")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MB-01: webhook payment_intent.succeeded on a cancelled visit
// ---------------------------------------------------------------------------

let whRow: Row;
let whEvents: Ev[];
let whMeta: Record<string, string>;
let whResend: string[];
let whWebhookEvents: Array<Record<string, unknown>>;

function signedReq(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  return {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
}

const succeededEvent = (id: string, pi: string, amount: number) => ({
  id,
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: pi,
      customer: "cus_ma02",
      amount,
      metadata: { gh_booking_id: BID },
    },
  },
});

describe("MB-01: webhook must not resurrect a cancelled visit as paid", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Otherwise-valid basis: report sent 30h ago, client approved,
    // past visit — only the cancelled status blocks the basis.
    whRow = {
      id: VISIT_ID, booking_id: BID, status: "report_sent",
      payment_intent_id: null, receipt_email_id: null,
      amount_cents: 20000, visit_date: "2026-11-10",
      issue_open: false, issue_ever: false,
      report_sent_at: hoursAgo(30), report_bounced: false,
      charge_waived: false, stripe_customer_id: "cus_ma02",
    };
    whEvents = [
      { event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: hoursAgo(30), booking_id: BID },
      { event: "report_approved", detail: {}, created_at: hoursAgo(29), booking_id: BID },
    ];
    whMeta = {
      gh_booking_id: BID, gh_state: "report_sent",
      gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
      gh_payment_method: "pm_1",
    };
    whResend = [];
    whWebhookEvents = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      const okRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
      if (u.hostname === "api.resend.com") {
        whResend.push(String(init?.body ?? ""));
        return okRes({ id: "email-ma02-1" });
      }
      if (u.hostname === "api.stripe.com") {
        const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
        if (custM) {
          if (init?.body) {
            const params = new URLSearchParams(String(init.body));
            for (const [k, v] of params.entries()) {
              const m = /^metadata\[(.+)\]$/.exec(k);
              if (m) whMeta[m[1]] = v;
            }
            return okRes({ id: "cus_ma02" });
          }
          return okRes({ id: "cus_ma02", email: "client@example.com", name: "Casey Client", metadata: whMeta });
        }
        return okRes({ id: "cus_ma02" });
      }
      if (u.pathname.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const matched = applyDbFilters([whRow], u);
          for (const r of matched) Object.assign(r, patch);
          return okRes(matched);
        }
        return okRes(applyDbFilters([whRow], u));
      }
      if (u.pathname.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null; visit_id?: string | null; booking_id?: string | null };
          const inserted = { ...body, created_at: new Date().toISOString() };
          whEvents.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: inserted.created_at, booking_id: body.booking_id ?? null });
          return okRes([inserted]);
        }
        return okRes(applyDbFilters(whEvents as unknown as Record<string, unknown>[], u));
      }
      if (u.pathname.includes("/rest/v1/gh_webhook_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          whWebhookEvents.push(body);
          return okRes([{ ...body, id: whWebhookEvents.length }]);
        }
        return okRes(applyDbFilters(whWebhookEvents, u));
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("a succeeded intent on a cancelled visit does NOT mark paid; journals payment_succeeded_no_basis reason=cancelled", async () => {
    whRow["status"] = "cancelled";
    whMeta["gh_state"] = "cancelled";
    const res = response();
    await webhookHandler(signedReq(succeededEvent("evt_ma02_cancelled", "pi_ma02_1", 20000)) as never, res as never);
    expect(res.code).toBe(200);
    expect(whRow["status"]).toBe("cancelled");
    expect(whRow["payment_intent_id"]).toBeNull();
    expect(whMeta["gh_state"]).toBe("cancelled");
    const blocked = whEvents.filter((e) => e.event === "payment_succeeded_no_basis");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].detail?.["reason"]).toBe("cancelled");
    expect(blocked[0].detail?.["payment_intent"]).toBe("pi_ma02_1");
    expect(whEvents.filter((e) => e.event === "payment_succeeded")).toHaveLength(0);
    expect(whResend).toHaveLength(0);
  });

  it("control: a succeeded intent on a report_sent visit with approval still marks paid", async () => {
    const res = response();
    await webhookHandler(signedReq(succeededEvent("evt_ma02_valid", "pi_ma02_2", 20000)) as never, res as never);
    expect(res.code).toBe(200);
    expect(whRow["status"]).toBe("paid");
    expect(whRow["payment_intent_id"]).toBe("pi_ma02_2");
    expect(whMeta["gh_state"]).toBe("paid");
    expect(whEvents.filter((e) => e.event === "payment_succeeded")).toHaveLength(1);
    expect(whEvents.filter((e) => e.event === "payment_succeeded_no_basis")).toHaveLength(0);
    expect(whResend).toHaveLength(1);
  });

  it("control: a succeeded intent on a payment_pending visit still marks paid (chargeVisit CAS path)", async () => {
    whRow["status"] = "payment_pending";
    whMeta["gh_state"] = "approved";
    const res = response();
    await webhookHandler(signedReq(succeededEvent("evt_ma02_pending", "pi_ma02_3", 20000)) as never, res as never);
    expect(res.code).toBe(200);
    expect(whRow["status"]).toBe("paid");
    expect(whRow["payment_intent_id"]).toBe("pi_ma02_3");
    expect(whMeta["gh_state"]).toBe("paid");
    expect(whEvents.filter((e) => e.event === "payment_succeeded")).toHaveLength(1);
    expect(whEvents.filter((e) => e.event === "payment_succeeded_no_basis")).toHaveLength(0);
  });
});
