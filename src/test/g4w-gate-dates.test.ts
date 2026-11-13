// @vitest-environment node
// G3: the cleaner submit gate and the client approve gate use the SAME
// date — the re-clean date when one is scheduled, else the effective
// visit date (confirmed date from the journal when set, else the
// scheduled visit date). Both gates also share the validated
// isFutureVisitDate from api/_visit_date.ts: an impossible calendar
// date ("2026-13-40") is never treated as future.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cleanerHandler, { isFutureVisitDate as cleanerIsFuture, effectiveGateDate as cleanerGateDate } from "../../api/cleaner";
import reportHandler, { isFutureVisitDate as reportIsFuture, effectiveGateDate as reportGateDate } from "../../api/report";
import { mintCleanerLinkV2 } from "../../api/_cleaner_link";
import { hashToken } from "../../api/_db";
import { signBooking } from "../../api/create-checkout-session";

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

function cleanResponse() {
  const r = {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  return r;
}

describe("effectiveGateDate is identical on both sides", () => {
  it("re-clean wins, then confirmed, then scheduled; empty stays empty", () => {
    for (const fn of [cleanerGateDate, reportGateDate]) {
      expect(fn(FUTURE, PAST, PAST)).toBe(FUTURE);
      expect(fn("", PAST, FUTURE)).toBe(PAST);
      expect(fn("", "", FUTURE)).toBe(FUTURE);
      expect(fn("", "", "")).toBe("");
    }
  });
});

describe("isFutureVisitDate (shared validated copy, both modules)", () => {
  it("an impossible calendar date is never future", () => {
    for (const fn of [cleanerIsFuture, reportIsFuture]) {
      expect(fn("2026-13-40")).toBe(false);
      expect(fn("2026-02-30")).toBe(false);
      expect(fn("2026-00-10")).toBe(false);
      expect(fn("2026-01-00")).toBe(false);
      expect(fn("2026-04-31")).toBe(false);
    }
  });
  it("a real future date is future; today, past and malformed are not", () => {
    for (const fn of [cleanerIsFuture, reportIsFuture]) {
      expect(fn(FUTURE)).toBe(true);
      expect(fn(TODAY)).toBe(false);
      expect(fn(PAST)).toBe(false);
      expect(fn(null)).toBe(false);
      expect(fn("")).toBe(false);
      expect(fn("not-a-date")).toBe(false);
    }
  });
});

// ---------- cleaner submit gate ----------

const CBID = "bid-g4w-gate";
const CVISIT_ID = "33333333-4444-5555-6666-777777777777";
const CSECRET = "test-cleaner-secret-123";
const CISSUANCE = "aabbccddeeff00112233445566778899";
const SCOPE_ROOMS = ["Kitchen", "Bathroom", "Bedroom", "Living room"];

type Row = Record<string, unknown>;

function scopeChecklist() {
  return { rooms: SCOPE_ROOMS.map((name) => ({ name, items: [{ label: "Cleaned as agreed", done: false }] })) };
}

describe("cleaner submit gate (handler)", () => {
  let row: Row;
  let events: Row[];

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("CLEANER_LINK_SECRET", CSECRET);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("BOOKING_LINK_SECRET", CSECRET);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    row = {
      id: CVISIT_ID, booking_id: CBID, visit_no: 1, status: "confirmed", report_status: "draft",
      visit_date: PAST, window: "midday", address: "1 Test St", service: "Standard cleaning",
      client_name: "Casey Client", client_email: "client@example.com",
      cleaner_token_hash: null, cleaner_token_expires: null, cleaner_link_version: null, cleaner_link_issuance: null,
      checklist: scopeChecklist(), issue_open: false, issue_ever: false, amount_cents: 149,
      reclean_status: null, reclean_date: null, no_photo_zones: null,
      updated_at: "2026-11-13T10:00:00.000Z",
    };
    events = [
      { visit_id: CVISIT_ID, event: "visit_confirmed", detail: { date: PAST, window: "midday" }, created_at: "2026-11-10T10:00:00.000Z" },
    ];
    const supRes = (data: unknown, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => data, text: async () => JSON.stringify(data),
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") { Object.assign(row, JSON.parse(String(init?.body ?? "{}"))); return supRes([row]); }
        return supRes([row]);
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") { events.push(JSON.parse(String(init?.body ?? "{}")) as Row); return supRes([{}], 201); }
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const ev = qs.get("event") ?? "";
        let out = [...events];
        if (ev.startsWith("eq.")) out = out.filter((e) => e["event"] === decodeURIComponent(ev.slice(3)));
        if (ev.startsWith("in.(")) {
          const names = ev.slice(4, -1).split(",");
          out = out.filter((e) => names.includes(String(e["event"])));
        }
        return supRes(out);
      }
      if (u.includes("/rest/v1/gh_photos")) return supRes([]);
      if (u.startsWith("https://api.stripe.com")) return supRes({ id: "cus_test", metadata: {} });
      if (u === "https://api.resend.com/emails") return supRes({ id: "re_test" });
      return supRes(null, 404);
    }));
    const token = mintCleanerLinkV2(CSECRET, CVISIT_ID, CISSUANCE);
    row["cleaner_token_hash"] = hashToken(token);
    row["cleaner_token_expires"] = new Date(Date.now() + 86400000).toISOString();
    row["cleaner_link_version"] = "v2";
    row["cleaner_link_issuance"] = CISSUANCE;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const submit = async () => {
    const token = mintCleanerLinkV2(CSECRET, CVISIT_ID, CISSUANCE);
    const r = cleanResponse();
    await cleanerHandler({ method: "POST", body: { ct: token, action: "submit" } } as never, r as never);
    return r;
  };

  it("an impossible visit date is not treated as future — the gate passes", async () => {
    row["visit_date"] = "2026-13-40";
    events[0]["detail"] = { date: "2026-13-40", window: "midday" };
    const r = await submit();
    // Past the date gate; the next failure is the missing photos.
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.body["error"]).toBe("rooms_incomplete");
  });

  it("a real future visit date blocks the submit", async () => {
    row["visit_date"] = FUTURE;
    events[0]["detail"] = { date: FUTURE, window: "midday" };
    const r = await submit();
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["visit_date"]).toBe(FUTURE);
  });

  it("a scheduled future re-clean blocks the submit even when the visit is past", async () => {
    row["reclean_status"] = "scheduled";
    row["reclean_date"] = FUTURE;
    const r = await submit();
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["reclean"]).toBe(true);
    expect(r.body["visit_date"]).toBe(FUTURE);
  });

  it("a scheduled past re-clean lets the submit past the gate", async () => {
    row["reclean_status"] = "scheduled";
    row["reclean_date"] = PAST;
    const r = await submit();
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.body["error"]).toBe("rooms_incomplete");
  });
});

