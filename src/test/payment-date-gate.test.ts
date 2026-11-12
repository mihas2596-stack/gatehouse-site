// @vitest-environment node
// Payment-date gate (B): a visit may be reported and approved/paid on or
// after its date, never before. The gate compares the visit date with
// "today" in America/New_York as YYYY-MM-DD strings.
// - cleaner submit before the date -> 400 report_too_early
// - client Approve before the date -> 409 report_too_early
// - submit / Approve on the date itself -> allowed (past the gate)
// - submit / Approve after the date -> allowed (past the gate)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashToken } from "../../api/_db";
import cleanerHandler, { isFutureVisitDate as cleanerIsFuture } from "../../api/cleaner";
import reportHandler, { isFutureVisitDate as reportIsFuture } from "../../api/report";
import { signBooking } from "../../api/create-checkout-session";
import { chargeVisit } from "../../api/_payment_obligation";
import { selectDue } from "../../api/auto-charge";
import bookingAction from "../../api/booking-action";

// "Today" in Atlanta time when this test runs. The fixtures use dates
// relative to it so the gate outcome is stable no matter when the suite
// runs: a date 30 days out is always future, 30 days back always past.
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
const TODAY = atlantaToday();
const FUTURE = shiftDate(TODAY, 30);
const PAST = shiftDate(TODAY, -30);

describe("isFutureVisitDate (pure)", () => {
  it("a future date is future, today and past are not", () => {
    for (const fn of [cleanerIsFuture, reportIsFuture]) {
      expect(fn(FUTURE)).toBe(true);
      expect(fn(TODAY)).toBe(false);
      expect(fn(PAST)).toBe(false);
    }
  });
  it("a missing or malformed date never blocks", () => {
    for (const fn of [cleanerIsFuture, reportIsFuture]) {
      expect(fn(null)).toBe(false);
      expect(fn(undefined)).toBe(false);
      expect(fn("")).toBe(false);
      expect(fn("not-a-date")).toBe(false);
    }
  });
});

// ---------- cleaner submit gate ----------

const BID = "bid-date-gate";
const VISIT_ID = "44444444-5555-6666-7777-888888888888";
const CLEANER_TOKEN = "ct-date-gate-token-01";

type Row = Record<string, unknown>;

function cleanResponse() {
  const r = {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  return r;
}

describe("cleaner submit date gate", () => {
  let row: Row;
  let events: Row[];
  let photos: Row[];

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const supRes = (data: unknown, status = 200) => ({
        ok: status >= 200 && status < 300, status,
        json: async () => data,
        text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
      });
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "GET") return supRes([row]);
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          Object.assign(row, patch);
          return supRes([row]);
        }
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "GET") {
          // visit_confirmed lookup: the submit requires a confirmed visit.
          if (u.includes("event=eq.visit_confirmed")) return supRes([{ id: 1 }]);
          return supRes(events);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          events.push(body);
          return supRes([body], 201);
        }
      }
      if (u.includes("/rest/v1/gh_photos")) return supRes(photos);
      if (u.includes("api.resend.com")) return supRes({ id: "email-1" });
      if (u.includes("api.stripe.com")) return supRes({ id: "cus_x", metadata: {} });
      if (u.includes("/storage/v1/object/sign/")) return supRes({ signedURL: "/object/sign/x.jpg?token=t" });
      return supRes(null, 404);
    }));
  };

  const submit = async (visitDate: string) => {
    row.visit_date = visitDate;
    const r = cleanResponse();
    await cleanerHandler({
      method: "POST", headers: {},
      body: {
        ct: CLEANER_TOKEN, action: "submit",
        checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
      },
    }, r as never);
    return r;
  };

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    events = [];
    photos = [];
    row = {
      id: VISIT_ID, booking_id: BID, visit_no: 1,
      status: "confirmed", report_status: "draft",
      visit_date: PAST, window: "morning", service: "Standard cleaning",
      client_name: "Casey Client", client_email: "client@example.com",
      client_phone: null, amount_cents: 14900,
      cleaner_name: "Ana Torres", cleaner_id: "roster-1",
      cleaner_token_hash: hashToken(CLEANER_TOKEN),
      cleaner_token_expires: new Date(Date.now() + 86400 * 1000).toISOString(),
      cleaner_link_version: 2, cleaner_link_issuance: null,
      cleaner_profile: null, issue_open: false, issue_ever: false,
      checklist: { rooms: [{ name: "Kitchen", items: [{ label: "Counters wiped", done: false }] }] },
      no_photo_zones: null,
    };
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("submit before the visit date is rejected with report_too_early", async () => {
    const r = await submit(FUTURE);
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE);
    expect(row["report_status"]).toBe("draft");
  });

  it("submit on the visit date passes the gate (fails later on photos, not the date)", async () => {
    const r = await submit(TODAY);
    expect(r.body["error"]).not.toBe("report_too_early");
    // The fixture has no photos, so the submit stops at rooms_incomplete —
    // which proves the date gate let it through.
    expect(r.body["error"]).toBe("rooms_incomplete");
  });

  it("submit after the visit date passes the gate", async () => {
    const r = await submit(PAST);
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.body["error"]).toBe("rooms_incomplete");
  });
});

