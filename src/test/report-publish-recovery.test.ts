// @vitest-environment node
// Report-publish recovery (Task 3 / H3): Resend accepts the report
// email but a later DB write fails. The client already has the report
// link, so the retry must RECONCILE the delivery record by the saved
// Resend id — never send a duplicate email — and the 24h timer must
// start from the actual (current-version) send. A confirmed bounce
// still blocks auto-charge.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cleanerHandler from "../../api/cleaner";
import bookingAction from "../../api/booking-action";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

const BID = "bid-report-recovery-1";
const EMAIL = "client@example.com";
const ROW_ID = "66666666-6666-6666-8666-666666666666";
const CLEANER_ID = "77777777-7777-4777-8777-777777777777";
const AUTH = "Bearer " + "adm-" + "secret";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;
type Cust = { id: string; email: string; name: string; pm: string; metadata: Record<string, string> };

let rows: Row[];
let evts: Evt[];
let photos: Row[];
let customers: Cust[];
let resendSubjects: string[];
let evSeq: number;
// Fail the FIRST row-tracking PATCH (the write that records the
// Resend id on the row). The repair write that follows must succeed.
let failTrackingOnce: boolean;
let trackingFailed: boolean;
// Resend answers ok but with no message id (unparseable body).
let resendReportNoId: boolean;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === v.slice(3));
    if (v.startsWith("in.(") && v.endsWith(")")) {
      const set = new Set(v.slice(4, -1).split(","));
      out = out.filter((r) => set.has(String(r[k] ?? "")));
    }
    if (v.startsWith("neq.")) out = out.filter((r) => r[k] !== null && r[k] !== undefined && String(r[k]) !== v.slice(4));
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
      const found = customers.filter((c) => (bidM ? c.metadata["gh_booking_id"] === bidM[1] : true));
      return res(200, { data: found.map((c) => ({ ...c, metadata: c.metadata })) });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      const cust = customers.find((c) => c.id === custM[1]);
      if (!cust) return res(404, { error: { message: "not found" } });
      if (custM[2]) return res(200, { data: [{ id: cust.pm, type: "card" }] });
      if (method === "GET") return res(200, { ...cust, metadata: cust.metadata });
      const params = parseForm(init?.body);
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) cust.metadata[mm[1]] = v;
      }
      return res(200, { ...cust, metadata: cust.metadata });
    }
    if (u.pathname === "/v1/customers" && method === "GET") {
      return res(200, { data: customers.map((c) => ({ ...c, metadata: c.metadata })) });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const subject = String(body.subject ?? "");
    resendSubjects.push(subject);
    if (resendReportNoId && subject === "Your cleaning report is ready") {
      return res(200, {});
    }
    return res(200, { id: `email_${resendSubjects.length}` });
  }

  if (host.includes("supabase")) {
    if (u.pathname.includes("/object/sign/")) return res(200, { signedURL: "/signed/test-url" });
    if (u.pathname.includes("/storage/v1/object/")) return res(200, {});
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") return res(200, applyFilters(rows, u));
      if (table === "gh_events") return res(200, applyFilters(evts, u));
      if (table === "gh_photos") return res(200, applyFilters(photos, u));
      return res(200, []);
    }
    if (method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (table === "gh_events") {
        evSeq += 1;
        const inserted = { ...body, created_at: new Date(Date.now() + evSeq).toISOString() };
        evts.push(inserted);
        return res(201, [inserted]);
      }
      if (table === "gh_visits") {
        rows.push(body);
        return res(201, [body]);
      }
      return res(201, [body]);
    }
    if (method === "DELETE") {
      const list = table === "gh_photos" ? photos : table === "gh_events" ? evts : rows;
      const doomed = applyFilters(list, u);
      for (const d of doomed) { const i = list.indexOf(d); if (i >= 0) list.splice(i, 1); }
      return res(200, doomed);
    }
    if (method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      // The row-tracking write records a non-null Resend id. Fail it
      // exactly once; the repair write that follows must go through.
      const isTrackingWrite = typeof body.report_email_id === "string" && body.report_email_id !== "" && body.report_bounced === false;
      if (isTrackingWrite && failTrackingOnce && !trackingFailed) {
        trackingFailed = true;
        return res(500, { error: { message: "db down" } });
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

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
    status: "confirmed", report_status: "none", amount_cents: 20000,
    visit_date: "2026-11-10", window: "midday", cleaner_name: "Ana Torres", cleaner_id: CLEANER_ID,
    issue_open: false, issue_ever: false, report_bounced: false, report_sent_at: null,
    report_email_id: null, checklist: null, ...over,
  };
}

