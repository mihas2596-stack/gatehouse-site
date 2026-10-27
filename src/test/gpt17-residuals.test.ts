// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";
import reportHandler from "../../api/report";
import visitHandler from "../../api/visit";
import autoChargeHandler from "../../api/auto-charge";
import { signBooking } from "../../api/create-checkout-session";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

// Residual coverage for the GPT-17 audit: the five items whose fixes
// landed in code but had no direct mock test on the dangerous input.
// P06: approve on a cancelled / returned / merely-submitted report.
// S01: an accepted alternative date must reach the cleaner's view.
// R01: two concurrent publishes (cleaner Finish, operator send_report)
// must yield exactly one publication and one client email.
// P11: a succeeded charge whose paid write fails must surface as
// payment_unconfirmed and be adopted — never re-charged — on retry.
// P03: a dispute older than the 60-event journal window must still
// block the timer via the row flags, even after a customer rebind.
// Shared mocked world, same shape as the cabinet-scenarios harness.

const BID = "bid-residual-1";
const EMAIL = "client@example.com";
const ROW_ID = "22222222-2222-4222-8222-222222222222";
const CLEANER_ID = "roster-ana-1";
const VISIT_DATE = "2027-01-15";
const AUTH = "Bearer " + "adm-" + "secret";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;
type Cust = { id: string; email: string; name: string; pm: string; metadata: Record<string, string> };