// ---------- report Approve gate ----------

const RBID = "bid-report-date-gate";
const ROW_ID = "99999999-8888-4777-6666-555555555555";
const EMAIL = "client@example.com";

describe("report Approve date gate", () => {
  let rows: Row[];
  let evts: Row[];
  let piCalls: number;

  function res(code: number, body: unknown) {
    return { ok: code >= 200 && code < 300, status: code, json: async () => body, text: async () => JSON.stringify(body) };
  }
  function applyFilters<T extends Record<string, unknown>>(list: T[], u: URL): T[] {
    let out = [...list];
    for (const [k, v] of u.searchParams.entries()) {
      if (k === "order" || k === "limit" || k === "select") continue;
      if (v.startsWith("eq.")) out = out.filter((r) => String(r[k] ?? "") === decodeURIComponent(v.slice(3)));
    }
    const limit = u.searchParams.get("limit");
    if (limit) out = out.slice(0, parseInt(limit, 10));
    return out;
  }
  async function fetchMock(url: string, init?: { method?: string; body?: unknown }) {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const host = u.hostname;
    if (host === "api.stripe.com") {
      if (u.pathname.includes("/customers/search")) return res(200, { data: [{ id: "cus_gate", email: EMAIL, name: "Casey", metadata: { gh_booking_id: RBID } }] });
      if (u.pathname.match(/^\/v1\/customers\/[^/]+\/payment_methods$/)) return res(200, { data: [{ id: "pm_1", card: { brand: "visa", last4: "4242" } }] });
      if (u.pathname.match(/^\/v1\/customers\/[^/]+$/)) return res(200, { id: "cus_gate", email: EMAIL, name: "Casey", metadata: { gh_booking_id: RBID, gh_state: "report_sent" } });
      if (u.pathname === "/v1/payment_intents/search") return res(200, { data: [] });
      if (u.pathname === "/v1/payment_intents" && method === "POST") { piCalls++; return res(200, { id: `pi_gate_${piCalls}`, status: "succeeded" }); }
      return res(404, { error: { message: "stripe route not stubbed" } });
    }
    if (host === "api.resend.com") return res(200, { id: "email-1" });
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
        if (table === "gh_events") { evts.push(body); return res(201, [body]); }
        return res(201, [body]);
      }
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const matched = applyFilters(rows, u);
        for (const t of matched) Object.assign(t, body);
        return res(200, matched);
      }
    }
    return res(404, { error: { message: "route not stubbed" } });
  }

  const approve = async (visitDate: string) => {
    rows[0]["visit_date"] = visitDate;
    const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
    rows[0]["report_sent_at"] = sentAt;
    const bt = signBooking("link-secret", { bid: RBID, email: EMAIL, name: "Casey Client" }).token;
    const r = cleanResponse();
    await reportHandler({
      method: "POST", headers: {},
      body: { bt, action: "approve", seen_publication_id: sentAt },
    }, r as never);
    return r;
  };

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    piCalls = 0;
    const sentAt = new Date(Date.now() - 3600 * 1000).toISOString();
    rows = [{
      id: ROW_ID, booking_id: RBID, client_email: EMAIL, client_name: "Casey Client",
      status: "report_sent", report_status: "sent", amount_cents: 20000,
      visit_date: PAST, window: "midday",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: sentAt, receipt_email_id: null,
    }];
    evts = [{ visit_id: ROW_ID, booking_id: RBID, event: "report_sent", detail: { version: 1 }, created_at: sentAt }];
    vi.stubGlobal("fetch", vi.fn(fetchMock));
    // A card_confirmed event picks the single card, so a past-date
    // approve can complete instead of stopping at card selection.
    evts.push({
      visit_id: ROW_ID, booking_id: RBID, event: "card_confirmed",
      detail: { payment_method_id: "pm_1", brand: "visa", last4: "4242" },
      created_at: new Date(Date.now() - 1000).toISOString(),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("Approve before the visit date is rejected with report_too_early, no charge", async () => {
    const r = await approve(FUTURE);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE);
    expect(piCalls).toBe(0);
    expect(rows[0]["status"]).toBe("report_sent");
  });

  it("Approve on the visit date passes the gate and charges", async () => {
    const r = await approve(TODAY);
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.body["ok"]).toBe(true);
    expect(piCalls).toBe(1);
  });

  it("Approve after the visit date passes the gate and charges", async () => {
    const r = await approve(PAST);
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.body["ok"]).toBe(true);
    expect(piCalls).toBe(1);
  });
});

