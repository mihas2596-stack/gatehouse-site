// @vitest-environment node
// Fix round 2 — Stripe webhook:
//   - payment_intent.succeeded verifies the payment basis first: a
//     waived visit, a future-dated visit, or a refunded visit is NOT
//     marked paid; the anomaly is journaled as
//     payment_succeeded_no_basis for manual review (no receipt).
//   - charge.refunded: a full refund moves the visit Paid -> Refunded
//     and journals payment_refunded; a partial refund only journals.
//   - charge.dispute.created: journals payment_disputed and opens an
//     issue on a paid visit (blocking further auto-charge); the visit
//     stays Paid (the money is held, not refunded yet).
//   - Redeliveries journal nothing twice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import handler from "../../api/stripe-webhook";

const BID = "bid-fix2-webhook";
const VISIT_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const WHSEC = "whsec_test_fix2";

let storeMeta: Record<string, string>;
let row: Record<string, unknown>;
let events: Array<{ event: string; detail: Record<string, unknown> | null; visit_id?: string | null; booking_id?: string | null }>;
let resendBodies: string[];
let webhookEvents: Array<Record<string, unknown>>;

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

function signedReq(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  const req = {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
  return req;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const succeededEvent = (id: string, pi: string, amount: number) => ({
  id,
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: pi,
      customer: "cus_fix2",
      amount,
      metadata: { gh_booking_id: BID },
    },
  },
});

const refundEvent = (id: string, pi: string, amount: number, amountRefunded: number, refunded: boolean) => ({
  id,
  type: "charge.refunded",
  data: {
    object: {
      id: "ch_fix2",
      payment_intent: pi,
      amount,
      amount_refunded: amountRefunded,
      refunded,
    },
  },
});

const disputeEvent = (id: string, pi: string, amount: number) => ({
  id,
  type: "charge.dispute.created",
  data: {
    object: {
      id: "dp_fix2",
      payment_intent: pi,
      amount,
      reason: "fraudulent",
    },
  },
});

// Generic Supabase query filter: supports eq./neq. on the fields the
// handler uses, plus order/limit.
function filterRows(list: Record<string, unknown>[], u: URL): Record<string, unknown>[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "offset" || k === "select") continue;
    if (v.startsWith("eq.")) {
      const want = decodeURIComponent(v.slice(3));
      out = out.filter((r) => String(r[k] ?? "") === want);
    } else if (v.startsWith("neq.")) {
      const want = decodeURIComponent(v.slice(4));
      out = out.filter((r) => String(r[k] ?? "") !== want);
    }
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

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent",
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
    gh_payment_method: "pm_1",
  };
  // A sent, approved report for a past visit — a valid basis.
  row = {
    id: VISIT_ID, booking_id: BID, status: "report_sent",
    payment_intent_id: null, receipt_email_id: null,
    amount_cents: 20000, visit_date: "2026-11-10",
    issue_open: false, issue_ever: false,
    report_sent_at: hoursAgo(30), report_bounced: false,
    charge_waived: false, stripe_customer_id: "cus_fix2",
  };
  events = [
    { event: "report_sent", detail: { email_sent: true, version: 1 }, visit_id: VISIT_ID, booking_id: BID },
    { event: "report_approved", detail: {}, visit_id: VISIT_ID, booking_id: BID },
  ];
  resendBodies = [];
  webhookEvents = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const okRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      resendBodies.push(String(init?.body ?? ""));
      return okRes({ id: "email-fix2-1" });
    }
    if (u.hostname === "api.stripe.com") {
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return okRes({ id: "cus_fix2" });
        }
        return okRes({ id: "cus_fix2", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_fix2" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const matched = filterRows([row], u);
        for (const r of matched) Object.assign(r, patch);
        return okRes(matched);
      }
      return okRes(filterRows([row], u));
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null; visit_id?: string | null; booking_id?: string | null };
        const inserted = { ...body, created_at: new Date().toISOString() };
        events.push({ event: body.event ?? "", detail: body.detail ?? null, visit_id: body.visit_id ?? null, booking_id: body.booking_id ?? null });
        return okRes([inserted]);
      }
      return okRes(filterRows(events as unknown as Record<string, unknown>[], u));
    }
    if (u.pathname.includes("/rest/v1/gh_webhook_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        webhookEvents.push(body);
        return okRes([{ ...body, id: webhookEvents.length }]);
      }
      return okRes(filterRows(webhookEvents, u));
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("fix round 2: webhook basis check", () => {
  it("a succeeded intent on a waived visit does NOT mark paid; journals payment_succeeded_no_basis", async () => {
    events.push({ event: "issue_opened", detail: { reason: "Streaks" }, visit_id: VISIT_ID, booking_id: BID });
    events.push({ event: "issue_decision", detail: { decision: "waived", resolution: "On us" }, visit_id: VISIT_ID, booking_id: BID });
    const res = response();
    await handler(signedReq(succeededEvent("evt_fix2_waived", "pi_fix2_1", 20000)) as never, res as never);
    expect(res.code).toBe(200);
    expect(row["status"]).toBe("report_sent");
    expect(row["payment_intent_id"]).toBeNull();
    expect(storeMeta["gh_state"]).toBe("report_sent");
    const blocked = events.filter((e) => e.event === "payment_succeeded_no_basis");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].detail?.["reason"]).toBe("charge_waived");
    expect(blocked[0].detail?.["payment_intent"]).toBe("pi_fix2_1");
    expect(events.filter((e) => e.event === "payment_succeeded")).toHaveLength(0);
    expect(resendBodies).toHaveLength(0);
  });

  it("a succeeded intent on a future-dated visit does NOT mark paid; reason report_too_early", async () => {
    row["visit_date"] = "2027-01-15";
    const res = response();
    await handler(signedReq(succeededEvent("evt_fix2_future", "pi_fix2_2", 20000)) as never, res as never);
    expect(res.code).toBe(200);
    expect(row["status"]).toBe("report_sent");
    expect(storeMeta["gh_state"]).toBe("report_sent");
    const blocked = events.filter((e) => e.event === "payment_succeeded_no_basis");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].detail?.["reason"]).toBe("report_too_early");
    expect(resendBodies).toHaveLength(0);
  });

  it("a succeeded intent on a valid basis still marks paid (control)", async () => {
    const res = response();
    await handler(signedReq(succeededEvent("evt_fix2_valid", "pi_fix2_3", 20000)) as never, res as never);
    expect(res.code).toBe(200);
    expect(row["status"]).toBe("paid");
    expect(row["payment_intent_id"]).toBe("pi_fix2_3");
    expect(storeMeta["gh_state"]).toBe("paid");
    expect(events.filter((e) => e.event === "payment_succeeded")).toHaveLength(1);
    expect(events.filter((e) => e.event === "payment_succeeded_no_basis")).toHaveLength(0);
    expect(resendBodies).toHaveLength(1);
  });
});