let rows: Row[];
let evts: Evt[];
let photos: Row[];
let customers: Cust[];
let piCalls: Array<{ booking: string; version: string; amount: string; id: string; ok: boolean; idemKey?: string; pm?: string }>;
let resendSubjects: string[];
let evSeq: number;
let patchFail: boolean;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function eqFilters(u: URL): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (v.startsWith("eq.")) out.push([k, v.slice(3)]);
  }
  return out;
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of eqFilters(u)) out = out.filter((r) => String(r[k] ?? "") === v);
  for (const [k, v] of u.searchParams.entries()) {
    if (v.startsWith("in.(") && v.endsWith(")")) {
      const set = new Set(v.slice(4, -1).split(","));
      out = out.filter((r) => set.has(String(r[k] ?? "")));
    }
    if (v.startsWith("lt.")) out = out.filter((r) => String(r[k] ?? "") < v.slice(3));
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
      const stateM = q.match(/metadata\['gh_state'\]:'([^']+)'/);
      const found = customers.filter((c) =>
        (bidM ? c.metadata["gh_booking_id"] === bidM[1] : true) &&
        (emailM ? c.email === emailM[1] : true) &&
        (stateM ? c.metadata["gh_state"] === stateM[1] : true),
      );
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
    if (u.pathname === "/v1/payment_intents/search" && method === "GET") {
      const q = u.searchParams.get("query") ?? "";
      const bidM = q.match(/gh_booking_id'\]:'([^']+)'/);
      const data = piCalls
        .filter((p) => (bidM ? p.booking === bidM[1] : true))
        .map((p) => ({
          id: p.id,
          status: p.ok ? "succeeded" : "requires_payment_method",
          amount: Number(p.amount),
          created: 1,
          metadata: { gh_booking_id: p.booking, gh_report_version: p.version },
        }));
      return res(200, { data });
    }
    const confirmM = u.pathname.match(/^\/v1\/payment_intents\/(pi_[^/]+)\/confirm$/);
    if (confirmM && method === "POST") {
      const pi = piCalls.find((p) => p.id === confirmM[1]);
      if (!pi) return res(404, { error: { message: "not found" } });
      const params = parseForm(init?.body);
      pi.pm = params.get("payment_method") ?? pi.pm;
      pi.ok = true;
      return res(200, { id: pi.id, status: "succeeded" });
    }
    const piGetM = u.pathname.match(/^\/v1\/payment_intents\/(pi_[^/]+)$/);
    if (piGetM && method === "GET") {
      const pi = piCalls.find((p) => p.id === piGetM[1]);
      if (!pi) return res(404, { error: { message: "not found" } });
      const cust = customers.find((c) => c.metadata["gh_booking_id"] === pi.booking);
      return res(200, {
        id: pi.id,
        status: pi.ok ? "succeeded" : "requires_payment_method",
        amount: Number(pi.amount),
        currency: "usd",
        customer: cust?.id ?? null,
        metadata: { gh_booking_id: pi.booking, gh_report_version: pi.version },
      });
    }
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      const params = parseForm(init?.body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const idemKey = headers["Idempotency-Key"] ?? headers["idempotency-key"];
      const booking = params.get("metadata[gh_booking_id]") ?? "";
      const version = params.get("metadata[gh_report_version]") ?? "1";
      const amount = params.get("amount") ?? "";
      const pm = params.get("payment_method") ?? "";
      if (idemKey) {
        const prev = piCalls.find((p) => p.idemKey === idemKey);
        if (prev) {
          if (prev.amount === amount && prev.pm === pm) {
            return res(200, { id: prev.id, status: prev.ok ? "succeeded" : "requires_payment_method" });
          }
          return res(400, { error: { message: "Keys for idempotent requests can only be used with the same parameters" } });
        }
      }
      const id = `pi_ok_${piCalls.length + 1}`;
      piCalls.push({ booking, version, amount, id, ok: true, idemKey, pm });
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
    if (u.pathname.includes("/object/sign/")) {
      return res(200, { signedURL: "/signed/test-url" });
    }
    if (u.pathname.includes("/storage/v1/object/")) {
      return res(200, {});
    }
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
      // Fail ONLY the paid write: the claim (status payment_pending)
      // must succeed first, so the test exercises a lost paid-write
      // (RA11) rather than a lost claim.
      if (patchFail && body.status === "paid") return res(500, { error: { message: "db down" } });
      const matched = applyFilters(rows, u);
      for (const target of matched) Object.assign(target, body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const prefer = headers["Prefer"] ?? headers["prefer"] ?? "";
      return res(200, prefer.includes("return=representation") ? matched : {});
    }
    if (method === "DELETE") {
      const doomed = applyFilters(table === "gh_photos" ? photos : rows, u);
      for (const d of doomed) {
        const arr = table === "gh_photos" ? photos : rows;
        arr.splice(arr.indexOf(d), 1);
      }
      return res(200, {});
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

function bt() {
  return signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
}

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
    status: "requested", report_status: "none", amount_cents: 20000,
    visit_date: VISIT_DATE, window: "midday", cleaner_name: null, cleaner_id: null,
    issue_open: false, issue_ever: false, report_bounced: false, report_sent_at: null,
    checklist: null, ...over,
  };
}

function baseCustomer(over: Partial<Record<string, string>> = {}): Cust {
  return {
    id: "cus_residual_1", email: EMAIL, name: "Casey Client", pm: "pm_residual_1",
    metadata: {
      gh_booking_id: BID, gh_state: "card_ready", gh_payment_method: "pm_residual_1",
      gh_first_price_cents: "20000", ...over,
    },
  };
}

function basePhotos(): Row[] {
  return [
    { id: "ph1", visit_id: ROW_ID, room: "Kitchen", kind: "after", storage_path: "r/kitchen-after.jpg" },
    { id: "ph2", visit_id: ROW_ID, room: "Bathrooms", kind: "after", storage_path: "r/bath-after.jpg" },
  ];
}

function checklist() {
  return {
    rooms: [
      { name: "Kitchen", items: [{ label: "Wipe counters", done: true }] },
      { name: "Bathrooms", items: [{ label: "Scrub sink", done: true }] },
    ],
  };
}

function confirmedWorld() {
  rows = [baseRow({ status: "confirmed", cleaner_name: "Ana Torres", cleaner_id: CLEANER_ID })];
  const issuance = "bb".repeat(16);
  const token = mintCleanerLinkV2("test-cleaner-secret-123", ROW_ID, issuance);
  rows[0]["cleaner_token_hash"] = hashToken(token);
  rows[0]["cleaner_link_version"] = "v2";
  rows[0]["cleaner_link_issuance"] = issuance;
  evts = [
    { visit_id: ROW_ID, booking_id: BID, event: "visit_confirmed", detail: {}, created_at: new Date(Date.now() - 60000).toISOString() },
  ];
  photos = basePhotos();
  customers = [baseCustomer()];
  return token;
}

function sentWorld() {
  const token = confirmedWorld();
  rows[0]["status"] = "report_sent";
  rows[0]["report_status"] = "sent";
  rows[0]["report_sent_at"] = new Date().toISOString();
  rows[0]["checklist"] = checklist();
  customers[0].metadata = {
    ...customers[0].metadata,
    gh_state: "report_sent",
    gh_report_sent_at: new Date().toISOString(),
    gh_report_version: "1",
    gh_report_amount_cents: "20000",
  };
  evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: new Date().toISOString() });
  return token;
}