function confirmedWorld(): string {
  rows = [baseRow()];
  const issuance = "dd".repeat(16);
  const token = mintCleanerLinkV2("test-cleaner-secret-123", ROW_ID, issuance);
  rows[0]["cleaner_token_hash"] = hashToken(token);
  rows[0]["cleaner_link_version"] = "v2";
  rows[0]["cleaner_link_issuance"] = issuance;
  evts = [
    { visit_id: ROW_ID, booking_id: BID, event: "visit_confirmed", detail: {}, created_at: new Date(Date.now() - 60000).toISOString() },
  ];
  photos = [
    { id: "ph0", visit_id: ROW_ID, room: "Kitchen", kind: "before", storage_path: "r/kitchen-before.jpg" },
    { id: "ph1", visit_id: ROW_ID, room: "Kitchen", kind: "after", storage_path: "r/kitchen-after.jpg" },
    { id: "ph3", visit_id: ROW_ID, room: "Bathrooms", kind: "before", storage_path: "r/bath-before.jpg" },
    { id: "ph2", visit_id: ROW_ID, room: "Bathrooms", kind: "after", storage_path: "r/bath-after.jpg" },
  ];
  customers = [{
    id: "cus_recovery_1", email: EMAIL, name: "Casey Client", pm: "pm_recovery_1",
    metadata: { gh_booking_id: BID, gh_state: "card_ready", gh_payment_method: "pm_recovery_1", gh_first_price_cents: "20000" },
  }];
  return token;
}

function checklist() {
  return {
    rooms: [
      { name: "Kitchen", items: [{ label: "Wipe counters", done: true }] },
      { name: "Bathrooms", items: [{ label: "Scrub sink", done: true }] },
    ],
  };
}

const PHOTOS = [
  "https://cdn.example.com/report/kitchen.jpg",
  "https://cdn.example.com/report/bath.jpg",
  "https://cdn.example.com/report/living.jpg",
];

async function call(handler: (req: unknown, res: unknown) => Promise<void> | void, req: Record<string, unknown>) {
  const r = response();
  await handler(req, r as never);
  return r;
}

const CL = (body: Record<string, unknown>) =>
  call(cleanerHandler, { method: "POST", headers: {}, body });
const BA = (body: Record<string, unknown>) =>
  call(bookingAction, { method: "POST", body, headers: { authorization: AUTH, origin: "https://www.gatehousehomecleaning.com" } });

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("CLEANER_LINK_SECRET", "test-cleaner-secret-123");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = []; evts = []; photos = []; customers = []; resendSubjects = []; evSeq = 0;
  failTrackingOnce = false; trackingFailed = false; resendReportNoId = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const clientReportEmails = () => resendSubjects.filter((s) => s === "Your cleaning report is ready");
const reportSentEvents = () => evts.filter((e) => e.event === "report_sent");

