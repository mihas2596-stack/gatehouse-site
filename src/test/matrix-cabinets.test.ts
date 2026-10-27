// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import visitHandler from "../../api/visit";
import cleanerHandler from "../../api/cleaner";
import { signBooking } from "../../api/create-checkout-session";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

// Cabinet matrix: 6 statuses x 5 report states x 16 flag combinations
// (issue_open, issue_ever, bounced, client approval) x 4 cleaner-link
// states x 3 card states = 5760 real GET /report, /visit, /cleaner
// calls. Each combination uses a distinct caller IP (report/visit
// rate-limit 60/min per IP).
//
// The link dimension drives the cleaner token (valid / expired /
// rotated / invalid); the client token is valid throughout, because
// an invalid client token short-circuits every view to invalid_link
// and says nothing about state combinations — invalid client tokens
// are asserted separately, once, below the matrix.
//
// Oracles (from the view code, not wishes):
//  /report: amount_cents = pinned (or null), publication_id = row
//    sent_at (or null), receipt_sent/postpay_issue false (no receipt
//    marker, no postpay event in these worlds), paid = row paid,
//    charge_timer_blocked = open||ever||bounced (row flags; journal
//    carries no dispute here), reason priority open > bounced > ever,
//    delivery_failed = bounced.
//  /visit: state = cancelled | paid | approved (approval event beats
//    sent_at) | report_sent (row sent_at) | awaiting_confirmation
//    (card) | card_needed; timer fields as on /report. NOTE: row-only
//    issue flags do NOT surface as issue_open here — buildEffectiveMeta
//    reads issues from the journal only. In production every issue
//    transition writes both, so this is a synthetic-state quirk, and
//    the oracle encodes the code, not the wish.
//  /cleaner: valid -> 200 with this visit; expired -> 410
//    link_expired; rotated/invalid -> 404 invalid_link with no visit
//    data leaked.

const BID = "bid-matrix-cab";
const EMAIL = "client@example.com";
const ROW_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;

