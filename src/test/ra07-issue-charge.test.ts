// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import reportHandler from "../../api/report";
import visitHandler from "../../api/visit";
import bookingAction from "../../api/booking-action";
import { signBooking } from "../../api/create-checkout-session";

// RA07: an issue racing a charge. The claim is the boundary: a charge
// that already claimed (row payment_pending) may still complete, but
// the issue stays open and the client must NOT be promised a pause —
// the email subject says so. An issue that lands first blocks the
// charge outright (claim CAS sees issue_open).

const BID = "bid-ra07-1";
const EMAIL = "client@example.com";
const ROW_ID = "88888888-8888-4888-8888-888888888888";
const AUTH = "Bearer " + "adm-" + "secret";

type Row = Record<string, unknown>;
type Evt = Record<string, unknown>;
type Cust = { id: string; email: string; name: string; pm: string; metadata: Record<string, string> };

let rows: Row[];
let evts: Evt[];
let customers: Cust[];
let piCalls: Array<{ booking: string; version: string; amount: string; id: string; ok: boolean; idemKey?: string; pm?: string }>;
let resendSubjects: string[];
let evSeq: number;
let blockPiCreate: Promise<void> | null;
let piCreateReached: boolean;
let piCreateParkedOnce: boolean;

function res(code: number, body: unknown) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
}

