// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import reportHandler from "../../api/report";
import webhookHandler from "../../api/stripe-webhook";
import { signBooking } from "../../api/create-checkout-session";

// Webhook vs synchronous write: Stripe's payment_intent.succeeded
// webhook racing the Approve path's own paid write must converge —
// one paid row, one payment_succeeded event, one receipt — whichever
// writer lands first. The webhook dedupes on (paid, same intent) and
// the sync write adopts a paid row instead of writing twice.

const BID = "bid-race-wh";
const EMAIL = "client@example.com";
const ROW_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WHSEC = "whsec_test_race_wh";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;

let rows: Row[];
let evts: Evt[];
let custMeta: Record<string, string>;
let piCalls: Array<{ id: string; amount: string }>;
let resendSubjects: string[];
let evSeq: number;
let blockPaidPatch: Promise<void> | null;
let paidPatchReached: boolean;
let paidPatchParkedOnce: boolean;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
    if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
  }
  if (u.searchParams.get("order")?.startsWith("created_at.desc")) {
    out.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

function parseForm(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body && typeof body === "object") return new URLSearchParams(body as Record<string, string>);
  return new URLSearchParams();
}

async function fetchMock(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  const u = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  const host = u.hostname;

  if (host === "api.stripe.com") {
    if (u.pathname.includes("/customers/search")) {
      const q = u.searchParams.get("query") ?? "";
      const bidM = q.match(/gh_booking_id'\]:'([^']+)'/);
      if (bidM && bidM[1] !== BID) return res(200, { data: [] });
      return res(200, { data: [{ id: "cus_wh_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } }] });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      if (custM[2]) return res(200, { data: [{ id: "pm_wh_1", type: "card" }] });
      if (method === "GET") return res(200, { id: "cus_wh_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } });
      const params = parseForm(init?.body);
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) custMeta[mm[1]] = v;
      }
      return res(200, { id: "cus_wh_1", metadata: { ...custMeta } });
    }
    if (u.pathname === "/v1/payment_intents/search") return res(200, { data: [] });
    const piGetM = u.pathname.match(/^\/v1\/payment_intents\/(pi_[^/]+)$/);
    if (piGetM && method === "GET") {
      const pi = piCalls.find((p) => p.id === piGetM[1]);
      if (!pi) return res(404, { error: { message: "not found" } });
      return res(200, { id: pi.id, status: "succeeded", amount: Number(pi.amount), currency: "usd", customer: "cus_wh_1", metadata: { gh_booking_id: BID, gh_report_version: "1" } });
    }
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      const params = parseForm(init?.body);
      const id = `pi_wh_${piCalls.length + 1}`;
      piCalls.push({ id, amount: params.get("amount") ?? "" });
      return res(200, { id, status: "succeeded" });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    resendSubjects.push(String(body.subject ?? ""));
    return res(200, { id: `email_${resendSubjects.length}` });
  }

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") return res(200, applyFilters(rows, u));
      if (table === "gh_events") return res(200, applyFilters(evts, u));
      if (table === "gh_photos") return res(200, []);
      return res(200, []);
    }
    if (method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (table === "gh_events") {
        evSeq += 1;
        evts.push({ ...body, created_at: new Date(Date.now() + evSeq).toISOString() });
        return res(201, {});
      }
      return res(201, {});
    }
    if (method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.status === "paid" && blockPaidPatch && !paidPatchParkedOnce) {
        paidPatchParkedOnce = true;
        paidPatchReached = true;
        await blockPaidPatch;
      }
      const matched = applyFilters(rows, u);
      for (const target of matched) Object.assign(target, body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const prefer = headers["Prefer"] ?? headers["prefer"] ?? "";
      return res(200, prefer.includes("return=representation") ? matched : {});
    }
  }
  return res(404, { error: { message: "route not stubbed" } });
}

function response() {
  const r = {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  return r;
}

function sentWorld() {
  const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
  rows = [{
    id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
    status: "report_sent", report_status: "sent", amount_cents: 20000,
    visit_date: "2027-01-15", window: "midday",
    issue_open: false, issue_ever: false, report_bounced: false,
    report_sent_at: sentAt, receipt_email_id: null, payment_intent_id: null,
  }];
  custMeta = {
    gh_booking_id: BID, gh_state: "report_sent", gh_payment_method: "pm_wh_1",
    gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
    gh_report_version: "1", gh_report_amount_cents: "20000",
  };
  evts = [
    { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
  ];
  return sentAt;
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

function succeededEvent(id: string, piId: string) {
  return {
    id, type: "payment_intent.succeeded",
    data: { object: { id: piId, customer: "cus_wh_1", amount: 20000, metadata: { gh_booking_id: BID } } },
  };
}

async function waitFor(flag: () => boolean, label: string) {
  for (let i = 0; i < 200 && !flag(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(flag()).toBe(true);
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = []; evts = []; custMeta = {}; piCalls = []; resendSubjects = []; evSeq = 0;
  blockPaidPatch = null; paidPatchReached = false; paidPatchParkedOnce = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("webhook vs synchronous paid write", () => {
  it("webhook lands mid-write: one paid row, one event, one receipt", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    let release!: () => void;
    blockPaidPatch = new Promise<void>((r) => { release = r; });
    const approveP = (async () => {
      const r = response();
      await reportHandler({ method: "POST", headers: {}, body: { bt, action: "approve", seen_publication_id: sentAt } }, r as never);
      return r;
    })();
    await waitFor(() => paidPatchReached, "sync write parked");
    // The PI already succeeded at Stripe; its webhook arrives while
    // the sync write is parked.
    const wh = response();
    await webhookHandler(signedReq(succeededEvent("evt_wh_1", "pi_wh_1")), wh as never);
    expect(wh.code).toBe(200);
    release();
    const approve = await approveP;
    expect(approve.code).toBe(200);
    expect(rows[0]["status"]).toBe("paid");
    expect(rows[0]["payment_intent_id"]).toBe("pi_wh_1");
    expect(piCalls).toHaveLength(1);
    expect(evts.filter((e) => e.event === "payment_succeeded")).toHaveLength(1);
    expect(resendSubjects.filter((s) => s.startsWith("Your Gatehouse receipt"))).toHaveLength(1);
  });

  it("webhook redelivery after a completed sync write changes nothing twice", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const r = response();
    await reportHandler({ method: "POST", headers: {}, body: { bt, action: "approve", seen_publication_id: sentAt } }, r as never);
    expect(r.code).toBe(200);
    expect(rows[0]["status"]).toBe("paid");
    const wh = response();
    await webhookHandler(signedReq(succeededEvent("evt_wh_2", "pi_wh_1")), wh as never);
    expect(wh.code).toBe(200);
    expect(evts.filter((e) => e.event === "payment_succeeded")).toHaveLength(1);
    expect(resendSubjects.filter((s) => s.startsWith("Your Gatehouse receipt"))).toHaveLength(1);
    expect(rows[0]["payment_intent_id"]).toBe("pi_wh_1");
  });
});
