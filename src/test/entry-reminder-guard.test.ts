// @vitest-environment node
// Entry reminder guard: the quote-time choice settles the reminder —
// meeting choices and arrange-before WITH saved details get no reminder;
// decide_later, unsettled and arrange-before WITHOUT details get exactly
// one (CAS + journal dedupe).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import autoChargeHandler from "../../api/auto-charge";

vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T10:00:00Z"));

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };
type Acc = Record<string, unknown>;

let visitRows: Row[];
let events: Ev[];
let accessRows: Acc[];
let resendCalls: { to: string[]; subject: string }[];

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

const ev = (event: string, created_at: string): Ev => ({ event, detail: {}, created_at });
const confirmed = () => ev("visit_confirmed", "2026-10-27T10:00:00.000Z");

function makeVisit(over: Row = {}): Row {
  return {
    id: "visit-1", booking_id: "bid-rem", client_email: "client@example.com",
    cleaner_name: "Taylor Allen", visit_date: "2026-10-29", window: "midday",
    status: "confirmed", report_sent_at: null, entry_reminder_sent: null,
    entry_method: null,
    ...over,
  };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  visitRows = [makeVisit()];
  events = [confirmed()];
  accessRows = [];
  resendCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
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
          // CAS: the claim wins only when the flag is not already true.
          const qId = u.searchParams.get("id");
          const row = visitRows.find((r) => qId === `eq.${r["id"]}`);
          if (row && row["entry_reminder_sent"] !== true) {
            row["entry_reminder_sent"] = true;
            return okRes([row]);
          }
          return okRes([]);
        }
        // The reminder pass queries by visit_date; every other
        // gh_visits read in this handler returns nothing here.
        if (u.searchParams.get("visit_date")) return okRes([...visitRows]);
        return okRes([]);
      }
      if (u.pathname.includes("/rest/v1/gh_visit_access")) {
        if (method === "DELETE") return okRes([]);
        const qVid = u.searchParams.get("visit_id");
        let out = [...accessRows];
        if (qVid && qVid.startsWith("eq.")) out = out.filter((r) => r["visit_id"] === decodeURIComponent(qVid.slice(3)));
        return okRes(out);
      }
      if (u.pathname.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { event?: string };
          events.push({ event: body.event ?? "", detail: {}, created_at: new Date().toISOString() });
          return okRes([{ id: events.length }]);
        }
        const qVid = u.searchParams.get("visit_id");
        const qEv = u.searchParams.get("event");
        let out = [...events];
        if (qVid && qVid.startsWith("eq.")) out = out.filter(() => true); // single-visit fixture
        if (qEv && qEv.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(qEv.slice(3)));
        if (qEv && qEv.startsWith("in.(")) {
          const names = qEv.slice(4, -1).split(",");
          out = out.filter((e) => names.includes(e.event));
        }
        return okRes(out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
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

describe("entry reminder guard", () => {
  it("reminds once when entry is unsettled", async () => {
    const r = await call();
    expect(r.code).toBe(200);
    expect(r.body["entry_reminded"]).toBe(1);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0].subject).toContain("how should we get in?");
  });

  it("skips meeting choices (home / other_person)", async () => {
    for (const m of ["home", "other_person"]) {
      visitRows = [makeVisit({ entry_method: m })];
      events = [confirmed()];
      resendCalls = [];
      const r = await call();
      expect(r.body["entry_reminded"]).toBe(0);
      expect(resendCalls).toHaveLength(0);
    }
  });

  it("skips arrange_before with saved details, reminds without them", async () => {
    visitRows = [makeVisit({ entry_method: "arrange_before" })];
    accessRows = [{ visit_id: "visit-1", entry_method: "arrange", entry_secret: "enc-blob" }];
    expect((await call()).body["entry_reminded"]).toBe(0);
    expect(resendCalls).toHaveLength(0);

    accessRows = [];
    resendCalls = [];
    expect((await call()).body["entry_reminded"]).toBe(1);
    expect(resendCalls).toHaveLength(1);
  });

  it("reminds for decide_later", async () => {
    visitRows = [makeVisit({ entry_method: "decide_later" })];
    const r = await call();
    expect(r.body["entry_reminded"]).toBe(1);
    expect(resendCalls).toHaveLength(1);
  });

  it("never duplicates: flag + journal event both stop a second run", async () => {
    visitRows = [makeVisit({ entry_reminder_sent: true })];
    events = [confirmed(), ev("entry_reminder_sent", "2026-10-28T09:00:00.000Z")];
    const r = await call();
    expect(r.body["entry_reminded"]).toBe(0);
    expect(resendCalls).toHaveLength(0);
  });
});
