// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createHmac } from "crypto";
import adminHandler from "../../api/booking-action";
import reportHandler from "../../api/report";
import autoChargeHandler, { selectDue } from "../../api/auto-charge";
import resendWebhookHandler from "../../api/resend-webhook";
import { signBooking } from "../../api/create-checkout-session";

// Payment-path hardening:
//  - the 24h timer charges once, only a clean due booking (no issue ever,
//    no confirmed bounce), with the amount pinned to the report;
//  - a confirmed report-email bounce voids the 24h clock (Terms);
//  - manual charge accepts the pinned report amount (recurring visits),
//    never an arbitrary one;
//  - the client sees payment_issue / delivery_failed states truthfully.

const ADMIN = ["adm", "secret"].join("-");
const CRON = ["cron", "secret"].join("-");
const WHSEC = "whsec_" + Buffer.from("test-webhook-key-0123456789").toString("base64");

type StoreCust = { id: string; email: string; name: string; metadata: Record<string, string> };

let store: StoreCust[];
let piCalls: Array<{ body: URLSearchParams; idem: string | undefined }>;
let intents: Array<{ id: string; status: string; amount: number; currency: string; customer: string | null; metadata: Record<string, string> }>;
let piBehavior: "succeeded" | "failed";
let resendCalls: unknown[];

const BASE_META: Record<string, string> = {
  gh_state: "report_sent",
  gh_payment_method: "pm_test_1",
  gh_first_price_cents: "18900",
  gh_recurring_price_cents: "13200",
  gh_report_amount_cents: "18900",
  gh_report_version: "1",
  gh_report_sent_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
  gh_report_email_id: "email-uuid-1",
};

function cust(id: string, bid: string, over: Record<string, string> = {}): StoreCust {
  return {
    id, email: "client@example.com", name: "Casey Client",
    metadata: { ...BASE_META, gh_booking_id: bid, ...over },
  };
}

