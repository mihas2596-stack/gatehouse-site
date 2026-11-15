// @vitest-environment node
// MA-04 / MA-05 (DA-09): a post-payment complaint must
//   (a) set the visit row's issue_open / issue_ever flags — the owner
//       queue, the charge gates and both photo-retention filters read
//       the row flags, not the Stripe flag or the journal alone;
//   (b) appear in the owner list with the client's words (the queue's
//       issue detail comes from postpay_issue when no issue_opened
//       event exists);
//   (c) accept a follow-up instead of silently dropping the second
//       complaint as already:true — journaled + emailed like the
//       pre-payment follow-up branch.
// What must NOT change: gh_issue_open stays unset in Stripe metadata
// (the visit is paid — nothing is "paused"), and gh_state stays paid.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import ownerHandler from "../../api/owner";
import { signBooking } from "../../api/create-checkout-session";

const BID = "bid-ma04-postpay";
const ROW_ID = "11111111-2222-3333-4444-555555555555";
const CUSTOMER = {
  id: "cus_ma04",
  email: "client@example.com",
  name: "Casey Client",
  metadata: {
    gh_booking_id: BID,
    gh_state: "paid",
    gh_payment_method: "pm_test_1",
    gh_first_price_cents: "18900",
  },
};
const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
const visitDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString("base64");

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

type Row = Record<string, unknown>;
type Ev = { visit_id: string; booking_id?: string; event: string; detail: Record<string, unknown> | null; created_at: string };

let currentMeta: Record<string, string>;
let resendCalls: unknown[];
let bt: string;
let dbRows: Row[];
let dbEvents: Ev[];
let dbPhotos: Row[];
let failPatch = false;
let failEventPost = false;

function matchCond(row: Row, field: string, op: string, val: string): boolean {
  const v = row[field];
  const dec = decodeURIComponent(val);
  if (op === "eq") return String(v ?? "") === dec;
  if (op === "neq") return v !== null && v !== undefined && String(v) !== dec;
  if (op === "is") return dec === "null" ? v === null || v === undefined : v !== null && v !== undefined;
  if (op === "lt") return String(v ?? "") < dec;
  if (op === "in") return dec.replace(/^\(|\)$/g, "").split(",").includes(String(v ?? ""));
  return false;
}
function applyDbFilters(list: Row[], u: URL): Row[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    const dot = v.indexOf(".");
    if (dot <= 0) continue;
    out = out.filter((r) => matchCond(r, k, v.slice(0, dot), v.slice(dot + 1)));
  }
  const order = u.searchParams.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    out.sort((a, b) => { const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? "")); return dir === "desc" ? -cmp : cmp; });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}