// ---------- chargeVisit date gate ----------
// The money path itself must enforce the date: a sent report for a
// future visit is never charged on any basis (client Approve, owner
// charge, 24h timer), even if the client-facing Approve gate were
// bypassed. The effective date is the confirmed date when set, else
// the scheduled visit date.

const CBID = "bid-charge-date-gate";
const CVISIT_ID = "55555555-6666-7777-8888-999999999999";

describe("chargeVisit date gate", () => {
  let rows: Row[];
  let events: Row[];
  let stripeCalls: string[];
  let piCreates: number;

  const supRes = (data: unknown) => ({
    ok: true, status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("api.stripe.com")) {
        stripeCalls.push(u);
        if (u.includes("/payment_intents/search")) return supRes({ data: [] });
        if (u.includes("/payment_intents") && method === "POST") {
          piCreates++;
          return supRes({ id: "pi_gate_charge", status: "succeeded" });
        }
        if (u.includes("/customers/cus_gate")) return supRes({ id: "cus_gate" });
        return supRes({});
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const qs = new URLSearchParams(u.split("?")[1] ?? "");
          const matched = rows.filter((r) => {
            for (const [k, v] of qs.entries()) {
              if (k === "order" || k === "limit" || k === "select") continue;
              if (v.startsWith("eq.")) {
                if (String(r[k] ?? "") !== decodeURIComponent(v.slice(3))) return false;
              } else if (v.startsWith("neq.")) {
                if (r[k] === null || r[k] === undefined || String(r[k]) === decodeURIComponent(v.slice(4))) return false;
              }
            }
            return true;
          });
          for (const r of matched) Object.assign(r, patch);
          return supRes(matched);
        }
        let out = [...rows];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const bid = qs.get("booking_id");
        if (bid?.startsWith("eq.")) out = out.filter((r) => r["booking_id"] === decodeURIComponent(bid.slice(3)));
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          events.push({ ...body, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const bid = qs.get("booking_id");
        if (bid?.startsWith("eq.")) out = out.filter((e) => e["booking_id"] === decodeURIComponent(bid.slice(3)));
        return supRes(out);
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    }));
  };

  const sentAt = () => new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const baseRow = (visitDate: string): Row => ({
    id: CVISIT_ID, booking_id: CBID, status: "report_sent", report_status: "sent",
    amount_cents: 20000, client_email: "client@example.com",
    visit_date: visitDate, report_sent_at: sentAt(),
    issue_open: false, issue_ever: false, report_bounced: false,
    payment_intent_id: null,
  });
  const baseEvents = (): Row[] => [
    { visit_id: CVISIT_ID, booking_id: CBID, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: sentAt() },
    { visit_id: CVISIT_ID, booking_id: CBID, event: "card_confirmed", detail: { payment_method_id: "pm_1" }, created_at: new Date(Date.now() - 1000).toISOString() },
  ];
  const confirmed = (date: string): Row => ({
    visit_id: CVISIT_ID, booking_id: CBID, event: "visit_confirmed",
    detail: { date, window: "morning" }, created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
  });
  const charge = (source: "client_approve" | "owner_charge" | "timer_24h" = "timer_24h") => chargeVisit({
    secretKey: "sk_test_x",
    bookingId: CBID,
    customerId: "cus_gate",
    customerEmail: "client@example.com",
    paymentMethod: "pm_1",
    source,
    allowedBases: ["client_approved", "timer_rule"],
    nowMs: Date.now(),
    deps: {
      setCustomerMeta: async () => {},
      sendReceipt: async () => true,
      sendPaymentFailedEmail: async () => {},
    },
  });

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    stripeCalls = [];
    piCreates = 0;
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("a future-dated sent report is blocked on the timer, no Stripe call", async () => {
    rows = [baseRow(FUTURE)];
    events = baseEvents();
    const outcome = await charge("timer_24h");
    expect(outcome).toEqual({ outcome: "blocked", error: "report_too_early" });
    expect(piCreates).toBe(0);
    expect(stripeCalls.length).toBe(0);
    expect(rows[0]["status"]).toBe("report_sent");
  });

  it("a future-dated sent report is blocked on client Approve too", async () => {
    rows = [baseRow(FUTURE)];
    events = [
      ...baseEvents(),
      { visit_id: CVISIT_ID, booking_id: CBID, event: "report_approved", detail: { via: "client" }, created_at: new Date(Date.now() - 1000).toISOString() },
    ];
    const outcome = await charge("client_approve");
    expect(outcome).toEqual({ outcome: "blocked", error: "report_too_early" });
    expect(piCreates).toBe(0);
  });

  it("a future confirmed date blocks even when the scheduled date is past", async () => {
    rows = [baseRow(PAST)];
    events = [...baseEvents(), confirmed(FUTURE)];
    const outcome = await charge("timer_24h");
    expect(outcome).toEqual({ outcome: "blocked", error: "report_too_early" });
    expect(piCreates).toBe(0);
  });

  it("a past confirmed date lets a future-scheduled visit charge (confirmed date wins)", async () => {
    rows = [baseRow(FUTURE)];
    events = [...baseEvents(), confirmed(PAST)];
    const outcome = await charge("timer_24h");
    expect(outcome.outcome).toBe("paid");
    expect(piCreates).toBe(1);
    expect(rows[0]["status"]).toBe("paid");
  });

  it("a report dated today charges on the timer", async () => {
    rows = [baseRow(TODAY)];
    events = baseEvents();
    const outcome = await charge("timer_24h");
    expect(outcome.outcome).toBe("paid");
    expect(piCreates).toBe(1);
    expect(rows[0]["status"]).toBe("paid");
  });

  it("a report dated in the past charges on the timer", async () => {
    rows = [baseRow(PAST)];
    events = baseEvents();
    const outcome = await charge("timer_24h");
    expect(outcome.outcome).toBe("paid");
    expect(piCreates).toBe(1);
  });
});

