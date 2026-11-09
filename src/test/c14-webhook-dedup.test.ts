// @vitest-environment node
// C14 (09.11.2026): persistent webhook dedup. A redelivered Stripe
// payment_intent.payment_failed must write exactly one payment_failed
// journal row, and a redelivered Resend bounce must flip
// report_bounced exactly once — even when the redelivery arrives on
// a different instance (simulated here by a pre-seeded
// gh_webhook_events row with an empty in-memory set). A delivery the
// handler failed (5xx) is NOT recorded, so the provider retry still
// processes it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import stripeHandler from "../../api/stripe-webhook";
import resendHandler from "../../api/resend-webhook";

const BID = "bid-c14";
const VISIT_ID = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
const WHSEC = "whsec_test_c14";
const RESEND_SECRET = `whsec_${Buffer.from("resend-test-secret-0123456789").toString("base64")}`;

type Row = Record<string, unknown>;

let storeMeta: Record<string, string>;
let visitRow: Row;
let events: Array<{ event: string; detail: Record<string, unknown> | null; visit_id?: string }>;
let dedupRows: Array<{ source: string; event_id: string; event_type: string | null }>;
let visitsFail: boolean;

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

function okRes(data: unknown, status = 200) {
  return {
    ok: status < 300, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  };
}

function applyEq(list: Row[], u: URL): Row[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.hostname === "api.stripe.com") {
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return okRes({ id: "cus_c14" });
        }
        return okRes({ id: "cus_c14", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_c14" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (visitsFail) return okRes({ message: "db down" }, 500);
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        const matched = applyEq([visitRow], u);
        for (const r of matched) Object.assign(r, patch);
        const prefer = String((init as { headers?: Record<string, string> })?.headers?.["Prefer"] ?? "");
        return okRes(prefer.includes("return=representation") ? matched : {});
      }
      return okRes(applyEq([visitRow], u));
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; detail?: Record<string, unknown> | null; visit_id?: string };
        events.push({ event: body.event ?? "", detail: body.detail ?? null, visit_id: body.visit_id });
        return okRes([{ id: events.length }]);
      }
      return okRes(applyEq(events as Row[], u));
    }
    if (u.pathname.includes("/rest/v1/gh_webhook_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { source: string; event_id: string; event_type: string | null };
        if (dedupRows.some((r) => r.source === body.source && r.event_id === body.event_id)) {
          return okRes({ message: "duplicate key" }, 409);
        }
        dedupRows.push({ source: body.source, event_id: body.event_id, event_type: body.event_type });
        return okRes([body]);
      }
      return okRes(applyEq(dedupRows as Row[], u));
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  }));
}

function stripeSignedReq(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  return {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}` },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  };
}

function resendSignedReq(event: Record<string, unknown>, msgId: string) {
  const payload = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(RESEND_SECRET.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${msgId}.${ts}.${payload}`).digest("base64");
  return {
    method: "POST",
    headers: {
      "svix-id": msgId,
      "svix-timestamp": ts,
      "svix-signature": `v1,${sig}`,
    },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  };
}

const failedEvent = (id: string) => ({
  id,
  type: "payment_intent.payment_failed",
  data: {
    object: {
      id: "pi_fail_c14",
      customer: "cus_c14",
      amount: 20000,
      metadata: { gh_booking_id: BID },
    },
  },
});

const bounceEvent = () => ({
  type: "email.bounced",
  data: { email_id: "email_rep_c14", tags: { gh_report: "1" } },
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("RESEND_WEBHOOK_SECRET", RESEND_SECRET);
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent",
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
  };
  visitRow = {
    id: VISIT_ID, booking_id: BID, status: "report_sent",
    report_status: "sent", report_bounced: false,
    amount_cents: 20000, payment_intent_id: null,
    report_email_id: "email_rep_c14",
  };
  events = [];
  dedupRows = [];
  visitsFail = false;
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("C14 persistent webhook dedup", () => {
  it("stripe: the same payment_failed event delivered twice journals once", async () => {
    const r1 = response();
    await stripeHandler(stripeSignedReq(failedEvent("evt_c14_a")) as never, r1 as never);
    expect(r1.code).toBe(200);
    const r2 = response();
    await stripeHandler(stripeSignedReq(failedEvent("evt_c14_a")) as never, r2 as never);
    expect(r2.code).toBe(200);
    expect(r2.body["deduped"]).toBe(true);
    expect(events.filter((e) => e.event === "payment_failed")).toHaveLength(1);
    expect(dedupRows.filter((r) => r.source === "stripe" && r.event_id === "evt_c14_a")).toHaveLength(1);
  });

  it("stripe: a pre-seeded dedup row (another instance) dedupes the first delivery here", async () => {
    dedupRows.push({ source: "stripe", event_id: "evt_c14_b", event_type: "payment_intent.payment_failed" });
    const r = response();
    await stripeHandler(stripeSignedReq(failedEvent("evt_c14_b")) as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["deduped"]).toBe(true);
    expect(events.filter((e) => e.event === "payment_failed")).toHaveLength(0);
  });

  it("stripe: a failed (5xx) delivery is not recorded, so the retry still processes", async () => {
    visitsFail = true;
    const r1 = response();
    await stripeHandler(stripeSignedReq(failedEvent("evt_c14_c")) as never, r1 as never);
    expect(r1.code).toBe(500);
    expect(dedupRows).toHaveLength(0);
    visitsFail = false;
    const r2 = response();
    await stripeHandler(stripeSignedReq(failedEvent("evt_c14_c")) as never, r2 as never);
    expect(r2.code).toBe(200);
    expect(r2.body["deduped"]).toBeUndefined();
    expect(events.filter((e) => e.event === "payment_failed")).toHaveLength(1);
  });

  it("resend: the same bounce delivered twice flips report_bounced once", async () => {
    const r1 = response();
    await resendHandler(resendSignedReq(bounceEvent(), "msg_c14_a") as never, r1 as never);
    expect(r1.code).toBe(200);
    expect(visitRow["report_bounced"]).toBe(true);
    const r2 = response();
    await resendHandler(resendSignedReq(bounceEvent(), "msg_c14_a") as never, r2 as never);
    expect(r2.code).toBe(200);
    expect(r2.body["deduped"]).toBe(true);
    expect(events.filter((e) => e.event === "report_bounced")).toHaveLength(1);
    expect(dedupRows.filter((r) => r.source === "resend" && r.event_id === "msg_c14_a")).toHaveLength(1);
  });

  it("resend: a pre-seeded dedup row (another instance) dedupes the first delivery here", async () => {
    dedupRows.push({ source: "resend", event_id: "msg_c14_b", event_type: "email.bounced" });
    const r = response();
    await resendHandler(resendSignedReq(bounceEvent(), "msg_c14_b") as never, r as never);
    expect(r.code).toBe(200);
    expect(r.body["deduped"]).toBe(true);
    expect(events.filter((e) => e.event === "report_bounced")).toHaveLength(0);
    expect(visitRow["report_bounced"]).toBe(false);
  });
});