describe("report publish recovery (Task 3 / H3)", () => {
  it("cleaner publish loses the tracking write: owner re-send repairs by the saved Resend id, one email total", async () => {
    const ct = confirmedWorld();
    failTrackingOnce = true;
    const finish = await CL({ ct, action: "submit", checklist: checklist() });
    // The email went out (email_sent: true) but only the tracking
    // write failed — the client already has the report link.
    expect(finish.code).toBe(200);
    expect(finish.body["published"]).toBe(false);
    expect(finish.body["publish_error"]).toBe("report_email_tracking_failed");
    expect(finish.body["email_sent"]).toBe(true);
    expect(clientReportEmails()).toHaveLength(1);
    expect(rows[0]["report_status"]).toBe("sent");
    expect(rows[0]["report_bounced"]).toBe(true);
    expect(rows[0]["report_email_id"]).toBeNull();
    expect(reportSentEvents()).toHaveLength(0);
    // The Resend id survived in Stripe metadata — the recovery key.
    expect(customers[0].metadata["gh_report_email_id"]).toBe("email_1");

    const resend = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(resend.code).toBe(200);
    expect(resend.body["already_sent"]).toBe(true);
    expect(resend.body["email_sent"]).toBe(true);
    expect(resend.body["journal_repaired"]).toBe(true);
    // No duplicate client email.
    expect(clientReportEmails()).toHaveLength(1);
    // The row is repaired: the Resend id is recorded (so a later
    // bounce can still be matched and void the clock) and the
    // pessimistic bounce is cleared.
    expect(rows[0]["report_email_id"]).toBe("email_1");
    expect(rows[0]["report_bounced"]).toBe(false);
    // The timer basis is restored: a report_sent event with
    // email_sent: true (latestDeliveredSent) for this version.
    expect(reportSentEvents()).toHaveLength(1);
    expect(reportSentEvents()[0]?.detail?.["email_sent"]).toBe(true);
    expect(reportSentEvents()[0]?.detail?.["journal_repaired"]).toBe(true);
    expect(reportSentEvents()[0]?.detail?.["version"]).toBe(1);
  });

  it("owner first publish loses the tracking write: retry repairs it, one email total", async () => {
    confirmedWorld();
    rows[0]["report_status"] = "submitted";
    rows[0]["checklist"] = checklist();
    failTrackingOnce = true;
    const first = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(first.code).toBe(502);
    expect(first.body["error"]).toBe("report_email_tracking_failed");
    expect(first.body["email_sent"]).toBe(true);
    expect(clientReportEmails()).toHaveLength(1);
    expect(rows[0]["report_status"]).toBe("sent");
    expect(rows[0]["report_bounced"]).toBe(true);
    expect(rows[0]["report_email_id"]).toBeNull();
    expect(reportSentEvents()).toHaveLength(0);

    const retry = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(retry.code).toBe(200);
    expect(retry.body["journal_repaired"]).toBe(true);
    expect(clientReportEmails()).toHaveLength(1);
    expect(rows[0]["report_email_id"]).toBe("email_1");
    expect(rows[0]["report_bounced"]).toBe(false);
    expect(reportSentEvents()).toHaveLength(1);
    expect(reportSentEvents()[0]?.detail?.["email_sent"]).toBe(true);
  });

  it("healthy send: re-send within 10 minutes is a no-op — no repair, no duplicate", async () => {
    const ct = confirmedWorld();
    const finish = await CL({ ct, action: "submit", checklist: checklist() });
    expect(finish.body["published"]).toBe(true);
    expect(finish.body["email_sent"]).toBe(true);
    expect(reportSentEvents()).toHaveLength(1);

    const resend = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(resend.code).toBe(200);
    expect(resend.body["already_sent"]).toBe(true);
    expect(resend.body["journal_repaired"]).toBeUndefined();
    expect(clientReportEmails()).toHaveLength(1);
    expect(reportSentEvents()).toHaveLength(1);
  });

  it("Resend ok but no message id: distinct error, email_sent true, timer stays blocked", async () => {
    const ct = confirmedWorld();
    resendReportNoId = true;
    const finish = await CL({ ct, action: "submit", checklist: checklist() });
    expect(finish.code).toBe(200);
    expect(finish.body["published"]).toBe(false);
    // Not the generic tracking failure: there is no id to reconcile
    // a retry by, so the owner must decide (a re-send may duplicate).
    expect(finish.body["publish_error"]).toBe("report_email_id_missing");
    expect(finish.body["email_sent"]).toBe(true);
    expect(clientReportEmails()).toHaveLength(1);
    expect(rows[0]["report_status"]).toBe("sent");
    expect(rows[0]["report_bounced"]).toBe(true);
    expect(rows[0]["report_email_id"]).toBeNull();
    expect(reportSentEvents()).toHaveLength(0);
    expect(customers[0].metadata["gh_report_email_id"]).toBeUndefined();
  });

  it("repair does not fire for a genuinely bounced report: the bounce stays blocking", async () => {
    const ct = confirmedWorld();
    const finish = await CL({ ct, action: "submit", checklist: checklist() });
    expect(finish.body["published"]).toBe(true);
    // The report email later bounces: the webhook marks the row.
    rows[0]["report_bounced"] = true;
    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_bounced", detail: { email_id: "email_1" }, created_at: new Date().toISOString() });
    // The owner re-sends after the bounce: the stuck-publication
    // repair must not un-bounce it — the journal already proves
    // this version was delivered, so this is a fresh re-send.
    const resend = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(resend.body["journal_repaired"]).toBeUndefined();
    // Within 10 minutes of the healthy send the double-send guard
    // no-ops — and the bounce carve-out does not apply because the
    // send was healthy (metadata bounced is ""). Either way the
    // repair did not clear the bounce.
    expect(rows[0]["report_bounced"]).toBe(true);
  });
});