function response() {
  const res = {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", ADMIN);
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WHSEC);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = [cust("cus_due", "bid-due")];
  piCalls = [];
  intents = [];
  piBehavior = "succeeded";
  resendCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const u = new URL(String(url));
    if (u.hostname === "api.resend.com") {
      resendCalls.push(init?.body);
      return { ok: true, status: 200, json: async () => ({ id: "email-uuid-1" }) };
    }
    if (u.pathname.endsWith("/customers/search")) {
      const query = u.searchParams.get("query") ?? "";
      let found = store;
      const bidM = /gh_booking_id\]':'([^']+)'/.exec(query);
      const stateM = /gh_state\]':'([^']+)'/.exec(query);
      const mailM = /gh_report_email_id\]':'([^']+)'/.exec(query);
      if (bidM) found = store.filter((c) => c.metadata["gh_booking_id"] === bidM[1]);
      if (stateM) found = store.filter((c) => c.metadata["gh_state"] === stateM[1]);
      if (mailM) found = store.filter((c) => c.metadata["gh_report_email_id"] === mailM[1]);
      return { ok: true, status: 200, json: async () => ({ data: found.map((c) => ({ id: c.id, metadata: c.metadata })) }) };
    }
    if (u.pathname.endsWith("/payment_intents")) {
      piCalls.push({ body: new URLSearchParams(String(init?.body)), idem: init?.headers?.["Idempotency-Key"] });
      const params = new URLSearchParams(String(init?.body));
      intents.push({
        id: "pi_1",
        status: piBehavior === "succeeded" ? "succeeded" : "requires_payment_method",
        amount: Number(params.get("amount") ?? 0),
        currency: "usd",
        customer: params.get("customer"),
        metadata: { gh_booking_id: params.get("metadata[gh_booking_id]") ?? "" },
      });
      if (piBehavior === "succeeded") {
        return { ok: true, status: 200, json: async () => ({ id: "pi_1", status: "succeeded" }) };
      }
      return { ok: false, status: 402, json: async () => ({ error: { message: "card declined" } }) };
    }
    if (u.pathname.endsWith("/payment_intents/search")) {
      const query = u.searchParams.get("query") ?? "";
      const bidM = /gh_booking_id'\]:'([^']+)'/.exec(query);
      const found = bidM ? intents.filter((p) => p.metadata.gh_booking_id === bidM[1]) : intents;
      return { ok: true, status: 200, json: async () => ({ data: found }) };
    }
    const piM = /\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(u.pathname);
    if (piM) {
      const found = intents.find((p) => p.id === piM[1]);
      if (!found) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
      return { ok: true, status: 200, json: async () => ({ ...found }) };
    }
    const custMatch = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
    if (custMatch) {
      const found = store.find((c) => c.id === custMatch[1]);
      if (!found) return { ok: false, status: 404, json: async () => ({}) };
      if (init?.body) {
        const params = new URLSearchParams(String(init.body));
        for (const [k, v] of params.entries()) {
          const m = /^metadata\[(.+)\]$/.exec(k);
          if (m) found.metadata[m[1]] = v;
        }
        return { ok: true, status: 200, json: async () => ({ id: found.id }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...found }) };
    }
    if (u.pathname.endsWith("/customers")) {
      return { ok: true, status: 200, json: async () => ({ data: store.map((c) => ({ id: c.id, metadata: c.metadata })) }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const cronReq = () => ({ method: "GET", headers: { authorization: `Bearer ${CRON}` } });
const adminReq = (body: Record<string, unknown>) => ({
  method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body,
});

describe("selectDue", () => {
  const now = Date.now();
  const mk = (over: Record<string, string>) => [{ id: "cus_x", metadata: { ...BASE_META, gh_booking_id: "b1", ...over } }];
  it("selects a clean due booking and skips every guarded case", () => {
    expect(selectDue(mk({}), now)).toHaveLength(1);
    expect(selectDue(mk({ gh_report_sent_at: new Date(now - 3600 * 1000).toISOString() }), now)).toHaveLength(0);
    expect(selectDue(mk({ gh_issue_ever: "1" }), now)).toHaveLength(0);
    expect(selectDue(mk({ gh_issue_open: "1" }), now)).toHaveLength(0);
    expect(selectDue(mk({ gh_report_bounced: "1" }), now)).toHaveLength(0);
    expect(selectDue(mk({ gh_state: "approved" }), now)).toHaveLength(0);
    expect(selectDue(mk({ gh_payment_method: "" }), now)).toHaveLength(0);
  });
  it("falls back to the first-visit price when no report amount is pinned", () => {
    const due = selectDue(mk({ gh_report_amount_cents: "" }), now);
    expect(due[0]?.amountCents).toBe(18900);
  });
});

describe("auto-charge timer", () => {
  it("charges a due booking once; a repeat run creates no second payment", async () => {
    store.push(cust("cus_issue", "bid-issue", { gh_issue_ever: "1" }));
    store.push(cust("cus_early", "bid-early", { gh_report_sent_at: new Date().toISOString() }));
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await autoChargeHandler(cronReq() as any, res as any);
    expect(res.code).toBe(200);
    expect(res.body["charged"]).toBe(1);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].idem).toBe("charge_bid-due_v1");
    expect(piCalls[0].body.get("amount")).toBe("18900");
    expect(store[0].metadata["gh_state"]).toBe("paid");

    const res2 = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await autoChargeHandler(cronReq() as any, res2 as any);
    expect(res2.body["charged"]).toBe(0);
    expect(piCalls).toHaveLength(1);
  });

  it("requires the cron secret", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await autoChargeHandler({ method: "GET", headers: {} } as any, res as any);
    expect(res.code).toBe(401);
    expect(piCalls).toHaveLength(0);
  });

  it("a declined timer charge lands in payment_failed, not a retry loop", async () => {
    piBehavior = "failed";
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await autoChargeHandler(cronReq() as any, res as any);
    expect(res.body["failed"]).toBe(1);
    expect(store[0].metadata["gh_state"]).toBe("payment_failed");
  });
});

describe("pinned report amount", () => {
  it("send_report rejects an amount that is not one of the agreed prices", async () => {
    store[0].metadata["gh_state"] = "card_ready";
    delete store[0].metadata["gh_report_sent_at"];
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "send_report", booking_id: "bid-due", photos: [], amount_cents: 9999 }) as any, res as any);
    expect(res.code).toBe(400);
    expect(res.body["error"]).toBe("amount_not_agreed");
  });

  it("send_report pins the recurring price for a later visit and stores the email id", async () => {
    store[0].metadata = {
      gh_booking_id: "bid-due", gh_state: "card_ready",
      gh_payment_method: "pm_test_1", gh_first_price_cents: "18900",
      gh_recurring_price_cents: "13200", gh_report_version: "1",
    };
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "send_report", booking_id: "bid-due", photos: [], amount_cents: 13200 }) as any, res as any);
    expect(res.code).toBe(200);
    expect(store[0].metadata["gh_report_amount_cents"]).toBe("13200");
    expect(store[0].metadata["gh_report_email_id"]).toBe("email-uuid-1");
  });

  it("manual charge accepts the pinned report amount and rejects the other price", async () => {
    store[0].metadata["gh_state"] = "approved";
    const bad = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "charge", booking_id: "bid-due", amount_cents: 13200 }) as any, bad as any);
    expect(bad.code).toBe(409);
    expect(bad.body["error"]).toBe("amount_mismatch");
    const good = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "charge", booking_id: "bid-due", amount_cents: 18900, report_version: 1 }) as any, good as any);
    // gh_report_amount_cents is 18900 in BASE_META, so 18900 is the pinned one here.
    expect(good.code).toBe(200);
    expect(store[0].metadata["gh_state"]).toBe("paid");
  });
});

