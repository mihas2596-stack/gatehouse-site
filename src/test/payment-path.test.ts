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

let dbRows: Record<string, unknown>[];
let dbEvents: Record<string, unknown>[];
function matchCond(row: Record<string, unknown>, field: string, op: string, val: string): boolean {
  const v = row[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  if (op === "lt") return String(v ?? "") < dec;
  if (op === "lte") return String(v ?? "") <= dec;
  if (op === "gt") return String(v ?? "") > dec;
  if (op === "gte") return String(v ?? "") >= dec;
  if (op === "in") return dec.replace(/^\(|\)$/g, "").split(",").includes(String(v ?? ""));
  return false;
}
function applyDbFilters(list: Record<string, unknown>[], u: URL): Record<string, unknown>[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (k === "or") {
      const inner = v.replace(/^\(|\)$/g, "");
      const conds = inner.split(",");
      out = out.filter((r) => conds.some((c) => {
        const dot = c.indexOf(".");
        const rest = c.slice(dot + 1);
        const dot2 = rest.indexOf(".");
        return dot > 0 && dot2 > 0 ? matchCond(r, c.slice(0, dot), rest.slice(0, dot2), rest.slice(dot2 + 1)) : false;
      }));
      continue;
    }
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => {
      const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
      return dir === "desc" ? -cmp : cmp;
    });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}
function dueRow(sentAt: string): Record<string, unknown> {
  return {
    id: "row-due", booking_id: "bid-due", visit_no: 1, status: "report_sent",
    report_status: "sent", amount_cents: 18900, client_email: "client@example.com",
    report_sent_at: sentAt, issue_open: false, issue_ever: false,
    report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    visit_date: "2027-01-15", window: "midday", cleaner_name: null,
  };
}
function dueEvents(sentAt: string): Record<string, unknown>[] {
  return [
    { visit_id: "row-due", booking_id: "bid-due", event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    { visit_id: "row-due", booking_id: "bid-due", event: "reminder_sent", detail: {}, created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() },
  ];
}
function enableDb() {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
}

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
  dbRows = []; dbEvents = [];
  piCalls = [];
  intents = [];
  piBehavior = "succeeded";
  resendCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; headers?: Record<string, string>; method?: string }) => {
    const u = new URL(String(url));
    const sbRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : [];
      if (method === "GET") return sbRes(applyDbFilters(list, u));
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, created_at: new Date().toISOString() };
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
    enableDb();
    const sentAt = BASE_META["gh_report_sent_at"]!;
    dbRows = [dueRow(sentAt)]; dbEvents = dueEvents(sentAt);
    store[0].metadata["gh_reminded_at"] = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
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

  it("N04: issue opened and resolved between the timer read and the claim blocks the timer forever", async () => {
    enableDb();
    const sentAt = BASE_META["gh_report_sent_at"]!;
    dbRows = [dueRow(sentAt)]; dbEvents = dueEvents(sentAt);
    store[0].metadata["gh_reminded_at"] = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    // Park the timer's atomic claim (report_sent -> payment_pending)
    // and open + resolve a dispute while it waits: the CAS must see
    // issue_ever=true and admit nothing, even though the earlier read
    // saw a clean row.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let parked = false;
    const origFetch = fetch as unknown as (url: string, init?: Record<string, unknown>) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.hostname.includes("supabase") && method === "PATCH" && u.pathname.endsWith("/gh_visits")) {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>; } catch { /* ignore */ }
        if (body["status"] === "payment_pending" && !parked) {
          parked = true;
          await gate;
        }
      }
      return origFetch(url, init as never) as never;
    }));
    const res = response();
    const runP = autoChargeHandler(cronReq() as never, res as never);
    for (let i = 0; i < 200 && !parked; i++) await new Promise((r) => setTimeout(r, 5));
    expect(parked).toBe(true);
    dbRows[0]["issue_ever"] = true;
    dbRows[0]["issue_open"] = false;
    dbEvents.push({ visit_id: "row-due", booking_id: "bid-due", event: "issue_opened", detail: { room: "Kitchen" }, created_at: new Date().toISOString() });
    dbEvents.push({ visit_id: "row-due", booking_id: "bid-due", event: "issue_resolved", detail: { via: "client_resolve_and_pay" }, created_at: new Date().toISOString() });
    release();
    await runP;
    expect(res.code).toBe(200);
    expect(res.body["charged"]).toBe(0);
    expect(piCalls).toHaveLength(0);
    expect(dbRows[0]["status"]).toBe("report_sent");
    // The timer never returns for this visit, even on a later run.
    const res2 = response();
    await autoChargeHandler(cronReq() as never, res2 as never);
    expect(res2.body["charged"]).toBe(0);
    expect(piCalls).toHaveLength(0);
  });

  it("requires the cron secret", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await autoChargeHandler({ method: "GET", headers: {} } as any, res as any);
    expect(res.code).toBe(401);
    expect(piCalls).toHaveLength(0);
  });

  it("a declined timer charge lands in payment_failed, not a retry loop", async () => {
    enableDb();
    const sentAt = BASE_META["gh_report_sent_at"]!;
    dbRows = [dueRow(sentAt)]; dbEvents = dueEvents(sentAt);
    store[0].metadata["gh_reminded_at"] = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
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
    enableDb();
    const sentAt = BASE_META["gh_report_sent_at"]!;
    dbRows = [dueRow(sentAt)]; dbEvents = dueEvents(sentAt);
    store[0].metadata["gh_state"] = "approved";
    const bad = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "charge", booking_id: "bid-due", amount_cents: 13200 }) as any, bad as any);
    expect(bad.code).toBe(409);
    // Row-backed charge: a non-pinned amount is refused as a price
    // review (409, pinned_cents named), never charged at that price.
    expect(bad.body["error"]).toBe("price_review_required");
    expect(bad.body["pinned_cents"]).toBe(18900);
    expect(piCalls).toHaveLength(0);
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
