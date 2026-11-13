// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import adminHandler from "../../api/booking-action";
import reportHandler from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";

// The photo-report portal round trip:
//   operator send_report (booking-action, ADMIN_TOKEN)
//     → photo URLs chunked into Stripe metadata + report email with link
//   client GET /api/report?bt= → photos + 24h deadline
//   client POST approve / issue → state machine moves, charge gates hold.

const BID = "bid-report-1";
const CUSTOMER = {
  id: "cus_report_1",
  email: "client@example.com",
  name: "Casey Client",
  metadata: {
    gh_booking_id: BID,
    gh_state: "card_ready",
    gh_payment_method: "pm_test_1",
    gh_first_price_cents: "18900",
  },
};

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

let currentMeta: Record<string, string>;
let resendCalls: unknown[];
let piCalls: Array<{ body: URLSearchParams; idem: string | undefined }>;
let bt: string;
let dbRows: Record<string, unknown>[];
let dbEvents: Record<string, unknown>[];
let failEventPost = false;
let failPiCreate = false;
let piRequiresAction = false;
// 3DS (H1): the mock Stripe keeps the created intent's live status, so
// a test can flip it to "succeeded" (the cardholder completed the
// challenge in the browser) and the next approve must adopt it instead
// of minting a second intent.
let piStore: Record<string, { id: string; status: string; client_secret?: string; amount: number; currency: string; customer: string; metadata: Record<string, string>; created: number }>;
const piFull = (partial: { id: string; status: string; client_secret?: string }) => ({
  ...partial,
  amount: 18900,
  currency: "usd",
  customer: CUSTOMER.id,
  metadata: { gh_booking_id: BID },
  created: Math.floor(Date.now() / 1000),
});
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
      out = out.filter((r) => inner.split(",").some((c) => {
        const d1 = c.indexOf("."); const rest = c.slice(d1 + 1); const d2 = rest.indexOf(".");
        return d1 > 0 && d2 > 0 ? matchCond(r, c.slice(0, d1), rest.slice(0, d2), rest.slice(d2 + 1)) : false;
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
    out.sort((a, b) => { const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? "")); return dir === "desc" ? -cmp : cmp; });
  }
  const limit = u.searchParams.get("limit");
  if (limit) out = out.slice(0, parseInt(limit, 10));
  return out;
}
function enableDb() {
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  currentMeta = { ...CUSTOMER.metadata };
  resendCalls = [];
  piCalls = [];
  dbRows = []; dbEvents = []; failEventPost = false; failPiCreate = false; piRequiresAction = false; piStore = {};
  bt = signBooking("link-secret", {
    bid: BID, email: CUSTOMER.email, name: CUSTOMER.name,
  }).token;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown; method?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.includes("supabase")) {
      const uu = new URL(u);
      const table = uu.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      const list = table === "gh_visits" ? dbRows : table === "gh_events" ? dbEvents : [];
      const sbRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
      if (method === "GET") return sbRes(applyDbFilters(list, uu));
      if (method === "POST") {
        if (failEventPost) return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, created_at: new Date().toISOString() };
        list.push(inserted);
        return sbRes([inserted]);
      }
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = applyDbFilters(list, uu);
        for (const target of matched) Object.assign(target, body);
        return sbRes(matched);
      }
      if (method === "DELETE") {
        const matched = applyDbFilters(list, uu);
        for (const d of matched) { const i = list.indexOf(d); if (i >= 0) list.splice(i, 1); }
        return sbRes(matched);
      }
      return sbRes([]);
    }
    if (u.includes("/customers/search")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: CUSTOMER.id, metadata: currentMeta }] }) };
    }
    if (u.includes("/payment_intents/search")) {
      // Stripe search returns { data: [...] } — an empty list here
      // means no prior intent for this booking, not a succeeded one.
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (u.includes("/payment_intents")) {
      // H1: simulate the Stripe create call failing with a network
      // error, so the charge outcome is unknown (not failed).
      if (failPiCreate && (init?.method ?? "GET").toUpperCase() === "POST") {
        throw new Error("stripe unreachable");
      }
      const method = (init?.method ?? "GET").toUpperCase();
      // GET /payment_intents/{id} — direct read (reconcile): return the
      // stored live status, so a test can flip a 3DS intent to
      // succeeded and the next approve adopts it.
      const getM = /\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(u);
      if (method === "GET" && getM) {
        const found = piStore[getM[1]];
        if (!found) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
        return { ok: true, status: 200, json: async () => ({ ...found }) };
      }
      // POST /payment_intents/{id}/confirm — re-confirm a live intent:
      // return its stored status (a requires_action intent stays
      // requires_action; the client completes it with Stripe.js).
      if (method === "POST" && u.includes("/confirm")) {
        const cM = /\/payment_intents\/(pi_[A-Za-z0-9_]+)\/confirm/.exec(u);
        const found = cM ? piStore[cM[1]] : undefined;
        if (!found) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
        return { ok: true, status: 200, json: async () => ({ ...found }) };
      }
      if (method === "POST") {
        piCalls.push({ body: new URLSearchParams(String(init?.body)), idem: init?.headers?.["Idempotency-Key"] });
        if (piRequiresAction) {
          piStore["pi_test_1"] = piFull({ id: "pi_test_1", status: "requires_action", client_secret: "pi_test_1_secret_abc" });
          return { ok: true, status: 200, json: async () => ({ ...piStore["pi_test_1"] }) };
        }
        piStore["pi_test_1"] = piFull({ id: "pi_test_1", status: "succeeded" });
        return { ok: true, status: 200, json: async () => ({ id: "pi_test_1", status: "succeeded" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.includes("/payment_methods")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "pm_test_1" }] }) };
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

const ADMIN = ["adm", "secret"].join("-");
const adminReq = (body: Record<string, unknown>) => ({
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN}` },
  body,
});
const getReq = (token: string) => ({ method: "GET", headers: {}, query: { bt: token } });
const postReq = (body: Record<string, unknown>) => ({ method: "POST", headers: {}, body });

const PHOTOS = [
  "https://cdn.example.com/report/kitchen.jpg",
  "https://cdn.example.com/report/bath.jpg",
  "https://cdn.example.com/report/living.jpg",
];

async function sendReport(photos: string[] = PHOTOS) {
  const res = response();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await adminHandler(adminReq({ action: "send_report", booking_id: BID, photos }) as any, res as any);
  return res;
}

// Dates relative to \"today\" in Atlanta time, so the deadline tests
// are stable no matter when the suite runs.
function atlantaToday(nowMs = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(nowMs));
}
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("report portal", () => {
  it("rejects a garbage token and reports not_ready before any report", async () => {
    const bad = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq("v2.garbage") as any, bad as any);
    expect(bad.body["state"]).toBe("invalid_link");

    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, res as any);
    expect(res.code).toBe(200);
    expect(res.body["state"]).toBe("not_ready");
    expect(res.body["photos"]).toEqual([]);
    const booking = res.body["booking"] as Record<string, string>;
    expect(booking.first).toBe("$189");
  });

  it("blocks client approve/issue before the report is sent", async () => {
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve" }) as any, res as any);
    expect(res.code).toBe(409);
    expect(res.body["error"]).toBe("report_not_sent");
  });

  it("send_report stores photos, starts the clock and emails the portal link", async () => {
    const res = await sendReport();
    expect(res.code).toBe(200);
    expect(res.body["state"]).toBe("report_sent");
    expect(res.body["report_version"]).toBe(1);
    expect(res.body["email_sent"]).toBe(true);
    expect(currentMeta["gh_state"]).toBe("report_sent");
    expect(currentMeta["gh_report_sent_at"]).toBeTruthy();
    expect(resendCalls).toHaveLength(1);
    const email = JSON.parse(String(resendCalls[0])) as { subject: string; text: string; to: string[] };
    expect(email.to).toEqual(["client@example.com"]);
    expect(email.subject).toContain("report is ready");
    expect(email.text).toContain("/visit?bt=v2.");
    expect(email.text).toContain("#report");
    expect(email.text).toContain("$189");

    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, view as any);
    expect(view.body["state"]).toBe("awaiting");
    expect(view.body["photos"]).toEqual(PHOTOS);
    const sentMs = Date.parse(String(view.body["report_sent_at"]));
    const deadlineMs = Date.parse(String(view.body["deadline"]));
    expect(Math.abs(deadlineMs - (sentMs + 24 * 3600 * 1000))).toBeLessThan(2000);
  });

  // Extension bug #1: the deadline was sent + 24h even when the report
  // went out BEFORE the visit date, telling the client they would be
  // charged days before the visit. The deadline is max(visit-date
  // start NY, sent + 24h).
  it("deadline is the visit date (not sent + 24h) when the report went out before the visit", async () => {
    await sendReport();
    // Legacy report sent before the visit date (or a reschedule after
    // sending): the confirmed date is 5 days out, so sent + 24h is
    // still before the visit. The deadline must be the visit date.
    const visitDate = shiftDate(atlantaToday(), 5);
    currentMeta["gh_confirmed_date"] = visitDate;
    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, view as any);
    expect(view.body["state"]).toBe("awaiting");
    const sentMs = Date.parse(String(view.body["report_sent_at"]));
    const deadlineMs = Date.parse(String(view.body["deadline"]));
    // The bug: deadline was sent + 24h, days before the visit.
    expect(deadlineMs).toBeGreaterThan(sentMs + 24 * 3600 * 1000);
    // The deadline is midnight NY on the visit date.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(deadlineMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    expect(`${get("year")}-${get("month")}-${get("day")}`).toBe(visitDate);
    expect(Number(get("hour"))).toBe(0);
    expect(Number(get("minute"))).toBe(0);
  });

  it("deadline is sent + 24h when the visit date already passed", async () => {
    await sendReport();
    const visitDate = shiftDate(atlantaToday(), -5);
    currentMeta["gh_confirmed_date"] = visitDate;
    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, view as any);
    const sentMs = Date.parse(String(view.body["report_sent_at"]));
    const deadlineMs = Date.parse(String(view.body["deadline"]));
    expect(Math.abs(deadlineMs - (sentMs + 24 * 3600 * 1000))).toBeLessThan(2000);
  });

  it("send_report is a no-op for the same photos within 10 minutes, a new version after", async () => {
    await sendReport();
    const again = await sendReport();
    expect(again.body["already_sent"]).toBe(true);
    expect(resendCalls).toHaveLength(1);
    expect(currentMeta["gh_report_version"]).toBe("1");
    const updated = await sendReport(["https://cdn.example.com/report/new.jpg"]);
    expect(updated.body["report_version"]).toBe(2);
    expect(resendCalls).toHaveLength(2);
  });

  it("rejects non-https photos", async () => {
    const res = await sendReport(["http://insecure.example.com/x.jpg"]);
    expect(res.code).toBe(400);
    expect(res.body["error"]).toBe("invalid_photo_url");
    expect(currentMeta["gh_state"]).toBe("card_ready");
  });

  it("client issue pauses the charge; approve from issue_open clears it; both idempotent", async () => {
    await sendReport();
    // Row-back the booking AFTER the legacy send: the durable row +
    // journal are what the new approve path charges against.
    enableDb();
    const sentAt = currentMeta["gh_report_sent_at"]!;
    dbRows = [{
      id: "row-report-1", booking_id: BID, visit_no: 1, status: "report_sent",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    }];
    dbEvents = [
      { visit_id: "row-report-1", booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    ];
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "Missed the oven" }) as any, issue as any);
    expect(issue.code).toBe(200);
    expect(issue.body["state"]).toBe("issue_open");
    expect(currentMeta["gh_issue_open"]).toBe("1");
    expect(currentMeta["gh_issue_reason"]).toBe("Missed the oven");
    expect(dbRows[0]["issue_open"]).toBe(true);
    expect(dbRows[0]["issue_ever"]).toBe(true);

    const issueAgain = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "other" }) as any, issueAgain as any);
    expect(issueAgain.body["already"]).toBe(true);
    expect(currentMeta["gh_issue_reason"]).toBe("Missed the oven");

    // Terms 5.2 / N05: the Approve press while an issue is open IS
    // the explicit "Resolve issue & pay" consent — durable journal
    // first, row flag cleared only when verified, then one charge
    // at the pinned amount. issue_ever stays true: the timer never
    // returns for this visit.
    const viewBeforeApprove = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, viewBeforeApprove as any);
    const approve = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: viewBeforeApprove.body["publication_id"] }) as any, approve as any);
    expect(approve.code).toBe(200);
    expect(approve.body["state"]).toBe("paid");
    expect(currentMeta["gh_state"]).toBe("paid");
    expect(currentMeta["gh_issue_open"]).toBe("");
    expect(dbRows[0]["issue_open"]).toBe(false);
    expect(dbRows[0]["issue_ever"]).toBe(true);
    expect(dbEvents.some((e) => e.event === "issue_resolved" && (e.detail as Record<string, unknown>)?.["via"] === "client_resolve_and_pay")).toBe(true);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].body.get("amount")).toBe("18900");

    const approveAgain = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve" }) as any, approveAgain as any);
    expect(approveAgain.code).toBe(409);
    expect(approveAgain.body["error"]).toBe("already_paid");
    expect(piCalls).toHaveLength(1);
  });

  it("C10: a client-filed issue is sourced 'client', an owner-opened dispute is sourced 'operator'", async () => {
    await sendReport();
    enableDb();
    const sentAt = currentMeta["gh_report_sent_at"]!;
    dbRows = [{
      id: "row-report-c10", booking_id: BID, visit_no: 1, status: "report_sent",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    }];
    dbEvents = [
      { visit_id: "row-report-c10", booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    ];
    // Client files the issue from the report page.
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "Missed the oven" }) as any, issue as any);
    expect(issue.code).toBe(200);
    expect(issue.body["state"]).toBe("issue_open");
    expect(issue.body["issue_reason"]).toBe("Missed the oven");
    expect(issue.body["issue_source"]).toBe("client");
    expect(currentMeta["gh_issue_source"]).toBe("client");

    // The same booking, but the dispute was opened by the owner
    // (booking-action dispute): the journal actor is "owner", so the
    // reason must never render as the client's words. The Stripe
    // metadata carries no source here — the journal decides.
    dbRows[0]["issue_open"] = true;
    dbEvents = [
      { visit_id: "row-report-c10", booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
      { visit_id: "row-report-c10", booking_id: BID, event: "issue_opened", actor: "owner", detail: { reason: "Owner cancelled 24.10 - no auto-charge" }, created_at: new Date().toISOString() },
    ];
    currentMeta["gh_issue_open"] = "1";
    currentMeta["gh_issue_reason"] = "Owner cancelled 24.10 - no auto-charge";
    delete currentMeta["gh_issue_source"];
    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, view as any);
    expect(view.body["state"]).toBe("issue_open");
    expect(view.body["issue_reason"]).toBe("Owner cancelled 24.10 - no auto-charge");
    expect(view.body["issue_source"]).toBe("operator");
  });

  it("approve from issue_open fails closed when the durable resolve journal write fails: issue stays open, no intent", async () => {
    await sendReport();
    enableDb();
    const sentAt = currentMeta["gh_report_sent_at"]!;
    dbRows = [{
      id: "row-report-2", booking_id: BID, visit_no: 1, status: "report_sent",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: true, issue_ever: true,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    }];
    dbEvents = [
      { visit_id: "row-report-2", booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
      { visit_id: "row-report-2", booking_id: BID, event: "issue_opened", detail: { reason: "Missed the oven" }, created_at: new Date().toISOString() },
    ];
    currentMeta["gh_issue_open"] = "1";
    currentMeta["gh_issue_reason"] = "Missed the oven";
    failEventPost = true;
    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, view as any);
    const approve = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: view.body["publication_id"] }) as any, approve as any);
    expect(approve.code).toBe(502);
    expect(dbRows[0]["issue_open"]).toBe(true);
    expect(piCalls).toHaveLength(0);
    expect(currentMeta["gh_state"]).not.toBe("paid");
  });

  it("H1: approve with an unknown charge outcome returns payment_unknown, never approved — reload shows the same state, retry pays once", async () => {
    await sendReport();
    enableDb();
    const sentAt = currentMeta["gh_report_sent_at"]!;
    dbRows = [{
      id: "row-report-3", booking_id: BID, visit_no: 1, status: "report_sent",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    }];
    dbEvents = [
      { visit_id: "row-report-3", booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    ];
    const viewBefore = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, viewBefore as any);
    expect(viewBefore.body["state"]).toBe("awaiting");

    failPiCreate = true;
    const approve = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: viewBefore.body["publication_id"] }) as any, approve as any);
    expect(approve.code).toBe(502);
    expect(approve.body["error"]).toBe("payment_unknown");
    expect(approve.body["state"]).toBe("payment_unknown");
    expect(approve.body["state"]).not.toBe("approved");
    // The pre-charge write must not have stamped "approved" anywhere.
    expect(currentMeta["gh_state"]).not.toBe("approved");
    // The claim is held (payment_pending) for recovery; nothing was charged.
    expect(dbRows[0]["status"]).toBe("payment_pending");
    expect(piCalls).toHaveLength(0);

    // Reload: the unknown outcome survives — still payment_unknown,
    // never the "Approved — thank you" screen.
    const reload = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, reload as any);
    expect(reload.body["state"]).toBe("payment_unknown");

    // Retry after Stripe recovers: the held claim reconciles, the
    // visit pays exactly once.
    failPiCreate = false;
    const retry = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: viewBefore.body["publication_id"] }) as any, retry as any);
    expect(retry.code).toBe(200);
    expect(retry.body["state"]).toBe("paid");
    expect(piCalls).toHaveLength(1);
    expect(dbRows[0]["status"]).toBe("paid");
  });

  it("3DS (H1): approve with a card that needs authentication returns 402 with client_secret + publishable_key; after the challenge the re-approve adopts the same intent, no second charge", async () => {
    vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_3ds");
    piRequiresAction = true;
    await sendReport();
    enableDb();
    const sentAt = currentMeta["gh_report_sent_at"]!;
    dbRows = [{
      id: "row-report-3ds", booking_id: BID, visit_no: 1, status: "report_sent",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    }];
    dbEvents = [
      { visit_id: "row-report-3ds", booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    ];
    const viewBefore = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, viewBefore as any);
    expect(viewBefore.body["state"]).toBe("awaiting");

    // First approve: the card needs 3DS. The server must hand the
    // client the PaymentIntent's client_secret and the publishable key
    // — without them the card is unpayable (the server cannot do 3DS).
    const approve = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: viewBefore.body["publication_id"] }) as any, approve as any);
    expect(approve.code).toBe(402);
    expect(approve.body["error"]).toBe("payment_requires_action");
    expect(approve.body["client_secret"]).toBe("pi_test_1_secret_abc");
    expect(approve.body["payment_intent"]).toBe("pi_test_1");
    expect(approve.body["publishable_key"]).toBe("pk_test_3ds");
    expect(piCalls).toHaveLength(1);
    // The claim is released so the client can retry after the challenge.
    expect(dbRows[0]["status"]).toBe("report_sent");
    // The intent is journaled, so a later reconcile can find it.
    expect(dbEvents.some((e) => e.event === "payment_requires_action" && (e.detail as Record<string, unknown>)?.["payment_intent"] === "pi_test_1")).toBe(true);

    // The cardholder completes the 3DS challenge in the browser: the
    // intent becomes succeeded in Stripe. The re-approve must adopt
    // that same intent (not mint a second one) and mark the visit paid.
    piStore["pi_test_1"] = { ...piStore["pi_test_1"], status: "succeeded" };
    const retry = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: viewBefore.body["publication_id"] }) as any, retry as any);
    expect(retry.code).toBe(200);
    expect(retry.body["state"]).toBe("paid");
    expect(piCalls).toHaveLength(1);
    expect(dbRows[0]["status"]).toBe("paid");
    expect(dbRows[0]["payment_intent_id"]).toBe("pi_test_1");
  });

  it("3DS (H1): a retry before the challenge still replays the same create key — no second intent", async () => {
    vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_3ds");
    piRequiresAction = true;
    await sendReport();
    enableDb();
    const sentAt = currentMeta["gh_report_sent_at"]!;
    dbRows = [{
      id: "row-report-3ds2", booking_id: BID, visit_no: 1, status: "report_sent",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    }];
    dbEvents = [
      { visit_id: "row-report-3ds2", booking_id: BID, event: "report_sent", detail: { version: 1, email_sent: true }, created_at: sentAt },
    ];
    const viewBefore = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, viewBefore as any);
    const approve = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: viewBefore.body["publication_id"] }) as any, approve as any);
    expect(approve.code).toBe(402);
    expect(approve.body["error"]).toBe("payment_requires_action");
    // The client taps Approve again before finishing 3DS: the server
    // re-confirms the same live intent (no new create) and answers
    // requires_action again with the same client_secret — in production
    // a fresh create would replay the same idempotency key anyway.
    const again = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve", seen_publication_id: viewBefore.body["publication_id"] }) as any, again as any);
    expect(again.code).toBe(402);
    expect(again.body["error"]).toBe("payment_requires_action");
    expect(again.body["client_secret"]).toBe("pi_test_1_secret_abc");
    expect(piCalls).toHaveLength(1);
  });

  it("operator approve is closed: it is not client payment approval (G3)", async () => {
    await sendReport();
    const res = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await adminHandler(adminReq({ action: "approve", booking_id: BID }) as any, res as any);
    expect(res.code).toBe(409);
    expect(res.body["error"]).toBe("operator_approve_disabled");
  });

  it("a paid visit records a post-payment issue (no auto-reversal) and still refuses new reports", async () => {
    await sendReport();
    currentMeta["gh_state"] = "paid";
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "found a streak", room: "Kitchen" }) as any, issue as any);
    expect(issue.code).toBe(200);
    expect(issue.body["postpay"]).toBe(true);
    expect(currentMeta["gh_postpay_issue"]).toBe("1");
    expect(currentMeta["gh_state"]).toBe("paid"); // payment state untouched
    expect(currentMeta["gh_issue_open"]).not.toBe("1"); // nothing "paused" — already paid
    const again = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "second" }) as any, again as any);
    expect(again.body["already"]).toBe(true);
    const approveLate = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "approve" }) as any, approveLate as any);
    expect(approveLate.code).toBe(409);
    const resend = await sendReport();
    expect(resend.code).toBe(409);
    expect(resend.body["error"]).toBe("already_paid");
  });

  it("N20: a bounced report returns no deadline (the timer is blocked)", async () => {
    await sendReport();
    currentMeta["gh_report_bounced"] = "1";
    const view = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(getReq(bt) as any, view as any);
    expect(view.code).toBe(200);
    expect(view.body["deadline"]).toBeNull();
    expect(view.body["delivery_failed"]).toBe(true);
    expect(view.body["charge_timer_blocked"]).toBe(true);
  });

  it("C26: a pre-payment issue after the 24h Terms §7 window is refused", async () => {
    await sendReport();
    enableDb();
    const sentAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    currentMeta["gh_report_sent_at"] = sentAt;
    dbRows = [{
      id: "row-report-late", booking_id: BID, visit_no: 1, status: "report_sent",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
    }];
    dbEvents = [];
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "Missed the oven" }) as any, issue as any);
    expect(issue.code).toBe(409);
    expect(issue.body["error"]).toBe("issue_window_expired");
    expect(dbRows[0]["issue_open"]).toBe(false);
  });

  it("C26: a post-payment complaint past both windows (24h report, 48h damage) is refused", async () => {
    await sendReport();
    enableDb();
    const sentAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const visitDate = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    currentMeta["gh_report_sent_at"] = sentAt;
    currentMeta["gh_state"] = "paid";
    dbRows = [{
      id: "row-report-pp-late", booking_id: BID, visit_no: 1, status: "paid",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
      visit_date: visitDate,
    }];
    dbEvents = [];
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "found a crack", room: "Kitchen" }) as any, issue as any);
    expect(issue.code).toBe(409);
    expect(issue.body["error"]).toBe("claim_window_expired");
  });

  it("C26: a post-payment complaint inside the 48h damage window is accepted even after the 24h report window", async () => {
    await sendReport();
    enableDb();
    const sentAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const visitDate = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    currentMeta["gh_report_sent_at"] = sentAt;
    currentMeta["gh_state"] = "paid";
    dbRows = [{
      id: "row-report-pp-ok", booking_id: BID, visit_no: 1, status: "paid",
      report_status: "sent", amount_cents: 18900, client_email: CUSTOMER.email,
      report_sent_at: sentAt, issue_open: false, issue_ever: false,
      report_bounced: false, payment_intent_id: null, receipt_email_id: null,
      visit_date: visitDate,
    }];
    dbEvents = [];
    const issue = response();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reportHandler(postReq({ bt, action: "issue", reason: "found a crack", room: "Kitchen" }) as any, issue as any);
    expect(issue.code).toBe(200);
    expect(issue.body["postpay"]).toBe(true);
  });
});