let rows: Row[];
let evts: Evt[];
let photos: Row[];
let custMeta: Record<string, string>;
let cardState: "none" | "valid" | "declined";

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (k.includes("->>")) {
      // PostgREST JSON operator (link-open throttle): no test row
      // carries the key, so the filter matches nothing.
      out = [];
      continue;
    }
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => String(r[k] ?? "") !== decodeURIComponent(v.slice(4)));
    if (v === "is.null") out = out.filter((r) => r[k] === null || r[k] === undefined);
    if (v.startsWith("in.(") && v.endsWith(")")) {
      const set = new Set(v.slice(4, -1).split(","));
      out = out.filter((r) => set.has(String(r[k] ?? "")));
    }
    if (v.startsWith("lt.")) out = out.filter((r) => String(r[k] ?? "") < decodeURIComponent(v.slice(3)));
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
      const emailM = q.match(/email:'([^']+)'/);
      if (bidM && bidM[1] !== BID) return res(200, { data: [] });
      if (emailM && emailM[1] !== EMAIL) return res(200, { data: [] });
      return res(200, { data: [{ id: "cus_mx_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } }] });
    }
    const custM = u.pathname.match(/^\/v1\/customers\/([^/]+)(\/payment_methods)?$/);
    if (custM) {
      if (custM[2]) {
        return res(200, {
          data: cardState === "none" ? [] : [{ id: "pm_mx_1", type: "card", card: { brand: "visa", last4: "4242" } }],
        });
      }
      if (method === "GET") return res(200, { id: "cus_mx_1", email: EMAIL, name: "Casey Client", metadata: { ...custMeta } });
      const params = parseForm(init?.body);
      for (const [k, v] of params.entries()) {
        const mm = k.match(/^metadata\[(.+)\]$/);
        if (mm) custMeta[mm[1]] = v;
      }
      return res(200, { id: "cus_mx_1", metadata: { ...custMeta } });
    }
    return res(404, { error: { message: "stripe route not stubbed" } });
  }

  if (host === "api.resend.com") return res(200, { id: "email_mx_1" });

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
        evts.push({ ...body, created_at: new Date().toISOString() });
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

async function call(handler: (req: unknown, res: unknown) => Promise<void> | void, req: Record<string, unknown>) {
  const r = response();
  await handler(req, r as never);
  return r;
}

const STATUSES = ["requested", "confirmed", "report_submitted", "report_sent", "paid", "cancelled"];
const REPORTS = ["none", "draft", "submitted", "sent", "returned"];
const LINKS = ["valid", "expired", "rotated", "invalid"] as const;
const CARDS = ["none", "valid", "declined"] as const;

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
  rows = []; evts = []; photos = []; custMeta = {}; cardState = "none";
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("cabinet matrix", () => {
  it("5760 combinations of status x report x flags x link x card", async () => {
    const failures: string[] = [];
    let combo = 0;
    const now = Date.now();
    const sentAt = new Date(now - 25 * 3600 * 1000).toISOString();
    for (const status of STATUSES) {
      for (const report of REPORTS) {
        for (let flags = 0; flags < 16; flags++) {
          const issueOpen = Boolean(flags & 1);
          const issueEver = Boolean(flags & 2);
          const bounced = Boolean(flags & 4);
          const approval = Boolean(flags & 8);
          for (const link of LINKS) {
            for (const card of CARDS) {
              combo++;
              const published = report === "sent" || report === "returned";
              const issuance = "dd".repeat(16);
              const oldIssuance = "ee".repeat(16);
              const token = mintCleanerLinkV2("test-cleaner-secret-123", ROW_ID, link === "rotated" ? oldIssuance : issuance);
              rows = [{
                id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
                status, report_status: report, amount_cents: 20000,
                visit_date: "2027-01-15", window: "midday", cleaner_name: "Ana Torres", cleaner_id: "cl_mx_1",
                issue_open: issueOpen, issue_ever: issueEver || issueOpen, report_bounced: bounced,
                report_sent_at: published ? sentAt : null, receipt_email_id: null,
                checklist: null,
                cleaner_token_hash: hashToken(link === "rotated"
                  ? mintCleanerLinkV2("test-cleaner-secret-123", ROW_ID, issuance)
                  : token),
                cleaner_link_version: "v2",
                cleaner_link_issuance: issuance,
                cleaner_token_expires: link === "expired" ? new Date(now - 3600 * 1000).toISOString() : new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
              }];
              evts = [];
              if (published) {
                evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: sentAt });
              }
              if (report === "returned") {
                evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_returned", detail: {}, created_at: new Date(now - 24 * 3600 * 1000).toISOString() });
              }
              if (approval) {
                evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_approved", detail: {}, created_at: new Date(now - 26 * 3600 * 1000).toISOString() });
              }
              photos = [];
              cardState = card;
              custMeta = {
                gh_booking_id: BID, gh_state: status === "paid" ? "paid" : "card_ready",
                ...(card === "none" ? {} : { gh_payment_method: "pm_mx_1" }),
                gh_first_price_cents: "20000", gh_report_amount_cents: "20000",
                ...(published ? { gh_report_sent_at: sentAt } : {}),
                ...(bounced ? { gh_report_bounced: "1" } : {}),
              };
              const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
              const ip = `matrix-${combo}`;
              const key = `${status}/${report}/f${flags}/${link}/${card}`;

              // ---- /report ----
              const rep = await call(reportHandler, { method: "GET", headers: { "x-forwarded-for": ip }, query: { bt } });
              if (rep.code !== 200) failures.push(`${key} /report code ${rep.code}`);
              else {
                const b = rep.body;
                if (b["amount_cents"] !== 20000) failures.push(`${key} /report amount ${JSON.stringify(b["amount_cents"])}`);
                if (b["publication_id"] !== (published ? sentAt : "")) failures.push(`${key} /report publication ${JSON.stringify(b["publication_id"])}`);
                if (b["receipt_sent"] !== false) failures.push(`${key} /report receipt_sent ${JSON.stringify(b["receipt_sent"])}`);
                if (b["postpay_issue"] !== false) failures.push(`${key} /report postpay_issue ${JSON.stringify(b["postpay_issue"])}`);
                if (b["paid"] !== (status === "paid")) failures.push(`${key} /report paid ${JSON.stringify(b["paid"])}`);
                const blocked = issueOpen || issueEver || bounced;
                if (b["charge_timer_blocked"] !== blocked) failures.push(`${key} /report timer_blocked ${JSON.stringify(b["charge_timer_blocked"])} want ${blocked}`);
                const reason = issueOpen ? "issue_open" : bounced ? "bounced" : issueEver ? "issue_ever" : null;
                if (b["charge_timer_block_reason"] !== reason) failures.push(`${key} /report timer_reason ${JSON.stringify(b["charge_timer_block_reason"])} want ${reason}`);
                if (b["delivery_failed"] !== bounced) failures.push(`${key} /report delivery_failed ${JSON.stringify(b["delivery_failed"])}`);
              }

              // ---- /visit ----
              const vis = await call(visitHandler, { method: "GET", headers: { "x-forwarded-for": ip }, query: { bt } });
              if (vis.code !== 200) failures.push(`${key} /visit code ${vis.code}`);
              else {
                const b = vis.body;
                const wantState = status === "cancelled" ? "cancelled"
                  : status === "paid" ? "paid"
                  : approval ? "approved"
                  : published ? "report_sent"
                  : card !== "none" ? "awaiting_confirmation" : "card_needed";
                if (b["state"] !== wantState) failures.push(`${key} /visit state ${JSON.stringify(b["state"])} want ${wantState}`);
                const blocked = issueOpen || issueEver || bounced;
                if (b["charge_timer_blocked"] !== blocked) failures.push(`${key} /visit timer_blocked ${JSON.stringify(b["charge_timer_blocked"])} want ${blocked}`);
              }

              // ---- /cleaner ----
              const ct = link === "invalid" ? "ct2.invalid-token-value-12345" : token;
              const cl = await call(cleanerHandler, { method: "GET", headers: {}, query: { ct } });
              const flat = JSON.stringify(cl.body);
              if (link === "valid") {
                if (cl.code !== 200 || cl.body["ok"] !== true) failures.push(`${key} /cleaner valid code ${cl.code} ok ${JSON.stringify(cl.body["ok"])}`);
                else {
                  const v = cl.body["visit"] as Record<string, unknown> | undefined;
                  if (v?.["date"] !== "2027-01-15") failures.push(`${key} /cleaner valid wrong date ${JSON.stringify(v?.["date"])}`);
                  if (cl.body["report_status"] !== report) failures.push(`${key} /cleaner valid wrong report_status ${JSON.stringify(cl.body["report_status"])}`);
                  if (cl.body["cancelled"] !== (status === "cancelled")) failures.push(`${key} /cleaner valid wrong cancelled ${JSON.stringify(cl.body["cancelled"])}`);
                }
              } else if (link === "expired") {
                if (cl.code !== 410 || cl.body["error"] !== "link_expired") failures.push(`${key} /cleaner expired code ${cl.code} ${JSON.stringify(cl.body["error"])}`);
              } else {
                if (cl.code !== 404 || cl.body["error"] !== "invalid_link") failures.push(`${key} /cleaner ${link} code ${cl.code} ${JSON.stringify(cl.body["error"])}`);
                if (flat.includes("2027-01-15") || flat.includes("Casey")) failures.push(`${key} /cleaner ${link} leaked visit data`);
              }
            }
          }
        }
      }
    }
    expect(combo).toBe(5760);
    if (failures.length > 0) {
      throw new Error(`${failures.length} matrix failures (first 20):\n${failures.slice(0, 20).join("\n")}`);
    }
  }, 300000);

  it("invalid client token opens nothing on report or visit", async () => {
    rows = [{
      id: ROW_ID, booking_id: BID, client_email: EMAIL, status: "report_sent", report_status: "sent",
      amount_cents: 20000, visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false, report_sent_at: new Date().toISOString(),
    }];
    evts = [];
    custMeta = { gh_booking_id: BID, gh_state: "report_sent", gh_payment_method: "pm_mx_1" };
    const rep = await call(reportHandler, { method: "GET", headers: {}, query: { bt: "garbage-token-value-1234567890" } });
    expect(rep.body["state"]).toBe("invalid_link");
    expect(JSON.stringify(rep.body)).not.toContain(ROW_ID);
    const vis = await call(visitHandler, { method: "GET", headers: {}, query: { bt: "garbage-token-value-1234567890" } });
    expect(vis.body["state"]).toBe("invalid_link");
    expect(JSON.stringify(vis.body)).not.toContain(ROW_ID);
  });
});
