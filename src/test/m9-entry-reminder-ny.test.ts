// @vitest-environment node
// M9: the entry reminder counted its window in UTC, not America/New_York.
// Frozen at 2026-11-14T02:00:00Z: UTC says today=11-14, tomorrow=11-15,
// but in Atlanta (EST, UTC-5) it is still 21:00 on 11-13 — so NY today
// is 11-13 and NY tomorrow is 11-14. A visit on 11-13 must be reminded
// (it is TODAY for the client) and 11-15 must not (it is the day after
// tomorrow in NY). The old UTC window would have done the opposite.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import autoChargeHandler from "../../api/auto-charge";

vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T02:00:00Z"));

type Row = Record<string, unknown>;
type Ev = { event: string; booking_id: string; detail: Record<string, unknown> | null; created_at: string };

let visitRows: Row[];
let events: Ev[];
let resendCalls: { to: string[]; subject: string }[];
let queriedWindow: { gte: string; lte: string } | null;

function res() {
  return {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

function makeVisit(visitDate: string, i: number): Row {
  return {
    id: `visit-m9-${i}`, booking_id: `bid-m9-${i}`, client_email: `client-${i}@example.com`,
    client_name: "Casey Client", cleaner_name: "Taylor Allen", visit_date: visitDate,
    window: "midday", status: "confirmed", report_sent_at: null,
    entry_reminder_sent: null, entry_method: null,
  };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("BOOKING_LINK_SECRET", "link-secret");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // NY today (11-13) and NY tomorrow (11-14) must be reminded;
  // NY yesterday (11-12) and NY day-after-tomorrow (11-15) must not.
  visitRows = [
    makeVisit("2026-11-13", 1),
    makeVisit("2026-11-14", 2),
    makeVisit("2026-11-15", 3),
    makeVisit("2026-11-12", 4),
  ];
  events = visitRows.map((r) => ({
    event: "visit_confirmed", booking_id: String(r["booking_id"]),
    detail: {}, created_at: "2026-11-10T10:00:00.000Z",
  }));
  resendCalls = [];
  queriedWindow = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string };
      resendCalls.push({ to: body.to ?? [], subject: body.subject ?? "" });
      return okRes({ id: "email-1" });
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) return okRes({ data: [] });
      if (u.pathname.endsWith("/customers")) return okRes({ data: [] });
      return okRes({ data: [] });
    }
    if (u.hostname === "test.supabase.co") {
      if (u.pathname.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          // CAS claim on entry_reminder_sent.
          const qId = u.searchParams.get("id");
          const row = visitRows.find((r) => qId === `eq.${r["id"]}`);
          if (row && row["entry_reminder_sent"] !== true) {
            row["entry_reminder_sent"] = true;
            return okRes([row]);
          }
          return okRes([]);
        }
        if (u.searchParams.has("visit_date")) {
          // Apply the PostgREST date window like the real DB, and
          // record it so the test can assert it is the NY window.
          const dates = u.searchParams.getAll("visit_date");
          const gte = dates.find((d) => d.startsWith("gte."))?.slice(4) ?? "";
          const lte = dates.find((d) => d.startsWith("lte."))?.slice(4) ?? "";
          queriedWindow = { gte, lte };
          return okRes(visitRows.filter((r) => {
            const d = String(r["visit_date"] ?? "");
            return (!gte || d >= gte) && (!lte || d <= lte);
          }));
        }
        return okRes([]);
      }
      if (u.pathname.includes("/rest/v1/gh_visit_access")) {
        if (method === "DELETE") return okRes([]);
        return okRes([]);
      }
      if (u.pathname.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string; booking_id?: string };
          events.push({ event: body.event ?? "", booking_id: body.booking_id ?? "", detail: {}, created_at: new Date().toISOString() });
          return okRes([{ id: events.length }]);
        }
        const qBid = u.searchParams.get("booking_id");
        let out = [...events];
        if (qBid && qBid.startsWith("eq.")) {
          out = out.filter((e) => e.booking_id === decodeURIComponent(qBid.slice(3)));
        }
        return okRes(out);
      }
      return okRes([]);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const call = async () => {
  const r = res();
  await (autoChargeHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: "GET", headers: { authorization: "Bearer cron-secret" } }, r as never,
  );
  return r;
};

describe("M9 entry reminder window is America/New_York", () => {
  it("queries the NY window and reminds the NY-today and NY-tomorrow visits only", async () => {
    const r = await call();
    expect(r.code).toBe(200);
    // The window itself must be NY dates, not the UTC 11-14..11-15.
    expect(queriedWindow).toEqual({ gte: "2026-11-13", lte: "2026-11-14" });
    expect(r.body["entry_reminded"]).toBe(2);
    expect(resendCalls).toHaveLength(2);
    expect(resendCalls.map((c) => c.to[0]).sort()).toEqual([
      "client-1@example.com",
      "client-2@example.com",
    ]);
    expect(resendCalls.every((c) => c.subject.includes("arrange entry"))).toBe(true);
    // The out-of-window visits were never claimed.
    expect(visitRows[2]["entry_reminder_sent"]).toBeNull();
    expect(visitRows[3]["entry_reminder_sent"]).toBeNull();
  });
});