function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
  let out = [...list];
  for (const [k, v] of u.searchParams.entries()) {
    if (k === "order" || k === "limit" || k === "select") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    if (v.startsWith("neq.")) out = out.filter((r) => r[k] !== null && r[k] !== undefined && String(r[k]) !== decodeURIComponent(v.slice(4)));
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
    if (u.pathname === "/v1/payment_intents/search" && method === "GET") {
      const q = u.searchParams.get("query") ?? "";
      const bidM = q.match(/gh_booking_id'\]:'([^']+)'/);
      const data = piCalls
        .filter((p) => (bidM ? p.booking === bidM[1] : true))
        .map((p) => ({
          id: p.id, status: p.ok ? "succeeded" : "requires_payment_method",
          amount: Number(p.amount), created: 1,
          metadata: { gh_booking_id: p.booking, gh_report_version: p.version },
        }));
      return res(200, { data });
    }
    const confirmM = u.pathname.match(/^\/v1\/payment_intents\/(pi_[^/]+)\/confirm$/);
    if (confirmM && method === "POST") {
      const pi = piCalls.find((p) => p.id === confirmM[1]);
      if (!pi) return res(404, { error: { message: "not found" } });
      pi.ok = true;
      return res(200, { id: pi.id, status: "succeeded" });
    }
    const piGetM = u.pathname.match(/^\/v1\/payment_intents\/(pi_[^/]+)$/);
    if (piGetM && method === "GET") {
      const pi = piCalls.find((p) => p.id === piGetM[1]);
      if (!pi) return res(404, { error: { message: "not found" } });
      const cust = customers.find((c) => c.metadata["gh_booking_id"] === pi.booking);
      return res(200, {
        id: pi.id, status: pi.ok ? "succeeded" : "requires_payment_method",
        amount: Number(pi.amount), currency: "usd", customer: cust?.id ?? null,
        metadata: { gh_booking_id: pi.booking, gh_report_version: pi.version },
      });
    }
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      if (blockPiCreate && !piCreateParkedOnce) {
        piCreateParkedOnce = true;
        piCreateReached = true;
        await blockPiCreate;
      }
      const params = parseForm(init?.body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const idemKey = headers["Idempotency-Key"] ?? headers["idempotency-key"];
      const booking = params.get("metadata[gh_booking_id]") ?? "";
      const version = params.get("metadata[gh_report_version]") ?? "1";
      const amount = params.get("amount") ?? "";
      const pm = params.get("payment_method") ?? "";
      if (idemKey) {
        const prev = piCalls.find((p) => p.idemKey === idemKey);
        if (prev) return res(200, { id: prev.id, status: prev.ok ? "succeeded" : "requires_payment_method" });
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
        const inserted = { ...body, created_at: new Date(Date.now() + evSeq).toISOString() };
        evts.push(inserted);
        return res(201, [inserted]);
      }
      return res(201, [body]);
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

function sentWorld() {
  const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
  rows = [{
    id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
    status: "report_sent", report_status: "sent", amount_cents: 20000,
    visit_date: "2027-01-15", window: "midday",
    issue_open: false, issue_ever: false, report_bounced: false,
    report_sent_at: sentAt, receipt_email_id: null,
  }];
  customers = [{
    id: "cus_ra07_1", email: EMAIL, name: "Casey Client", pm: "pm_ra07_1",
    metadata: {
      gh_booking_id: BID, gh_state: "report_sent", gh_payment_method: "pm_ra07_1",
      gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
      gh_report_version: "1", gh_report_amount_cents: "20000",
    },
  }];
  evts = [
    { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
  ];
  return sentAt;
}

async function waitFor(flag: () => boolean, label: string) {
  for (let i = 0; i < 200 && !flag(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(flag()).toBe(true);
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
  rows = []; evts = []; customers = [];
  piCalls = []; resendSubjects = []; evSeq = 0;
  blockPiCreate = null; piCreateReached = false; piCreateParkedOnce = false;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("RA07 issue vs charge barrier", () => {
  it("charge claimed, then issue: charge completes, dispute stays open, no paused promise", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    let release!: () => void;
    blockPiCreate = new Promise<void>((r) => { release = r; });
    const approveP = call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    await waitFor(() => piCreateReached, "charge parked at PI creation");
    expect(rows[0]["status"]).toBe("payment_pending");
    const issue = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "issue", room: "Kitchen", reason: "Missed spot" },
    });
    expect(issue.code).toBe(200);
    expect(issue.body["payment_in_flight"]).toBe(true);
    expect(rows[0]["issue_open"]).toBe(true);
    expect(rows[0]["issue_ever"]).toBe(true);
    // Honest subject: no "paused" promise for an in-flight payment.
    expect(resendSubjects).toContain("We received your report — a payment was already in progress");
    expect(resendSubjects).not.toContain("We received your report — the charge is paused");
    release();
    const approve = await approveP;
    expect(approve.code).toBe(200);
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(rows[0]["status"]).toBe("paid");
    // The dispute is NOT cleared by the completed payment.
    expect(rows[0]["issue_open"]).toBe(true);
    expect(evts.some((e) => e.event === "issue_opened")).toBe(true);
    expect(evts.some((e) => e.event === "payment_succeeded")).toBe(true);
  });

  it("issue first: a non-resolving charge is blocked outright, no intent created", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const issue = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "issue", room: "Kitchen", reason: "Missed spot" },
    });
    expect(issue.code).toBe(200);
    // Not in flight: the field is absent (only the in-flight
    // response carries payment_in_flight: true).
    expect(issue.body["payment_in_flight"]).toBeUndefined();
    expect(resendSubjects).toContain("We received your report — the charge is paused");
    // An owner charge is NOT the client's resolve-and-pay consent:
    // the open dispute blocks it outright, creates no intent, and
    // leaves the dispute open.
    const charge = await call(bookingAction, {
      method: "POST",
      headers: { authorization: AUTH, origin: "https://www.gatehousehomecleaning.com" },
      body: { action: "charge", booking_id: BID, amount_cents: 20000 },
    });
    expect(charge.code).toBe(409);
    expect(charge.body["error"]).toBe("issue_open");
    expect(piCalls).toHaveLength(0);
    expect(rows[0]["status"]).toBe("report_sent");
    expect(rows[0]["issue_open"]).toBe(true);
  });

  it("issue first, then client Approve: N05 resolve-and-pay resolves the dispute and charges once", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    const issue = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "issue", room: "Kitchen", reason: "Missed spot" },
    });
    expect(issue.code).toBe(200);
    const approve = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    expect(approve.code).toBe(200);
    expect(approve.body["state"]).toBe("paid");
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(rows[0]["status"]).toBe("paid");
    expect(rows[0]["issue_open"]).toBe(false);
    // issue_ever stays true: the timer never returns for this visit.
    expect(rows[0]["issue_ever"]).toBe(true);
    expect(evts.some((e) => e.event === "issue_resolved" && (e.detail as Record<string, unknown>)?.["via"] === "client_resolve_and_pay")).toBe(true);
  });

  it("two concurrent Approves charge exactly once (idempotent key + paid-write CAS)", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    let release!: () => void;
    blockPiCreate = new Promise<void>((r) => { release = r; });
    const firstP = call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    await waitFor(() => piCreateReached, "first charge parked at PI creation");
    // The second Approve finds the claim held, reconciles (no intent
    // exists yet), releases the stale claim, claims fresh, and pays.
    const second = await call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    expect(second.code).toBe(200);
    release();
    const first = await firstP;
    expect(first.code).toBe(200);
    // One intent: the second create replays the first one's key.
    expect(piCalls).toHaveLength(1);
    expect(rows[0]["status"]).toBe("paid");
    expect(evts.filter((e) => e.event === "payment_succeeded")).toHaveLength(1);
    // One receipt: the adopted path reuses the winner's marker.
    expect(resendSubjects.filter((s) => s.startsWith("Your Gatehouse receipt"))).toHaveLength(1);
  });

  it("re-send during an in-flight charge is refused, the charge completes on v1", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    let release!: () => void;
    blockPiCreate = new Promise<void>((r) => { release = r; });
    const approveP = call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    await waitFor(() => piCreateReached, "charge parked at PI creation");
    expect(rows[0]["status"]).toBe("payment_pending");
    const send = await call(bookingAction, {
      method: "POST",
      headers: { authorization: AUTH, origin: "https://www.gatehousehomecleaning.com" },
      body: {
        action: "send_report", booking_id: BID,
        photos: ["https://cdn.example.com/report/kitchen.jpg"],
      },
    });
    expect(send.code).toBe(409);
    expect(send.body["error"]).toBe("payment_in_flight");
    // No new publication: the sent time and the event journal are
    // untouched by the refused re-send.
    expect(rows[0]["report_sent_at"]).toBe(sentAt);
    expect(evts.filter((e) => e.event === "report_sent")).toHaveLength(1);
    release();
    const approve = await approveP;
    expect(approve.code).toBe(200);
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(rows[0]["status"]).toBe("paid");
  });

  it("two concurrent owner charges charge exactly once", async () => {
    // Timer basis: the publication is 30h old (an owner charge with
    // no client approval needs the 24h rule).
    const sentAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    rows = [{
      id: ROW_ID, booking_id: BID, client_email: EMAIL, client_name: "Casey Client",
      status: "report_sent", report_status: "sent", amount_cents: 20000,
      visit_date: "2027-01-15", window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, receipt_email_id: null,
    }];
    customers = [{
      id: "cus_ra07_1", email: EMAIL, name: "Casey Client", pm: "pm_ra07_1",
      metadata: {
        gh_booking_id: BID, gh_state: "report_sent", gh_payment_method: "pm_ra07_1",
        gh_first_price_cents: "20000", gh_report_sent_at: sentAt,
        gh_report_version: "1", gh_report_amount_cents: "20000",
      },
    }];
    evts = [
      { visit_id: ROW_ID, booking_id: BID, event: "report_sent", detail: { version: 1 }, created_at: sentAt },
    ];
    let release!: () => void;
    blockPiCreate = new Promise<void>((r) => { release = r; });
    const chargeBody = {
      action: "charge", booking_id: BID, amount_cents: 20000,
    };
    const chargeHeaders = { authorization: AUTH, origin: "https://www.gatehousehomecleaning.com" };
    const firstP = call(bookingAction, { method: "POST", headers: chargeHeaders, body: chargeBody });
    await waitFor(() => piCreateReached, "first charge parked at PI creation");
    const second = await call(bookingAction, { method: "POST", headers: chargeHeaders, body: chargeBody });
    expect(second.code).toBe(200);
    release();
    const first = await firstP;
    expect(first.code).toBe(200);
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(rows[0]["status"]).toBe("paid");
  });

  it("cancel during an in-flight charge is refused, the charge completes", async () => {
    const sentAt = sentWorld();
    const bt = signBooking("link-secret", { bid: BID, email: EMAIL, name: "Casey Client" }).token;
    let release!: () => void;
    blockPiCreate = new Promise<void>((r) => { release = r; });
    const approveP = call(reportHandler, {
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    });
    await waitFor(() => piCreateReached, "charge parked at PI creation");
    // The visit is already sent (and the charge claimed): cancel is
    // refused outright — there is no cancel/charge interleaving.
    const cancel = await call(visitHandler, {
      method: "POST", headers: {},
      body: { bt, action: "cancel", scope: "once" },
    });
    expect(cancel.code).toBe(409);
    expect(cancel.body["error"]).toBe("visit_already_done");
    expect(rows[0]["status"]).toBe("payment_pending");
    release();
    const approve = await approveP;
    expect(approve.code).toBe(200);
    expect(rows[0]["status"]).toBe("paid");
  });
});
