// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cleanerHandler from "../../api/cleaner";
import bookingAction from "../../api/booking-action";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

// RA14/RA15: the publish claim is shared by the cleaner's Finish and
// the owner's send_report. A barrier (not Promise.all alone) proves
// both orders: whichever publisher is paused mid-flight, the other
// one wins exactly once and the resumed loser sends nothing.
// RA15: a failed claim PATCH fails closed — no email, no event, no
// phantom publication — and recovery completes the same publication.

const BID = "bid-ra14-1";
const EMAIL = "client@example.com";
const ROW_ID = "44444444-4444-4444-8444-444444444444";
const CLEANER_ID = "55555555-5555-4555-8555-555555555555";
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
// Barrier controls, set per test. The mock PATCH awaits the gate
// promise when the matching claim PATCH arrives, and flips the
// matching `reached` flag first so the test knows it is parked.
let blockCleanerClaim: Promise<void> | null;
let blockOwnerCas: Promise<void> | null;
let cleanerClaimReached: boolean;
let ownerCasReached: boolean;
// Each gate parks only the FIRST matching PATCH: in the send/send
// test the second send must run through while the first is parked.
let cleanerClaimParkedOnce: boolean;
let ownerCasParkedOnce: boolean;
// Fail exactly one class of claim PATCH with a 500.
let failCleanerClaim: boolean;
let failOwnerCas: boolean;

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
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== v.slice(4));
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
    resendSubjects.push(String(body.subject ?? ""));
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
        evts.push({ ...body, created_at: new Date(Date.now() + evSeq).toISOString() });
        return res(201, {});
      }
      if (table === "gh_visits") {
        rows.push(body);
        return res(201, body);
      }
      return res(201, {});
    }
    if (method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const query = u.search;
      const isCleanerClaim =
        body.report_status === "sent" && query.includes("status=eq.report_submitted");
      // Owner send_report CAS shapes: first publish (submitted),
      // resend (current report_sent_at), degenerate sent-without-date.
      // The cleaner claim is excluded by the status=eq filter above.
      const isOwnerCas =
        body.report_status === "sent" &&
        !query.includes("status=eq.report_submitted") &&
        (query.includes("report_status=eq.submitted") ||
          query.includes("report_sent_at=eq.") ||
          query.includes("report_status=eq.sent"));
      if (isCleanerClaim && failCleanerClaim) return res(500, { error: { message: "db down" } });
      if (isOwnerCas && failOwnerCas) return res(500, { error: { message: "db down" } });
      if (isCleanerClaim && blockCleanerClaim && !cleanerClaimParkedOnce) {
        cleanerClaimParkedOnce = true;
        cleanerClaimReached = true;
        await blockCleanerClaim;
      }
      if (isOwnerCas && blockOwnerCas && !ownerCasParkedOnce) {
        ownerCasParkedOnce = true;
        ownerCasReached = true;
        await blockOwnerCas;
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
    visit_date: "2027-02-10", window: "midday", cleaner_name: "Ana Torres", cleaner_id: CLEANER_ID,
    issue_open: false, issue_ever: false, report_bounced: false, report_sent_at: null,
    checklist: null, ...over,
  };
}