describe("fix round 2: refunds and disputes", () => {
  it("a full refund moves the visit Paid -> Refunded and journals payment_refunded", async () => {
    row["status"] = "paid";
    row["payment_intent_id"] = "pi_fix2_1";
    storeMeta["gh_state"] = "paid";
    const res = response();
    await handler(signedReq(refundEvent("evt_fix2_refund_full", "pi_fix2_1", 20000, 20000, true)) as never, res as never);
    expect(res.code).toBe(200);
    expect(row["status"]).toBe("refunded");
    expect(storeMeta["gh_state"]).toBe("refunded");
    const refunded = events.filter((e) => e.event === "payment_refunded");
    expect(refunded).toHaveLength(1);
    expect(refunded[0].detail?.["refunded"]).toBe(true);
    expect(refunded[0].detail?.["amount_cents"]).toBe(20000);
    expect(resendBodies).toHaveLength(0);
  });

  it("a partial refund only journals; the visit stays Paid", async () => {
    row["status"] = "paid";
    row["payment_intent_id"] = "pi_fix2_1";
    storeMeta["gh_state"] = "paid";
    const res = response();
    await handler(signedReq(refundEvent("evt_fix2_refund_part", "pi_fix2_1", 20000, 5000, false)) as never, res as never);
    expect(res.code).toBe(200);
    expect(row["status"]).toBe("paid");
    expect(storeMeta["gh_state"]).toBe("paid");
    const refunded = events.filter((e) => e.event === "payment_refunded");
    expect(refunded).toHaveLength(1);
    expect(refunded[0].detail?.["refunded"]).toBe(false);
    expect(refunded[0].detail?.["amount_cents"]).toBe(5000);
  });

  it("a dispute journals payment_disputed and opens an issue; the visit stays Paid", async () => {
    row["status"] = "paid";
    row["payment_intent_id"] = "pi_fix2_1";
    const res = response();
    await handler(signedReq(disputeEvent("evt_fix2_dispute", "pi_fix2_1", 20000)) as never, res as never);
    expect(res.code).toBe(200);
    expect(row["status"]).toBe("paid");
    expect(row["issue_open"]).toBe(true);
    expect(row["issue_ever"]).toBe(true);
    const disputed = events.filter((e) => e.event === "payment_disputed");
    expect(disputed).toHaveLength(1);
    expect(disputed[0].detail?.["dispute"]).toBe("dp_fix2");
    expect(disputed[0].detail?.["reason"]).toBe("fraudulent");
    expect(resendBodies).toHaveLength(0);
  });

  it("a refund redelivery journals nothing twice", async () => {
    row["status"] = "paid";
    row["payment_intent_id"] = "pi_fix2_1";
    const r1 = response();
    await handler(signedReq(refundEvent("evt_fix2_refund_dup", "pi_fix2_1", 20000, 20000, true)) as never, r1 as never);
    expect(r1.code).toBe(200);
    const r2 = response();
    await handler(signedReq(refundEvent("evt_fix2_refund_dup", "pi_fix2_1", 20000, 20000, true)) as never, r2 as never);
    expect(r2.code).toBe(200);
    const r3 = response();
    await handler(signedReq(refundEvent("evt_fix2_refund_dup2", "pi_fix2_1", 20000, 20000, true)) as never, r3 as never);
    expect(r3.code).toBe(200);
    expect(events.filter((e) => e.event === "payment_refunded")).toHaveLength(1);
    expect(row["status"]).toBe("refunded");
  });
});