// ---------- report approve gate ----------

const RBID = "bid-g4w-approve";
const ROW_ID = "44444444-5555-6666-7777-888888888888";
const EMAIL = "client@example.com";

describe("report Approve date gate (handler)", () => {
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
    vi.stubEnv("ADMIN_TOKEN", "test-admin-token-123");
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
      reclean_status: null, reclean_date: null,
    }];
    evts = [{ visit_id: ROW_ID, booking_id: RBID, event: "report_sent", detail: { version: 1 }, created_at: sentAt }];
    vi.stubGlobal("fetch", vi.fn(fetchMock));
    evts.push({
      visit_id: ROW_ID, booking_id: RBID, event: "card_confirmed",
      detail: { payment_method_id: "pm_1", brand: "visa", last4: "4242" },
      created_at: new Date(Date.now() - 1000).toISOString(),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("an impossible visit date is not treated as future — the gate passes", async () => {
    const r = await approve("2026-13-40");
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.code).not.toBe(409);
  });

  it("a real future visit date blocks Approve with no charge", async () => {
    const r = await approve(FUTURE);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_too_early");
    expect(piCalls).toBe(0);
  });

  it("a scheduled future re-clean blocks Approve even when the visit is past", async () => {
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_date"] = FUTURE;
    const r = await approve(PAST);
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_too_early");
    expect(r.body["reclean"]).toBe(true);
    expect(piCalls).toBe(0);
  });

  it("a scheduled past re-clean lets Approve through and charges", async () => {
    rows[0]["reclean_status"] = "scheduled";
    rows[0]["reclean_date"] = PAST;
    const r = await approve(PAST);
    expect(r.body["error"]).not.toBe("report_too_early");
    expect(r.body["ok"]).toBe(true);
    expect(piCalls).toBe(1);
  });
});