function confirmedWorld(): string {
  rows = [baseRow()];
  const issuance = "cc".repeat(16);
  const token = mintCleanerLinkV2("test-cleaner-secret-123", ROW_ID, issuance);
  rows[0]["cleaner_token_hash"] = hashToken(token);
  rows[0]["cleaner_link_version"] = "v2";
  rows[0]["cleaner_link_issuance"] = issuance;
  evts = [
    { visit_id: ROW_ID, booking_id: BID, event: "visit_confirmed", detail: {}, created_at: new Date(Date.now() - 60000).toISOString() },
  ];
  photos = [
    { id: "ph1", visit_id: ROW_ID, room: "Kitchen", kind: "after", storage_path: "r/kitchen-after.jpg" },
    { id: "ph2", visit_id: ROW_ID, room: "Bathrooms", kind: "after", storage_path: "r/bath-after.jpg" },
  ];
  customers = [{
    id: "cus_ra14_1", email: EMAIL, name: "Casey Client", pm: "pm_ra14_1",
    metadata: { gh_booking_id: BID, gh_state: "card_ready", gh_payment_method: "pm_ra14_1", gh_first_price_cents: "20000" },
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

async function waitFor(flag: () => boolean, label: string) {
  for (let i = 0; i < 200 && !flag(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(flag()).toBe(true);
}

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
  blockCleanerClaim = null; blockOwnerCas = null;
  cleanerClaimReached = false; ownerCasReached = false;
  cleanerClaimParkedOnce = false; ownerCasParkedOnce = false;
  failCleanerClaim = false; failOwnerCas = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const clientReportEmails = () => resendSubjects.filter((s) => s === "Your cleaning report is ready");
const reportSentEvents = () => evts.filter((e) => e.event === "report_sent");

describe("RA14 publish claim, barrier races", () => {
  it("Finish paused at the publish claim, owner send wins: one publication, one client email", async () => {
    const ct = confirmedWorld();
    let release!: () => void;
    blockCleanerClaim = new Promise<void>((r) => { release = r; });
    const finishP = CL({ ct, action: "submit", checklist: checklist() });
    await waitFor(() => cleanerClaimReached, "cleaner claim parked");
    // The submit CAS already moved the row to submitted; the owner
    // publish now claims it and completes.
    const send = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(send.code).toBe(200);
    expect(send.body["email_sent"]).toBe(true);
    release();
    const finish = await finishP;
    expect(finish.body["already"]).toBe(true);
    expect(finish.body["published"]).toBe(false);
    expect(reportSentEvents()).toHaveLength(1);
    expect(clientReportEmails()).toHaveLength(1);
    expect(rows[0]["report_status"]).toBe("sent");
  });

  it("owner send parked at the CAS, second send wins: one publication, one client email", async () => {
    // The reverse Finish/send order is impossible by construction:
    // send_report rejects a draft/returned row (report_not_ready),
    // and a submitted row cannot be re-Finished (the submit CAS
    // admits only none/draft/returned). So the second barrier order
    // is send/send: the parked first send must lose to the second
    // one, proving the CAS — not call scheduling — decides.
    confirmedWorld();
    rows[0]["report_status"] = "submitted";
    rows[0]["checklist"] = checklist();
    let release!: () => void;
    blockOwnerCas = new Promise<void>((r) => { release = r; });
    const firstP = BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    await waitFor(() => ownerCasReached, "owner CAS parked");
    const second = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(second.code).toBe(200);
    expect(second.body["email_sent"]).toBe(true);
    release();
    const first = await firstP;
    expect(first.body["already_sent"]).toBe(true);
    expect(reportSentEvents()).toHaveLength(1);
    expect(clientReportEmails()).toHaveLength(1);
    expect(rows[0]["report_status"]).toBe("sent");
  });
});

describe("RA15 claim failure fails closed", () => {
  it("owner send_report CAS 500: 502, no email, row stays submitted, retry publishes once", async () => {
    confirmedWorld();
    rows[0]["report_status"] = "submitted";
    rows[0]["checklist"] = checklist();
    failOwnerCas = true;
    const failed = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(failed.code).toBe(502);
    expect(failed.body["error"]).toBe("db_error");
    expect(clientReportEmails()).toHaveLength(0);
    expect(reportSentEvents()).toHaveLength(0);
    expect(rows[0]["report_status"]).toBe("submitted");
    failOwnerCas = false;
    const retry = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(retry.code).toBe(200);
    expect(retry.body["email_sent"]).toBe(true);
    expect(reportSentEvents()).toHaveLength(1);
    expect(clientReportEmails()).toHaveLength(1);
  });

  it("send_report on a payment_pending row is refused, nothing changes", async () => {
    confirmedWorld();
    rows[0]["status"] = "payment_pending";
    rows[0]["report_status"] = "sent";
    rows[0]["report_sent_at"] = new Date().toISOString();
    const sentAtBefore = rows[0]["report_sent_at"];
    const r = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("payment_in_flight");
    expect(clientReportEmails()).toHaveLength(0);
    expect(reportSentEvents()).toHaveLength(0);
    expect(rows[0]["report_sent_at"]).toBe(sentAtBefore);
    expect(rows[0]["status"]).toBe("payment_pending");
  });

  it("cleaner publish-claim 500: no email, row stays submitted, owner send recovers once", async () => {
    const ct = confirmedWorld();
    failCleanerClaim = true;
    const finish = await CL({ ct, action: "submit", checklist: checklist() });
    expect(finish.body["published"]).toBe(false);
    expect(finish.body["publish_error"]).toBe("db_error");
    expect(clientReportEmails()).toHaveLength(0);
    expect(reportSentEvents()).toHaveLength(0);
    expect(rows[0]["report_status"]).toBe("submitted");
    expect(rows[0]["status"]).toBe("report_submitted");
    failCleanerClaim = false;
    const send = await BA({ action: "send_report", booking_id: BID, photos: PHOTOS });
    expect(send.code).toBe(200);
    expect(send.body["email_sent"]).toBe(true);
    expect(reportSentEvents()).toHaveLength(1);
    expect(clientReportEmails()).toHaveLength(1);
  });
});