function svixReq(raw: string, sigOverride?: string) {
  const id = "msg_test_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(WHSEC.slice(6), "base64");
  const sig = "v1," + createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  const gen = (async function* () { yield Buffer.from(raw, "utf8"); })();
  return Object.assign(gen, {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sigOverride ?? sig,
    },
  });
}

describe("resend bounce webhook", () => {
  const bounceBody = JSON.stringify({ type: "email.bounced", data: { email_id: "email-uuid-1" } });

  it("voids the 24h clock on a confirmed bounce", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resendWebhookHandler(svixReq(bounceBody) as any, res as any);
    expect(res.code).toBe(200);
    expect(res.body["bounced"]).toBe(true);
    expect(store[0].metadata["gh_report_bounced"]).toBe("1");
    expect(store[0].metadata["gh_report_sent_at"]).toBe("");
    expect(store[0].metadata["gh_state"]).toBe("card_ready");
  });

  it("rejects a bad signature and ignores bounces after approval", async () => {
    const bad = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resendWebhookHandler(svixReq(bounceBody, "v1,AAAA") as any, bad as any);
    expect(bad.code).toBe(401);
    store[0].metadata["gh_state"] = "approved";
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resendWebhookHandler(svixReq(bounceBody) as any, res as any);
    expect(res.body["ignored"]).toBe(true);
    expect(store[0].metadata["gh_report_bounced"]).toBeUndefined();
  });

  it("is inert without a configured secret", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resendWebhookHandler(svixReq(bounceBody) as any, res as any);
    expect(res.code).toBe(503);
  });
});

describe("client truth states", () => {
  const btFor = (bid: string) =>
    signBooking("link-secret", { bid, email: "client@example.com", name: "Casey Client" }).token;

  it("payment_failed shows payment_issue; a bounced report shows delivery_failed", async () => {
    store[0].metadata["gh_state"] = "payment_failed";
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler({ method: "GET", headers: {}, query: { bt: btFor("bid-due") } } as any, res as any);
    expect(res.body["state"]).toBe("payment_issue");

    store[0].metadata["gh_state"] = "card_ready";
    store[0].metadata["gh_report_bounced"] = "1";
    delete store[0].metadata["gh_report_sent_at"];
    const res2 = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler({ method: "GET", headers: {}, query: { bt: btFor("bid-due") } } as any, res2 as any);
    expect(res2.body["state"]).toBe("not_ready");
    expect(res2.body["delivery_failed"]).toBe(true);
  });
});
