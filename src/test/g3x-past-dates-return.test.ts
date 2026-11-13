// @vitest-environment node
// G3X (top-5 round): past dates + return_report TOCTOU.
//
// Past dates: confirm, assign_confirm and decline_date must reject a
// visit date in the past (400), compared with today in America/New_York
// — the same clock the payment-date gate uses. Today itself is fine.
// Exempt: an exact repeat of the recorded confirmation (an idempotent
// re-confirm must not start failing once its date has passed) and the
// explicit repair of a visit whose report was submitted without
// confirmation (which by definition records the date of a visit that
// already happened).
//
// return_report (L1): the return must claim the report state it was
// decided on, so a concurrent return — or a return racing a cleaner
// re-publish — cannot silently overwrite. A lost claim is a 409 with
// the current state, not a success for a return that never landed.
//
// All dates here are relative to today, so the tests do not rot the way
// fixed-date fixtures do.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bookingAction from "../../api/booking-action";

const BID = "bid-g3x-dates";
const VISIT_ID = "99999999-4444-5555-6666-777777777777";

const todayNY = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
const shiftDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Row = Record<string, unknown>;
type Ev = { visit_id: string | null; booking_id?: string; event: string; detail?: Record<string, unknown>; created_at?: string };

let rows: Row[];
let events: Ev[];
let roster: Row[];
let storeMeta: Record<string, string>;
let resendBodies: string[];
let flipReportOnReturn: boolean;

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end: vi.fn(),
  };
}

const baseRow = (overrides: Row = {}): Row => ({
  id: VISIT_ID,
  booking_id: BID,
  visit_no: 1,
  status: "requested",
  report_status: "none",
  visit_date: shiftDays(todayNY(), 5),
  window: "midday",
  service: "Standard cleaning",
  client_name: "Casey Client",
  client_email: "client@example.com",
  amount_cents: 14900,
  cleaner_name: "Ana",
  cleaner_id: "roster-ana",
  cleaner_token_hash: null,
  cleaner_token_expires: null,
  cleaner_link_version: null,
  cleaner_link_issuance: null,
  cleaner_profile: null,
  issue_open: false,
  issue_ever: false,
  report_sent_at: null,
  report_bounced: false,
  checklist: { rooms: [] },
  ...overrides,
});

const installFetch = () => {
  const supRes = (data: unknown, ok = true, status = 200) => ({
    ok, status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.includes("api.stripe.com")) {
      if (u.includes("/customers/search")) {
        return supRes({ data: [{ id: "cus_g3x", email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } }] });
      }
      if (u.includes("/payment_methods")) return supRes({ data: [] });
      if (u.includes("/customers/cus_g3x")) {
        if (method === "POST") {
          const params = new URLSearchParams(String(init?.body ?? ""));
          for (const [k, v] of params) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return supRes({ id: "cus_g3x" });
        }
        return supRes({ id: "cus_g3x", email: "client@example.com", name: "Casey Client", metadata: { ...storeMeta } });
      }
      return supRes({ id: "cus_g3x" });
    }
    if (u.includes("api.resend.com")) {
      resendBodies.push(String(init?.body ?? ""));
      return supRes({ id: "email-1" });
    }
    if (u.includes("/rest/v1/gh_cleaners")) {
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const id = qs.get("id");
      const out = id && id.startsWith("eq.")
        ? roster.filter((r) => r["id"] === decodeURIComponent(id.slice(3)))
        : [...roster];
      return supRes(out.slice(0, 1));
    }
    if (u.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        // Race model: a cleaner re-publish lands between the return's
        // read and its claim.
        if (flipReportOnReturn && patch["report_status"] === "returned") {
          for (const r of rows) r["report_status"] = "sent";
        }
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const matched = rows.filter((r) => {
          for (const [k, v] of qs.entries()) {
            if (k === "order" || k === "limit" || k === "select") continue;
            if (v.startsWith("eq.")) {
              if (String(r[k] ?? "") !== decodeURIComponent(v.slice(3))) return false;
            } else if (v.startsWith("neq.")) {
              if (String(r[k] ?? "") === decodeURIComponent(v.slice(4))) return false;
            }
          }
          return true;
        });
        for (const r of matched) Object.assign(r, patch);
        return supRes(matched);
      }
      let out = [...rows];
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      const bid = eq("booking_id");
      const id = eq("id");
      if (bid) out = out.filter((r) => r["booking_id"] === bid);
      if (id) out = out.filter((r) => r["id"] === id);
      const limit = qs.get("limit");
      if (limit) out = out.slice(0, parseInt(limit, 10));
      return supRes(out);
    }
    if (u.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { visit_id?: string | null; booking_id?: string; event?: string; detail?: Record<string, unknown> };
        events.push({ visit_id: body.visit_id ?? null, booking_id: body.booking_id, event: body.event ?? "", detail: body.detail });
        return supRes([{ id: events.length }]);
      }
      let out = [...events];
      const qs = new URLSearchParams(u.split("?")[1] ?? "");
      const eq = (k: string) => {
        const v = qs.get(k);
        return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
      };
      const vid = eq("visit_id");
      const bid = eq("booking_id");
      const ev = eq("event");
      if (vid) out = out.filter((e) => e.visit_id === vid);
      if (bid) out = out.filter((e) => e["booking_id"] === bid);
      if (ev) out = out.filter((e) => e.event === ev);
      return supRes(out);
    }
    if (u.includes("/rest/v1/gh_photos")) return supRes([]);
    if (u.includes("/rest/v1/gh_visit_access")) return supRes([]);
    return supRes({}, false, 404);
  }));
};