function makeRow(overrides: Row = {}): Row {
  return {
    id: ROW_ID, booking_id: BID, visit_no: 1, status: "paid",
    report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
    report_sent_at: sentAt, visit_date: visitDate,
    issue_open: false, issue_ever: false,
    report_bounced: false, payment_intent_id: "pi_test_1", receipt_email_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  currentMeta = { ...CUSTOMER.metadata, gh_report_sent_at: sentAt };
  resendCalls = [];
  dbRows = [makeRow()];
  dbEvents = [
    { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
  ];
  dbPhotos = [];
  failPatch = false;
  failEventPost = false;
  bt = signBooking("link-secret", { bid: BID, email: CUSTOMER.email, name: CUSTOMER.name }).token;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; method?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    // Signed-upload flow for a client photo (storagePut).
    if (u.includes("/object/upload/sign/")) {
      if (method === "POST") return { ok: true, status: 200, json: async () => ({ url: "/object/upload/sign/x" }), text: async () => "{}" };
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    }
    if (u.includes("supabase")) {
      const uu = new URL(u);
      const table = uu.pathname.split("/").pop() ?? "";
      const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : table === "gh_photos" ? dbPhotos : [];
      const sbRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
      if (method === "GET") return sbRes(applyDbFilters(list, uu));
      if (method === "POST") {
        if (failEventPost && table === "gh_events") return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, created_at: new Date().toISOString() };
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        if (failPatch) return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = applyDbFilters(list, uu);
        for (const target of matched) Object.assign(target, body);
        return sbRes(matched);
      }
      return sbRes([]);
    }
    if (u.includes("/customers/search")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: CUSTOMER.id, email: CUSTOMER.email, name: CUSTOMER.name, metadata: currentMeta }] }) };
    }
    if (u.includes("api.resend.com")) {
      resendCalls.push(init?.body);
      return { ok: true, status: 200, json: async () => ({ id: "email-1" }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`) && init?.body) {
      const params = new URLSearchParams(String(init.body));
      for (const [k, v] of params.entries()) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m) currentMeta[m[1]] = v;
      }
      return { ok: true, status: 200, json: async () => ({ id: CUSTOMER.id }) };
    }
    if (u.endsWith(`/customers/${CUSTOMER.id}`)) {
      return { ok: true, status: 200, json: async () => ({ ...CUSTOMER, metadata: currentMeta }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const postIssue = async (body: Record<string, unknown>) => {
  const res = response();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await reportHandler({ method: "POST", headers: {}, body: { bt, action: "issue", ...body } } as any, res as any);
  return res;
};

describe("MA-04/MA-05: post-payment complaint sets the row flags", () => {
  it("first complaint sets issue_open + issue_ever, keeps paid state and no gh_issue_open", async () => {
    const issue = await postIssue({ reason: "found a streak", room: "Kitchen" });
    expect(issue.code).toBe(200);
    expect(issue.body["postpay"]).toBe(true);
    expect(dbRows[0]["issue_open"]).toBe(true);
    expect(dbRows[0]["issue_ever"]).toBe(true);
    expect(currentMeta["gh_state"]).toBe("paid");
    expect(currentMeta["gh_issue_open"]).not.toBe("1");
    expect(currentMeta["gh_postpay_issue"]).toBe("1");
    expect(dbEvents.some((e) => e.event === "postpay_issue")).toBe(true);
    // Owner email went out; the complaint is visible in triage now.
    expect(resendCalls).toHaveLength(1);
    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler({ method: "GET", headers: {}, query: { bt } } as any, view as any);
    expect(view.body["postpay_issue"]).toBe(true);
    expect(view.body["state"]).toBe("paid");
    expect(view.body["charge_timer_blocked"]).toBe(true);
  });

  it("a failed flag write is a 502, never a silent 200", async () => {
    failPatch = true;
    const issue = await postIssue({ reason: "found a streak", room: "Kitchen" });
    expect(issue.code).toBe(502);
    expect(issue.body["error"]).toBe("db_error");
    // The journal event and Stripe flag were already written — the
    // retry converges through the follow-up branch (next test).
    expect(dbEvents.some((e) => e.event === "postpay_issue")).toBe(true);
    expect(currentMeta["gh_postpay_issue"]).toBe("1");
    expect(resendCalls).toHaveLength(0);
  });

  it("a retry after a failed flag write converges via the follow-up branch", async () => {
    failPatch = true;
    const first = await postIssue({ reason: "found a streak", room: "Kitchen" });
    expect(first.code).toBe(502);
    failPatch = false;
    const retry = await postIssue({ reason: "found a streak", room: "Kitchen" });
    expect(retry.code).toBe(200);
    expect(retry.body["already"]).toBe(true);
    expect(retry.body["followup_recorded"]).toBe(true);
    expect(dbRows[0]["issue_open"]).toBe(true);
    expect(dbRows[0]["issue_ever"]).toBe(true);
  });

  it("a photo is stored with kind client (retention-protected by the flags)", async () => {
    const issue = await postIssue({ reason: "found a crack", room: "Kitchen", photo: JPEG_B64 });
    expect(issue.code).toBe(200);
    expect(dbPhotos).toHaveLength(1);
    expect(dbPhotos[0]["kind"]).toBe("client");
    expect(dbPhotos[0]["visit_id"]).toBe(ROW_ID);
    expect(dbEvents.some((e) => e.event === "client_photo_stored")).toBe(true);
  });
});

describe("MA-04: second complaint is a follow-up, not a silent drop", () => {
  it("second complaint journals issue_followup and emails owner + client", async () => {
    const first = await postIssue({ reason: "found a streak", room: "Kitchen" });
    expect(first.code).toBe(200);
    expect(resendCalls).toHaveLength(1);
    const second = await postIssue({ reason: "and the oven is still dirty", room: "Kitchen" });
    expect(second.code).toBe(200);
    expect(second.body["already"]).toBe(true);
    expect(second.body["followup_recorded"]).toBe(true);
    const followup = dbEvents.find((e) => e.event === "issue_followup");
    expect(followup?.detail?.["reason"]).toBe("and the oven is still dirty");
    // Owner follow-up + client confirmation on top of the first email.
    expect(resendCalls).toHaveLength(3);
    expect(dbRows[0]["issue_open"]).toBe(true);
  });

  it("a follow-up whose journal write fails records nothing and sends no email", async () => {
    const first = await postIssue({ reason: "found a streak", room: "Kitchen" });
    expect(first.code).toBe(200);
    expect(resendCalls).toHaveLength(1);
    failEventPost = true;
    const second = await postIssue({ reason: "and the oven is still dirty", room: "Kitchen" });
    expect(second.code).toBe(200);
    expect(second.body["already"]).toBe(true);
    expect(second.body["followup_recorded"]).toBeUndefined();
    expect(dbEvents.some((e) => e.event === "issue_followup")).toBe(false);
    expect(resendCalls).toHaveLength(1);
  });

  it("an empty second complaint stays a plain already:true (pre-payment parity)", async () => {
    const first = await postIssue({ reason: "found a streak", room: "Kitchen" });
    expect(first.code).toBe(200);
    const second = await postIssue({ reason: "   ", room: "" });
    expect(second.code).toBe(200);
    expect(second.body["already"]).toBe(true);
    expect(second.body["followup_recorded"]).toBeUndefined();
    expect(resendCalls).toHaveLength(1);
  });
});

describe("MA-04: owner list shows the post-payment complaint", () => {
  const V1 = "22222222-3333-4444-5555-666666666666";
  const V2 = "33333333-4444-5555-6666-777777777777";
  const ADMIN = ["adm", "secret"].join("-");
  let ownerRows: Row[];
  let ownerEvents: Ev[];

  const ownerList = async () => {
    const r = response();
    await ownerHandler(
      { method: "GET", headers: { authorization: `Bearer ${ADMIN}` }, query: { view: "list" } } as never,
      r as never,
    );
    return r;
  };

  beforeEach(() => {
    ownerRows = [
      makeRow({ id: V1, booking_id: "bid-ma04-v1", status: "paid", issue_open: true, issue_ever: true }),
      makeRow({ id: V2, booking_id: "bid-ma04-v2", status: "report_sent", issue_open: true, issue_ever: true }),
    ];
    ownerEvents = [
      { visit_id: V1, event: "postpay_issue", detail: { reason: "found a streak", room: "Kitchen" }, created_at: sentAt },
      { visit_id: V2, event: "issue_opened", detail: { reason: "missed oven", room: "Oven" }, created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString() },
      { visit_id: V2, event: "postpay_issue", detail: { reason: "later words", room: "Kitchen" }, created_at: new Date(Date.now() - 1 * 3600 * 1000).toISOString() },
    ];
    // Owner-list reads reuse the same fetch mock, pointed at the
    // owner fixtures instead of the report fixtures.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(String(url));
      const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
      if (u.pathname.includes("/rest/v1/gh_visits")) return okRes(applyDbFilters(ownerRows, u));
      if (u.pathname.includes("/rest/v1/gh_photos")) return okRes([]);
      if (u.pathname.includes("/rest/v1/gh_events")) return okRes(applyDbFilters(ownerEvents, u));
      if (u.pathname.includes("/rest/v1/gh_visit_access")) return okRes([]);
      return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    }));
  });

  it("postpay_issue supplies the queue's reason/room/opened_at; issue_opened still wins", async () => {
    const r = await ownerList();
    expect(r.code).toBe(200);
    const visits = r.body["visits"] as Row[];
    expect(visits).toHaveLength(2);
    const byId = new Map(visits.map((v) => [v["id"], v]));
    const v1 = byId.get(V1);
    expect(v1?.["issue_open"]).toBe(true);
    expect(v1?.["issue_reason"]).toBe("found a streak");
    expect(v1?.["issue_room"]).toBe("Kitchen");
    expect(v1?.["issue_opened_at"]).toBe(sentAt);
    const v2 = byId.get(V2);
    expect(v2?.["issue_reason"]).toBe("missed oven");
    expect(v2?.["issue_room"]).toBe("Oven");
  });
});
