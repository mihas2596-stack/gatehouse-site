// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

// Owner-charge matrix (B): 6 statuses x 5 report states x 4 publication
// ages x 3 approvals x 4 disputes x 2 bounces x 2 pinned amounts = 5760
// real charge calls, one per combination, each with a distinct caller
// IP (the endpoint rate-limits 30/min per IP; the matrix rotates the
// header so the limit never masks a charge outcome).
//
// Oracle, derived from chargeVisit + _payment_basis (not from the
// test's wishes): a charge may pay ONLY when status is report_sent,
// the report is currently sent (no return after it), no issue is open,
// the pinned amount exists and equals the request, and a basis holds —
// a valid client approval, or the timer (sent 24h+ ago, no issue ever,
// not bounced). Anything else must create no intent. Inconsistent
// states (e.g. status requested with a sent report) are KEPT in the
// matrix, not removed; they must still never pay.

const BID = "bid-matrix-charge";
const EMAIL = "client@example.com";
const ROW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTH = "Bearer " + "adm-" + "secret";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;

let rows: Row[];
let evts: Evt[];
let custMeta: Record<string, string>;
let piCalls: Array<{ amount: string; id: string }>;
let evSeq: number;

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
    if (v.startsWith("in.(") && v.endsWith(")")) {
      const set = new Set(v.slice(4, -1).split(","));
      out = out.filter((r) => set.has(String(r[k] ?? "")));
    }
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
      return res(200, { data: [{ id: "cus_mx_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } }] });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      if (custM[2]) return res(200, { data: [{ id: "pm_mx_1", type: "card" }] });
      if (method === "GET") return res(200, { id: "cus_mx_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } });
      const params = parseForm(init?.body);
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) custMeta[mm[1]] = v;
      }
      return res(200, { id: "cus_mx_1", metadata: { ...custMeta } });
    }
    if (u.pathname === "/v1/payment_intents/search") {
      return res(200, { data: [] });
    }
    const piGetM = u.pathname.match(/^\/v1\/payment_intents\/(pi_[^/]+)$/);
    if (piGetM && method === "GET") {
      const pi = piCalls.find((p) => p.id === piGetM[1]);
      if (!pi) return res(404, { error: { message: "not found" } });
      return res(200, { id: pi.id, status: "succeeded", amount: Number(pi.amount), currency: "usd", customer: "cus_mx_1", metadata: { gh_booking_id: BID, gh_report_version: "1" } });
    }
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      const params = parseForm(init?.body);
      const id = `pi_mx_${piCalls.length + 1}`;
      piCalls.push({ amount: params.get("amount") ?? "", id });
      return res(200, { id, status: "succeeded" });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") return res(200, { id: "email_mx_1" });

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

const STATUSES = ["requested", "confirmed", "report_sent", "payment_failed", "paid", "cancelled"];
const REPORTS = ["none", "draft", "submitted", "sent", "returned"];
const AGES = ["none", "1h", "24h", "30h"] as const;
const APPROVALS = ["none", "before", "after"] as const;
const DISPUTES = ["none", "rowEver", "rowOpen", "journal"] as const;

function iso(ms: number) { return new Date(ms).toISOString(); }

describe("owner charge matrix", () => {
  it("5760 combinations: forbidden charges are zero, allowed charges pay", async () => {
    const failures: string[] = [];
    let paidCount = 0;
    let allowedCount = 0;
    let combo = 0;
    for (const status of STATUSES) {
      for (const report of REPORTS) {
        for (const age of AGES) {
          for (const approval of APPROVALS) {
            for (const dispute of DISPUTES) {
              for (const bounce of [false, true]) {
                for (const pinned of [null, 20000]) {
                  combo++;
                  const now = Date.now();
                  const pubMs = age === "none" ? null
                    : age === "1h" ? now - 3600 * 1000
                    : age === "24h" ? now - 24 * 3600 * 1000
                    : now - 30 * 3600 * 1000;
                  const sentEvMs = (report === "sent" || report === "returned") && pubMs !== null ? pubMs : null;
                  const approvalMs = approval === "none" ? null
                    : approval === "before" ? (pubMs !== null ? pubMs - 3600 * 1000 : now - 2 * 3600 * 1000)
                    : (pubMs !== null ? pubMs + 2 * 3600 * 1000 : now - 3600 * 1000);
                  const disputeOpenMs = dispute === "journal" ? (pubMs !== null ? pubMs + 30 * 60 * 1000 : now - 30 * 60 * 1000) : null;
                  const disputeResolvedMs = dispute === "journal" ? (pubMs !== null ? pubMs + 3600 * 1000 : now - 15 * 60 * 1000) : null;

                  rows = [{
                    id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
                    status, report_status: report, amount_cents: pinned,
                    visit_date: "2027-01-15", window: "midday",
                    issue_open: dispute === "rowOpen",
                    issue_ever: dispute === "rowOpen" || dispute === "rowEver",
                    report_bounced: bounce,
                    report_sent_at: pubMs !== null && (report === "sent" || report === "returned") ? iso(pubMs) : null,
                    receipt_email_id: null, payment_intent_id: null,
                  }];
                  // Row sent_at mirrors the publication only for the
                  // states that were actually published; other states
                  // carry no publication time even when an age is set
                  // (the age dimension then only times the events).
                  if (report !== "sent" && report !== "returned") rows[0]["report_sent_at"] = null;
                  evts = [];
                  if (sentEvMs !== null) {
                    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: iso(sentEvMs) });
                  }
                  if (report === "returned" && pubMs !== null) {
                    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_returned", detail: {}, created_at: iso(pubMs + 3600 * 1000) });
                  }
                  if (report === "returned" && pubMs === null) {
                    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_returned", detail: {}, created_at: iso(now - 3600 * 1000) });
                  }
                  if (approvalMs !== null) {
                    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_approved", detail: {}, created_at: iso(approvalMs) });
                  }
                  if (disputeOpenMs !== null) {
                    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "issue_opened", detail: {}, created_at: iso(disputeOpenMs) });
                  }
                  if (disputeResolvedMs !== null) {
                    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "issue_resolved", detail: {}, created_at: iso(disputeResolvedMs) });
                  }
                  custMeta = {
                    gh_booking_id: BID, gh_state: "report_sent", gh_payment_method: "pm_mx_1",
                    gh_first_price_cents: "20000", gh_report_amount_cents: "20000",
                    gh_report_version: "1",
                    ...(pubMs !== null ? { gh_report_sent_at: iso(pubMs) } : {}),
                    ...(bounce ? { gh_report_bounced: "1" } : {}),
                  };
                  piCalls = []; evSeq = 0;

                  // ---- Oracle ----
                  const superseded = approvalMs !== null && sentEvMs !== null && sentEvMs > approvalMs;
                  const voided = approvalMs !== null && disputeOpenMs !== null && disputeOpenMs > approvalMs;
                  const validApproval = approvalMs !== null && !superseded && !voided;
                  const issueOpen = dispute === "rowOpen"
                    || (disputeOpenMs !== null && (disputeResolvedMs === null || disputeResolvedMs < disputeOpenMs));
                  const issueEver = dispute === "rowEver" || dispute === "rowOpen" || disputeOpenMs !== null;
                  const sentTime = pubMs !== null && (report === "sent" || report === "returned") ? pubMs : null;
                  const timerOk = sentTime !== null && now - sentTime >= 24 * 3600 * 1000 && !bounce && !issueOpen && !issueEver;
                  const returnedAfter = report === "returned" && sentEvMs !== null && pubMs !== null && pubMs + 3600 * 1000 > sentEvMs;
                  // paymentBasis gates on a finite publication time
                  // BEFORE approvals: an approval with no publication
                  // timestamp anywhere is not payable.
                  const allowed = status === "report_sent" && report === "sent" && !returnedAfter
                    && !issueOpen && pinned === 20000 && sentTime !== null && (validApproval || timerOk);
                  if (allowed) allowedCount++;

                  const r = response();
                  await bookingAction(
                    {
                      method: "POST",
                      headers: { authorization: AUTH, origin: "https://www.gatehousehomecleaning.com", "x-forwarded-for": `matrix-${combo}` },
                      body: { action: "charge", booking_id: BID, amount_cents: 20000 },
                    },
                    r as never,
                  );
                  const paid = r.code === 200 && r.body["state"] === "paid";
                  if (paid) paidCount++;
                  const key = `${status}/${report}/${age}/${approval}/${dispute}/b${bounce ? 1 : 0}/p${pinned ?? "null"}`;
                  if (paid && !allowed) {
                    failures.push(`FORBIDDEN PAID ${key} -> ${JSON.stringify(r.body)}`);
                  }
                  if (allowed && !paid) {
                    failures.push(`ALLOWED NOT PAID ${key} -> code ${r.code} ${JSON.stringify(r.body)}`);
                  }
                  if (paid && (piCalls.length !== 1 || piCalls[0].amount !== "20000")) {
                    failures.push(`PAID WRONG INTENT ${key} pi=${JSON.stringify(piCalls)}`);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect({ combos: combo, allowed: allowedCount, paid: paidCount }).toEqual(
      expect.objectContaining({ combos: 5760 }),
    );
    if (failures.length > 0) {
      throw new Error(`${failures.length} matrix failures (first 20):\n${failures.slice(0, 20).join("\n")}`);
    }
  }, 300000);
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = []; evts = []; custMeta = {}; piCalls = []; evSeq = 0;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