const call = async (body: Record<string, unknown>) => {
  const r = res();
  await bookingAction(
    { method: "POST", headers: { authorization: "Bearer " + "adm-" + "secret" }, body: { booking_id: BID, ...body } } as never,
    r as never,
  );
  return r;
};

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("ADMIN_TOKEN", "adm-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("CLEANER_LINK_SECRET", "test-cleaner-secret-123");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rows = [baseRow()];
  events = [];
  roster = [
    { id: "roster-ana", name: "Ana", phone: "+1 404 555 0100", photo_url: "https://example.com/ana.jpg", active: true },
  ];
  storeMeta = {
    gh_booking_id: BID, gh_state: "card_ready",
    gh_first_price_cents: "14900", gh_recurring_price_cents: "12900",
  };
  resendBodies = [];
  flipReportOnReturn = false;
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("G3X confirm rejects past dates", () => {
  it("a fresh confirm for yesterday is 400 and writes nothing", async () => {
    const r = await call({ action: "confirm", confirmed_date: shiftDays(todayNY(), -1), confirmed_window: "midday" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("confirmed_date_in_past");
    expect(rows[0]["status"]).toBe("requested");
    expect(storeMeta["gh_confirmed_date"]).toBeUndefined();
    expect(resendBodies).toHaveLength(0);
  });

  it("a fresh confirm for today succeeds", async () => {
    const r = await call({ action: "confirm", confirmed_date: todayNY(), confirmed_window: "midday" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["status"]).toBe("confirmed");
    expect(rows[0]["visit_date"]).toBe(todayNY());
  });

  it("a fresh confirm for a future date succeeds", async () => {
    const r = await call({ action: "confirm", confirmed_date: shiftDays(todayNY(), 3), confirmed_window: "midday" });
    expect(r.code).toBe(200);
    expect(rows[0]["status"]).toBe("confirmed");
  });

  it("repair of a submitted report may record a past date", async () => {
    rows = [baseRow({ status: "report_submitted", report_status: "submitted", visit_date: shiftDays(todayNY(), -2) })];
    const r = await call({ action: "confirm", confirmed_date: shiftDays(todayNY(), -2), confirmed_window: "midday", repair: true });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["status"]).toBe("confirmed");
    expect(rows[0]["report_status"]).toBe("submitted");
  });

  it("an exact repeat of a recorded confirmation still no-ops after its date passes", async () => {
    const past = shiftDays(todayNY(), -1);
    rows = [baseRow({ status: "confirmed", visit_date: past })];
    events = [{ visit_id: VISIT_ID, event: "visit_confirmed", detail: { date: past, window: "midday" }, created_at: new Date().toISOString() }];
    const r = await call({ action: "confirm", confirmed_date: past, confirmed_window: "midday" });
    expect(r.code).toBe(200);
    expect(r.body["already_confirmed"]).toBe(true);
    expect(r.body["email_sent"]).toBe(false);
    expect(resendBodies).toHaveLength(0);
  });
});

describe("G3X assign_confirm rejects past dates", () => {
  it("a fresh assignment for yesterday is 400", async () => {
    rows = [baseRow({ cleaner_id: null, cleaner_name: null })];
    const r = await call({ action: "assign_confirm", cleaner_id: "roster-ana", confirmed_date: shiftDays(todayNY(), -1), confirmed_window: "midday" });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("confirmed_date_in_past");
    expect(rows[0]["status"]).toBe("requested");
    expect(rows[0]["cleaner_id"]).toBeNull();
    expect(rows[0]["cleaner_link_issuance"]).toBeNull();
    expect(resendBodies).toHaveLength(0);
  });

  it("a fresh assignment for a future date succeeds with a link", async () => {
    const r = await call({ action: "assign_confirm", cleaner_id: "roster-ana", confirmed_date: shiftDays(todayNY(), 3), confirmed_window: "midday" });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["status"]).toBe("confirmed");
    expect(rows[0]["cleaner_id"]).toBe("roster-ana");
    expect(rows[0]["cleaner_link_issuance"]).toBeTruthy();
  });

  it("repair of a submitted report may assign a past date", async () => {
    rows = [baseRow({ status: "report_submitted", report_status: "submitted", visit_date: shiftDays(todayNY(), -2), cleaner_name: null, cleaner_id: null })];
    const r = await call({ action: "assign_confirm", cleaner_id: "roster-ana", confirmed_date: shiftDays(todayNY(), -2), confirmed_window: "midday", repair: true });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(rows[0]["report_status"]).toBe("submitted");
  });
});

describe("G3X decline_date rejects past alternative dates", () => {
  it("an alternative date in the past is 400 and stores nothing", async () => {
    const r = await call({ action: "decline_date", alt_dates: [shiftDays(todayNY(), -1)] });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("alt_date_in_past");
    expect(storeMeta["gh_state"]).not.toBe("date_declined");
    expect(resendBodies).toHaveLength(0);
  });

  it("a past alternative among future ones is still 400", async () => {
    const r = await call({ action: "decline_date", alt_dates: [shiftDays(todayNY(), 2), shiftDays(todayNY(), -3)] });
    expect(r.code).toBe(400);
    expect(r.body["error"]).toBe("alt_date_in_past");
  });

  it("future alternatives still decline the date", async () => {
    const r = await call({ action: "decline_date", alt_dates: [shiftDays(todayNY(), 2), shiftDays(todayNY(), 4)] });
    expect(r.code).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(storeMeta["gh_state"]).toBe("date_declined");
    expect(storeMeta["gh_alt_dates"]).toBe(`${shiftDays(todayNY(), 2)},${shiftDays(todayNY(), 4)}`);
    expect(events.some((e) => e.event === "date_proposed")).toBe(true);
  });
});

describe("G3X return_report claims the report state (L1)", () => {
  it("returns a submitted report", async () => {
    rows = [baseRow({ status: "report_submitted", report_status: "submitted" })];
    const r = await call({ action: "return_report", note: "Redo the kitchen floor" });
    expect(r.code).toBe(200);
    expect(r.body["report_status"]).toBe("returned");
    expect(rows[0]["report_status"]).toBe("returned");
    expect(events.some((e) => e.event === "report_returned")).toBe(true);
  });

  it("a return racing a re-publish loses the claim — 409 with the current state, no return journaled", async () => {
    rows = [baseRow({ status: "report_submitted", report_status: "submitted" })];
    flipReportOnReturn = true;
    const r = await call({ action: "return_report", note: "Redo the kitchen floor" });
    expect(r.code).toBe(409);
    expect(r.body["error"]).toBe("report_state_changed");
    expect(r.body["report_status"]).toBe("sent");
    expect(rows[0]["report_status"]).toBe("sent");
    expect(events.some((e) => e.event === "report_returned")).toBe(false);
  });
});