// ---------- selectDue date gate ----------
// The auto-charge cron must never even select a future-dated sent
// report as due. The effective date comes from customer metadata:
// the confirmed date when set, else the scheduled visit date.

describe("selectDue date gate", () => {
  const sentAt25h = () => new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const cust = (overrides: Record<string, string> = {}) => ({
    id: "cus_due", email: "client@example.com",
    metadata: {
      gh_state: "report_sent",
      gh_report_sent_at: sentAt25h(),
      gh_payment_method: "pm_1",
      gh_report_amount_cents: "20000",
      gh_booking_id: "bid-due-gate",
      ...overrides,
    },
  });

  it("a future confirmed date is never due", () => {
    expect(selectDue([cust({ gh_confirmed_date: FUTURE })], Date.now())).toEqual([]);
  });

  it("a future scheduled date is never due when no confirmed date exists", () => {
    expect(selectDue([cust({ gh_visit_date: FUTURE })], Date.now())).toEqual([]);
  });

  it("a future confirmed date wins over a past scheduled date", () => {
    expect(selectDue([cust({ gh_confirmed_date: FUTURE, gh_visit_date: PAST })], Date.now())).toEqual([]);
  });

  it("a report dated today is due", () => {
    const due = selectDue([cust({ gh_confirmed_date: TODAY })], Date.now());
    expect(due).toHaveLength(1);
    expect(due[0]?.bookingId).toBe("bid-due-gate");
  });

  it("a report dated in the past is due", () => {
    expect(selectDue([cust({ gh_confirmed_date: PAST })], Date.now())).toHaveLength(1);
  });

  it("no date at all is not gated (legacy metadata)", () => {
    expect(selectDue([cust()], Date.now())).toHaveLength(1);
  });
});