async function call(handler: (req: unknown, res: unknown) => Promise<void> | void, req: Record<string, unknown>) {
  const r = response();
  await handler(req, r as never);
  return r;
}

const BA = (body: Record<string, unknown>) =>
  call(bookingAction, { method: "POST", body, headers: { authorization: AUTH, origin: "https://www.gatehousehomecleaning.com" } });
const CL = (body: Record<string, unknown>) =>
  call(cleanerHandler, { method: "POST", headers: {}, body });
const RP = (body: Record<string, unknown>) =>
  call(reportHandler, { method: "POST", headers: {}, body: { bt: bt(), ...body } });
const VS = (body: Record<string, unknown>) =>
  call(visitHandler, { method: "POST", headers: {}, body: { bt: bt(), ...body } });
const CLGET = (ct: string) =>
  call(cleanerHandler, { method: "GET", headers: {}, query: { ct } });
const AUTO = () =>
  call(autoChargeHandler, { method: "GET", headers: { authorization: AUTH } });

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
  rows = []; evts = []; photos = []; customers = [];
  piCalls = []; resendSubjects = []; evSeq = 0; patchFail = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const PHOTOS = [
  "https://cdn.example.com/report/kitchen.jpg",
  "https://cdn.example.com/report/bath.jpg",
  "https://cdn.example.com/report/living.jpg",
];

