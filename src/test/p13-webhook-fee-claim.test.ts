// @vitest-environment node
// P13: fee-path dedup is check-then-act (race) — a double webhook
// delivery journals the fee twice. The fee mirror must claim the row
// atomically (conditional transition to fee_paid) BEFORE journaling,
// so exactly one of two CONCURRENT deliveries for the same intent
// journals cancellation_fee_paid. Sequential redelivery is already
// covered by RA10 (the gh_fee_last_payment marker); this test forces
// both deliveries past the marker check with a barrier.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import handler from "../../api/stripe-webhook";

const BID = "bid-p13";
const VISIT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const WHSEC = "whsec_test_p13";

let storeMeta: Record<string, string>;
let row: Record<string, unknown>;
let events: Array<{ event: string; detail: Record<string, unknown> | null }>;
let resendBodies: string[];
let barrierResolve: (() => void) | null;
let barrier: Promise<void>;
let arrived: number;

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
  return {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
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

function matchRow(r: Record<string, unknown>, match: string): boolean {
  const parts = match.split("&").filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("or=(") && part.endsWith(")")) {
      const inner = part.slice(4, -1).split(",");
      const ok = inner.some((c) => {
        const [f, op, ...rest] = c.split(".");
        const v = rest.join(".");
        if (op === "is" && v === "null") return r[f] == null;
        if (op === "eq") return String(r[f] ?? "") === decodeURIComponent(v);
        return false;
      });
      if (!ok) return false;
      continue;
    }
    const [field, op, ...rest] = part.split(".");
    const value = decodeURIComponent(rest.join("."));
    if (field === "order" || field === "limit" || field === "offset") continue;
    if (op === "eq" && String(r[field] ?? "") !== value) return false;
    if (op === "neq" && String(r[field] ?? "") === value) return false;
    if (op === "is" && value === "null" && r[field] != null) return false;
  }
  return true;
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
    gh_booking_id: BID, gh_state: "cancelled",
    gh_report_amount_cents: "20000", gh_first_price_cents: "20000",
    gh_payment_method: "pm_1",
  };
  row = { id: VISIT_ID, booking_id: BID, status: "cancelled", payment_intent_id: null, receipt_email_id: null };
  events = [];
  resendBodies = [];
  arrived = 0;
  barrier = new Promise<void>((r) => { barrierResolve = r; });
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
        // Atomic-claim semantics: the patch applies only when the
        // match filter holds against the CURRENT row. Use the raw
        // query string — searchParams.toString() re-encodes the
        // or=(...) group and would break the filter parse.
        const q = u.search.slice(1);
        const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (matchRow(row, q)) {
          Object.assign(row, patch);
          return okRes([row]);
        }
        return okRes([]);
      }
      // Barrier: park the first two verification reads together so
      // both deliveries have passed the marker check before either
      // reaches the claim.
      arrived++;
      if (arrived === 2 && barrierResolve) barrierResolve();
      await barrier;
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

describe("P13: concurrent double webhook delivery journals the fee once", () => {
  it("two simultaneous deliveries for the same fee intent produce one journal event and one receipt", async () => {
    const r1 = response();
    const r2 = response();
    const [a, b] = await Promise.all([
      handler(signedReq(feeEvent("evt_fee_1")) as never, r1 as never),
      handler(signedReq(feeEvent("evt_fee_2")) as never, r2 as never),
    ]);
    expect(r1.code).toBe(200);
    expect(r2.code).toBe(200);
    expect(events.filter((e) => e.event === "cancellation_fee_paid")).toHaveLength(1);
    expect(events[0].detail?.["payment_intent"]).toBe("pi_fee_1");
    expect(events[0].detail?.["amount_cents"]).toBe(2500);
    expect(resendBodies).toHaveLength(1);
    expect(row["fee_status"]).toBe("fee_paid");
    expect(row["fee_intent_id"]).toBe("pi_fee_1");
    // The cleaning itself is untouched by the fee.
    expect(row["status"]).toBe("cancelled");
    expect(row["payment_intent_id"]).toBeNull();
  });
});