// ---------- send_report date gate ----------
// The first publish starts the 24h clock and a re-send restarts it, so
// both are blocked for a future-dated visit: a report can never reach
// "sent" before the cleaning happened.

const SBID = "bid-send-report-date-gate";
const SVISIT_ID = "66666666-7777-8888-9999-000000000000";
const SAUTH = "Bearer " + "adm-" + "secret";

describe("send_report date gate", () => {
  let rows: Row[];
  let events: Row[];
  let photos: Row[];
  let stripeMeta: Record<string, string>;
  let resendCalls: number;

  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  const installFetch = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("api.stripe.com")) {
        if (u.includes("/customers/search")) {
          return supRes({ data: [{ id: "cus_send", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } }] });
        }
        if (u.includes("/payment_intents/search")) return supRes({ data: [] });
        if (u.includes("/customers/cus_send")) {
          if (method === "POST") {
            const params = new URLSearchParams(String(init?.body ?? ""));
            for (const [k, v] of params) {
              const m = /^metadata\[(.+)\]$/.exec(k);
              if (m) stripeMeta[m[1]] = v;
            }
            return supRes({ id: "cus_send" });
          }
          return supRes({ id: "cus_send", email: "client@example.com", name: "Casey Client", metadata: { ...stripeMeta } });
        }
        return supRes({});
      }
      if (u.includes("api.resend.com")) {
        resendCalls++;
        return supRes({ id: "email-1" });
      }
      if (u.includes("/storage/v1/object/sign/")) {
        const tail = u.split("/object/sign/")[1] ?? "x.jpg";
        return supRes({ signedURL: `/object/sign/${tail}?token=t` });
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const qs = new URLSearchParams(u.split("?")[1] ?? "");
          const matched = rows.filter((r) => {
            for (const [k, v] of qs.entries()) {
              if (k === "order" || k === "limit" || k === "select") continue;
              if (v.startsWith("eq.")) {
                if (String(r[k] ?? "") !== decodeURIComponent(v.slice(3))) return false;
              } else if (v.startsWith("neq.")) {
                if (r[k] === null || r[k] === undefined || String(r[k]) === decodeURIComponent(v.slice(4))) return false;
              } else if (v.startsWith("in.(") && v.endsWith(")")) {
                const set = new Set(v.slice(4, -1).split(",").map((s) => decodeURIComponent(s)));
                if (!set.has(String(r[k] ?? ""))) return false;
              }
            }
            return true;
          });
          for (const r of matched) Object.assign(r, patch);
          return supRes(matched);
        }
        let out = [...rows];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const bid = qs.get("booking_id");
        if (bid?.startsWith("eq.")) out = out.filter((r) => r["booking_id"] === decodeURIComponent(bid.slice(3)));
        const id = qs.get("id");
        if (id?.startsWith("eq.")) out = out.filter((r) => r["id"] === decodeURIComponent(id.slice(3)));
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          events.push({ ...body, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const bid = qs.get("booking_id");
        if (bid?.startsWith("eq.")) out = out.filter((e) => e["booking_id"] === decodeURIComponent(bid.slice(3)));
        const vid = qs.get("visit_id");
        if (vid?.startsWith("eq.")) out = out.filter((e) => e["visit_id"] === decodeURIComponent(vid.slice(3)));
        const ev = qs.get("event");
        if (ev?.startsWith("eq.")) out = out.filter((e) => e["event"] === decodeURIComponent(ev.slice(3)));
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_photos")) {
        let out = [...photos];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const vid = qs.get("visit_id");
        if (vid?.startsWith("eq.")) out = out.filter((p) => p["visit_id"] === decodeURIComponent(vid.slice(3)));
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_visit_access")) return supRes([]);
      return supRes({}, false, 404);
    }));
  };

  const sendReport = async (visitDate: string, confirmedDate: string | null) => {
    rows[0]["visit_date"] = visitDate;
    events = confirmedDate === null ? [] : [{
      visit_id: SVISIT_ID, booking_id: SBID, event: "visit_confirmed",
      detail: { date: confirmedDate, window: "morning" },
      created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    }];
    const r = cleanResponse();
    await bookingAction({
      method: "POST", headers: { authorization: SAUTH },
      body: { action: "send_report", booking_id: SBID },
    }, r as never);
    return r;
  };

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("ADMIN_TOKEN", "adm-secret");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resendCalls = 0;
    rows = [{
      id: SVISIT_ID, booking_id: SBID, status: "confirmed", report_status: "submitted",
      visit_date: PAST, window: "morning", service: "Standard cleaning",
      client_name: "Casey Client", client_email: "client@example.com",
      amount_cents: 20000, cleaner_name: "Ana Torres", cleaner_id: "roster-1",
      issue_open: false, issue_ever: false, report_bounced: false,
      report_sent_at: null, report_email_id: null,
      checklist: { rooms: [] }, no_photo_zones: null,
    }];
    events = [];
    photos = [
      { id: "p1", visit_id: SVISIT_ID, room: "Kitchen", kind: "after", storage_path: "visits/x/kitchen/a.jpg" },
    ];
    stripeMeta = {
      gh_booking_id: SBID, gh_state: "confirmed",
      gh_first_price_cents: "20000", gh_recurring_price_cents: "18000",
      gh_report_version: "0",
    };
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("first publish for a future-dated visit is rejected with report_too_early, no email", async () => {
    const r = await sendReport(FUTURE, FUTURE);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE);
    expect(resendCalls).toBe(0);
    expect(rows[0]["report_status"]).toBe("submitted");
    expect(rows[0]["status"]).toBe("confirmed");
  });

  it("first publish for a future scheduled date is rejected even with no confirmed date", async () => {
    const r = await sendReport(FUTURE, null);
    // No visit_confirmed event: the first publish stops at
    // needs_confirmation before reaching the date gate — the report
    // still never reaches the client, so the hole stays closed.
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("needs_confirmation");
    expect(resendCalls).toBe(0);
    expect(rows[0]["report_status"]).toBe("submitted");
  });

  it("first publish for a visit dated today succeeds and emails the report", async () => {
    const r = await sendReport(TODAY, TODAY);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["state"]).toBe("report_sent");
    expect(r.body["email_sent"]).toBe(true);
    expect(resendCalls).toBe(1);
    expect(rows[0]["report_status"]).toBe("sent");
    expect(rows[0]["status"]).toBe("report_sent");
  });

  it("first publish for a visit dated in the past succeeds", async () => {
    const r = await sendReport(PAST, PAST);
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["email_sent"]).toBe(true);
    expect(rows[0]["report_status"]).toBe("sent");
  });
});
