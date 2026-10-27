// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";
import cleanerHandler from "../../api/cleaner";
import reportHandler from "../../api/report";
import visitHandler from "../../api/visit";
import { signBooking } from "../../api/create-checkout-session";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";

// End-to-end cabinet scenarios on ONE shared mocked world (Stripe customers
// + Supabase rows + gh_events journal), so the chain is tested as a chain:
// owner approve -> assign & confirm -> cleaner finish -> auto-publish ->
// client approve -> paid, plus the fix-flow, payment retry and bounce paths.
// Branch cases already covered by focused unit tests (G1/G2/G4, decline+alt,
// propose-pending, same-name rotation) are NOT duplicated here.

const BID = "bid-scenario-1";
const EMAIL = "client@example.com";
const ROW_ID = "11111111-1111-4111-8111-111111111111";
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
let piFailNext: boolean;
let resendFail: boolean;
let resendSubjects: string[];
let evSeq: number;

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
  // PostgREST in.(...) filters, used by compare-and-swap updates.
  for (const [k, v] of u.searchParams.entries()) {
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
      const emailM = q.match(/email:'([^']+)'/);
      const found = customers.filter((c) =>
        (bidM ? c.metadata["gh_booking_id"] === bidM[1] : true) &&
        (emailM ? c.email === emailM[1] : true),
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
      // Strict Stripe search emulation: the intents created so far for
      // this booking, with the metadata the product reconciles on.
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
      // Strict Stripe idempotency: the same key replays the stored
      // result for the same parameters; different parameters under one
      // key is an error, not a second charge.
      if (idemKey) {
        const prev = piCalls.find((p) => p.idemKey === idemKey);
        if (prev) {
          if (prev.amount === amount && prev.pm === pm) {
            return res(200, { id: prev.id, status: prev.ok ? "succeeded" : "requires_payment_method" });
          }
          return res(400, { error: { message: "Keys for idempotent requests can only be used with the same parameters" } });
        }
      }
      if (piFailNext) {
        piFailNext = false;
        piCalls.push({ booking, version, amount, id: "pi_fail_1", ok: false, idemKey, pm });
        return res(200, { id: "pi_fail_1", status: "requires_payment_method" });
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
    if (resendFail) return res(500, { error: "resend down" });
    return res(200, { id: `email_${resendSubjects.length}` });
  }

  if (host.includes("supabase")) {
    const table = u.pathname.split("/").pop() ?? "";
    if (method === "GET") {
      if (table === "gh_visits") return res(200, applyFilters(rows, u));
      if (table === "gh_events") return res(200, applyFilters(evts, u));
      if (table === "gh_photos") return res(200, applyFilters(photos, u));
      if (table === "gh_cleaners") {
        const roster = [{ id: CLEANER_ID, name: "Ana Torres", active: true, phone: "+1 404 555 0100" }];
        return res(200, applyFilters(roster as Row[], u));
      }
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
      const matched = applyFilters(rows, u);
      for (const target of matched) Object.assign(target, body);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const prefer = headers["Prefer"] ?? headers["prefer"] ?? "";
      // PostgREST: return=representation yields the updated rows array;
      // return=minimal yields an empty body.
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
    id: "cus_scenario_1", email: EMAIL, name: "Casey Client", pm: "pm_scenario_1",
    metadata: {
      gh_booking_id: BID, gh_state: "card_ready", gh_payment_method: "pm_scenario_1",
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
  const issuance = "aa".repeat(16);
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
const RPGET = () => call(reportHandler, { method: "GET", headers: {}, query: { bt: bt() } });
const VSGET = () => call(visitHandler, { method: "GET", headers: {}, query: { bt: bt() } });

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
  piCalls = []; piFailNext = false; resendFail = false; resendSubjects = []; evSeq = 0;
  vi.stubGlobal("fetch", vi.fn(fetchMock));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("full cabinet chain", () => {
  it("request -> approve -> assign & confirm -> cleaner finish -> publish -> client approve -> paid, no double charge", async () => {
    rows = [baseRow()];
    evts = [];
    photos = basePhotos();
    customers = [baseCustomer()];

    const approved = await BA({ action: "approve_request", booking_id: BID });
    expect(approved.code).toBe(200);
    expect(approved.body.request_approved).toBe(true);

    const assigned = await BA({
      action: "assign_confirm", booking_id: BID,
      cleaner_id: CLEANER_ID, confirmed_date: VISIT_DATE, confirmed_window: "midday",
    });
    expect(assigned.code).toBe(200);
    expect(rows[0]["status"]).toBe("confirmed");
    expect(rows[0]["cleaner_id"]).toBe(CLEANER_ID);
    const ct = String((assigned.body as Record<string, unknown>)["url"] ?? "").split("ct=")[1] ?? "";
    expect(ct.length).toBeGreaterThan(10);

    const submitted = await CL({ ct, action: "submit", checklist: checklist() });
    expect(submitted.code).toBe(200);
    expect(submitted.body.published).toBe(true);
    expect(submitted.body.email_sent).toBe(true);
    expect(rows[0]["report_status"]).toBe("sent");
    expect(rows[0]["report_sent_at"]).toBeTruthy();

    const repBefore = await RPGET();
    expect(repBefore.body.state).toBe("awaiting");
    expect(repBefore.body.amount_cents).toBe(20000);
    const visBefore = await VSGET();
    expect(visBefore.body.state).toBe("report_sent");

    const paid = await RP({ action: "approve", seen_publication_id: repBefore.body.publication_id });
    expect(paid.code).toBe(200);
    expect(paid.body.state).toBe("paid");
    expect(paid.body.receipt_sent).toBe(true);
    expect(rows[0]["status"]).toBe("paid");
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(piCalls.filter((p) => p.ok)[0].amount).toBe("20000");

    const visAfter = await VSGET();
    expect(visAfter.body.state).toBe("paid");

    const again = await RP({ action: "approve" });
    expect(again.code).toBe(409);
    expect(again.body.error).toBe("already_paid");
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
  });

  it("issue -> owner return -> resolve -> cleaner resubmit -> republish -> client approve pays the pinned price", async () => {
    const ct = sentWorld();

    const issued = await RP({ action: "issue", reason: "Kitchen floor not mopped" });
    expect(issued.code).toBe(200);
    expect(issued.body.state).toBe("issue_open");
    expect(rows[0]["issue_open"]).toBe(true);

    const returned = await BA({ action: "return_report", booking_id: BID, note: "Fix the floor, please" });
    expect(returned.code).toBe(200);
    expect(rows[0]["report_status"]).toBe("returned");
    expect(rows[0]["report_sent_at"]).toBeTruthy();

    const resolved = await BA({ action: "resolve", booking_id: BID });
    expect(resolved.code).toBe(200);
    expect(rows[0]["issue_open"]).toBe(false);
    expect(customers[0].metadata["gh_issue_open"]).not.toBe("1");

    const resubmitted = await CL({ ct, action: "submit", checklist: checklist() });
    expect(resubmitted.code).toBe(200);
    expect(resubmitted.body.published).toBe(true);
    expect(customers[0].metadata["gh_report_version"]).toBe("2");

    const rep = await RPGET();
    expect(rep.body.state).toBe("awaiting");
    expect(rep.body.amount_cents).toBe(20000);

    const paid = await RP({ action: "approve", seen_publication_id: rep.body.publication_id });
    expect(paid.code).toBe(200);
    expect(paid.body.state).toBe("paid");
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(piCalls.filter((p) => p.ok)[0].amount).toBe("20000");
  });

  it("payment failure -> retry with the same pinned price succeeds, no duplicate intent", async () => {
    sentWorld();
    piFailNext = true;

    const repBefore = await RPGET();
    const failed = await RP({ action: "approve", seen_publication_id: repBefore.body.publication_id });
    expect(failed.code).toBe(402);
    expect(failed.body.error).toBe("payment_failed");

    const rep = await RPGET();
    expect(rep.body.state).toBe("payment_issue");

    const paid = await RP({ action: "approve", seen_publication_id: rep.body.publication_id });
    expect(paid.code).toBe(200);
    expect(paid.body.state).toBe("paid");
    expect(piCalls.filter((p) => p.ok)).toHaveLength(1);
    expect(piCalls.filter((p) => p.ok)[0].amount).toBe("20000");
  });

  it("P05: decline -> card change -> retry confirms the live intent, no second charge", async () => {
    sentWorld();
    piFailNext = true;

    const repBefore = await RPGET();
    const failed = await RP({ action: "approve", seen_publication_id: repBefore.body.publication_id });
    expect(failed.code).toBe(402);
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].ok).toBe(false);

    // The client replaces the declined card, then retries. A naive
    // re-create under the same idempotency key with a different
    // payment method would fail Stripe's parameter check — the retry
    // must confirm the live intent with the new card instead.
    customers[0].metadata["gh_payment_method"] = "pm_scenario_2";
    const paid = await RP({ action: "approve", seen_publication_id: repBefore.body.publication_id });
    expect(paid.code).toBe(200);
    expect(paid.body.state).toBe("paid");
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0].ok).toBe(true);
    expect(piCalls[0].pm).toBe("pm_scenario_2");
    expect(piCalls[0].amount).toBe("20000");
  });

  it("email bounce -> report marked bounced, client sees delivery failure, clock flags set", async () => {
    const ct = confirmedWorld();
    resendFail = true;

    const submitted = await CL({ ct, action: "submit", checklist: checklist() });
    expect(submitted.code).toBe(200);
    expect(submitted.body.published).toBe(true);
    expect(submitted.body.email_sent).toBe(false);
    expect(rows[0]["report_bounced"]).toBe(true);
    expect(customers[0].metadata["gh_report_bounced"]).toBe("1");

    const rep = await RPGET();
    expect(rep.body.delivery_failed).toBe(true);
  });

  it("cancelled visit is read-only for the cleaner", async () => {
    const ct = confirmedWorld();
    rows[0]["status"] = "cancelled";
    const r = response();
    await cleanerHandler({ method: "GET", headers: {}, query: { ct } }, r as never);
    expect(r.body.cancelled).toBe(true);
    expect(r.body.editable).toBe(false);
  });
});