describe("GPT-17 residuals", () => {
  it("P06: approve on a cancelled visit is rejected, no charge", async () => {
    sentWorld();
    rows[0]["status"] = "cancelled";
    const r = await RP({ action: "approve" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("visit_not_chargeable");
    expect(piCalls).toHaveLength(0);
  });

  it("P06: approve on a returned report is rejected, no charge", async () => {
    sentWorld();
    rows[0]["report_status"] = "returned";
    evts.push({ visit_id: ROW_ID, booking_id: BID, event: "report_returned", detail: {}, created_at: new Date(Date.now() + 1000).toISOString() });
    const r = await RP({ action: "approve" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_not_current");
    expect(piCalls).toHaveLength(0);
  });

  it("P06: approve on a merely submitted (unpublished) report is rejected", async () => {
    // v1 was sent (meta keeps its sent_at), the report is back in
    // "submitted" after a return + held resubmit: no fresh publication
    // exists to approve, so the row gate — not the old meta — decides.
    sentWorld();
    rows[0]["report_status"] = "submitted";
    const r = await RP({ action: "approve" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_not_current");
    expect(piCalls).toHaveLength(0);
  });

  it("S01: an accepted alternative date reaches the cleaner's view", async () => {
    const ct = confirmedWorld();
    evts.push({
      visit_id: ROW_ID, booking_id: BID, event: "date_proposed",
      detail: { alt_dates: "2027-02-10,2027-02-11" },
      created_at: new Date().toISOString(),
    });
    const accepted = await VS({ action: "accept_alt_date", date: "2027-02-10" });
    expect(accepted.code).toBe(200);
    expect(rows[0]["visit_date"]).toBe("2027-02-10");
    const view = await CLGET(ct);
    expect(view.code).toBe(200);
    expect((view.body["visit"] as Record<string, unknown>)["date"]).toBe("2027-02-10");
  });

  it("R01: two concurrent cleaner Finishes publish exactly once", async () => {
    const ct = confirmedWorld();
    const [a, b] = await Promise.all([
      CL({ ct, action: "submit", checklist: checklist() }),
      CL({ ct, action: "submit", checklist: checklist() }),
    ]);
    const published = [a, b].filter((r) => r.body["published"] === true);
    const already = [a, b].filter((r) => r.body["already"] === true);
    expect(published).toHaveLength(1);
    expect(already).toHaveLength(1);
    expect(evts.filter((e) => e.event === "report_sent")).toHaveLength(1);
    expect(rows[0]["report_status"]).toBe("sent");
  });

  it("R01: two concurrent operator send_reports publish exactly once", async () => {
    confirmedWorld();
    rows[0]["report_status"] = "submitted";
    rows[0]["checklist"] = checklist();
    photos = basePhotos();
    customers[0].metadata = { ...customers[0].metadata, gh_state: "confirmed" };
    const [a, b] = await Promise.all([
      BA({ action: "send_report", booking_id: BID, photos: PHOTOS }),
      BA({ action: "send_report", booking_id: BID, photos: PHOTOS }),
    ]);
    const winner = [a, b].find((r) => r.body["already_sent"] !== true);
    const loser = [a, b].find((r) => r.body["already_sent"] === true);
    expect(winner).toBeTruthy();
    expect(winner?.body["email_sent"]).toBe(true);
    expect(loser).toBeTruthy();
    expect(evts.filter((e) => e.event === "report_sent")).toHaveLength(1);
    expect(rows[0]["report_status"]).toBe("sent");
  });

  it("P11: a paid write failure surfaces as payment_unconfirmed, retry adopts", async () => {
    sentWorld();
    patchFail = true;
    const first = await RP({ action: "approve", seen_publication_id: rows[0]["report_sent_at"] });
    expect(first.code).toBe(502);
    expect(first.body["error"]).toBe("payment_unconfirmed");
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    // RA11: the claim is HELD after an unconfirmed paid-write, so the
    // retry adopts the same intent instead of racing a fresh claim.
    expect(rows[0]["status"]).toBe("payment_pending");
    patchFail = false;
    const second = await RP({ action: "approve", seen_publication_id: rows[0]["report_sent_at"] });
    expect(second.code).toBe(200);
    expect(second.body["state"]).toBe("paid");
    expect(piCalls).toHaveLength(1);
    expect(rows[0]["status"]).toBe("paid");
  });

  it("P03: a dispute older than the 60-event window still blocks the timer", async () => {
    // The customer record was rebound to another booking (meta no
    // longer shows the dispute), and the dispute events fell out of
    // the 60-event journal window. The row flags are the durable
    // truth: hydration must restore gh_issue_ever and the timer
    // must not charge.
    const now = Date.now();
    const base = now - 48 * 3600 * 1000;
    rows = [baseRow({
      status: "report_sent", report_status: "sent",
      report_sent_at: new Date(now - 30 * 3600 * 1000).toISOString(),
      issue_open: false, issue_ever: true,
    })];
    customers = [baseCustomer({ gh_booking_id: "bid-other", gh_state: "card_ready" })];
    evts = [
      { visit_id: ROW_ID, booking_id: BID, event: "issue_opened", detail: { reason: "old" }, created_at: new Date(base - 2 * 3600 * 1000).toISOString() },
      { visit_id: ROW_ID, booking_id: BID, event: "issue_resolved", detail: {}, created_at: new Date(base - 3600 * 1000).toISOString() },
      ...Array.from({ length: 61 }, (_, i) => ({
        visit_id: ROW_ID, booking_id: BID, event: "note", detail: {},
        created_at: new Date(base + i * 60000).toISOString(),
      })),
    ];
    photos = [];
    const run = await AUTO();
    expect(run.body["ok"]).toBe(true);
    expect(run.body["charged"]).toBe(0);
    expect(piCalls).toHaveLength(0);
    expect(customers[0].metadata["gh_issue_ever"]).toBe("1");
  });
});
