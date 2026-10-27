// @vitest-environment node
// RA10: the Stripe webhook must keep the cleaning obligation and the
// cancellation-fee obligation apart. A succeeded $25 fee intent for a
// cancelled booking must NOT flip the cleaning to paid, must NOT
// touch the visit row's cleaning status, and must NOT send the $200
// cleaning receipt — it records the fee and sends a receipt for
// exactly $25. Redeliveries (same event id, or a new event id for the
// same intent) change nothing twice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import handler from "../../api/stripe-webhook";

const BID = "bid-ra10";
const VISIT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const WHSEC = "whsec_test_ra10";

let storeMeta: Record<string, string>;
let row: Record<string, unknown>;
let events: Array<{ event: string; detail: Record<string, unknown> | null }>;
let resendBodies: string[];

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

const feeEvent = (id: string) => ({
  id,
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_fee_1",
      customer: "cus_fee",
      amount: 2500,
      metadata: { gh_booking_id: BID, gh_kind: "cancellation_fee" },
    },
  },
});

const cleaningEvent = (id: string) => ({
  id,
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_clean_1",
      customer: "cus_fee",
      amount: 20000,
      metadata: { gh_booking_id: BID },
    },
  },
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  storeMeta = {
    gh_booking_id: BID, gh_state: "cancelled",
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
    gh_payment_method: "pm_1",
  };
  row = { id: VISIT_ID, booking_id: BID, status: "cancelled", payment_intent_id: null, receipt_email_id: null };
  events = [];
  resendBodies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      resendBodies.push(String(init?.body ?? ""));
      return okRes({ id: "email-fee-1" });
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
          return okRes({ id: "cus_fee" });
        }
        return okRes({ id: "cus_fee", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_fee" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        Object.assign(row, JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return okRes([row]);
      }
      return okRes([row]);
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null };
        events.push({ event: body.event ?? "", detail: body.detail ?? null });
        return okRes([{ id: events.length }]);
      }
      return okRes(events);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA10 webhook obligation split", () => {
  it("a $25 fee webhook leaves the cancelled cleaning cancelled and receipts exactly $25", async () => {
    const res = response();
    await handler(signedReq(feeEvent("evt_fee_1")) as never, res as never);
    expect(res.code).toBe(200);
    expect(storeMeta["gh_state"]).toBe("cancelled");
    expect(row["status"]).toBe("cancelled");
    expect(row["payment_intent_id"]).toBeNull();
    expect(events.filter((e) => e.event === "cancellation_fee_paid")).toHaveLength(1);
    expect(events[0].detail?.["amount_cents"]).toBe(2500);
    expect(resendBodies).toHaveLength(1);
    const receipt = JSON.parse(resendBodies[0]) as { subject: string; text: string };
    expect(receipt.subject).toContain("late-cancellation fee");
    expect(receipt.subject).toContain("$25");
    expect(receipt.text).toContain("$25");
    expect(receipt.text).not.toContain("cleaning is paid");
    expect(receipt.text).not.toContain("$200");
  });

  it("fee redelivery changes nothing twice", async () => {
    const r1 = response();
    await handler(signedReq(feeEvent("evt_fee_1")) as never, r1 as never);
    expect(r1.code).toBe(200);
    const r2 = response();
    await handler(signedReq(feeEvent("evt_fee_1")) as never, r2 as never);
    expect(r2.code).toBe(200);
    const r3 = response();
    await handler(signedReq(feeEvent("evt_fee_2")) as never, r3 as never);
    expect(r3.code).toBe(200);
    expect(resendBodies).toHaveLength(1);
    expect(events.filter((e) => e.event === "cancellation_fee_paid")).toHaveLength(1);
    expect(storeMeta["gh_state"]).toBe("cancelled");
    expect(row["status"]).toBe("cancelled");
  });

  it("a cleaning webhook still pays the cleaning and receipts $200", async () => {
    storeMeta["gh_state"] = "report_sent";
    row["status"] = "report_sent";
    const res = response();
    await handler(signedReq(cleaningEvent("evt_clean_1")) as never, res as never);
    expect(res.code).toBe(200);
    expect(storeMeta["gh_state"]).toBe("paid");
    expect(row["status"]).toBe("paid");
    expect(row["payment_intent_id"]).toBe("pi_clean_1");
    expect(resendBodies).toHaveLength(1);
    const receipt = JSON.parse(resendBodies[0]) as { subject: string; text: string };
    expect(receipt.subject).toContain("$200");
    expect(receipt.text).toContain("cleaning is paid");
  });
});
