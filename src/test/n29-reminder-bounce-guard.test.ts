// @vitest-environment node
// N29: a bounced reminder is not a delivered reminder.
//   - the latest reminder event is a bounce → the cron re-sends the
//     reminder this run and does NOT charge;
//   - a bounce superseded by a later successful reminder → the charge
//     proceeds on time.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import autoChargeHandler from "../../api/auto-charge";

const BID = "bid-n29-guard";
const VISIT_ID = "44444444-5555-6666-7777-888888888888";
const CRON = "cron-secret";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string; booking_id: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let resendSubjects: string[];
let piCalls: number;
let logLines: string[];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const ev = (event: string, h: number): Ev => ({ event, detail: {}, created_at: hoursAgo(h), booking_id: BID });
const reportSentEv = (h: number): Ev => ({ event: "report_sent", detail: { version: 1, email_sent: true }, created_at: hoursAgo(h), booking_id: BID });

function res() {
  return {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(), end: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logLines.push(String(a[0] ?? "")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  row = {
    id: VISIT_ID, booking_id: BID, status: "report_sent", amount_cents: 14900,
    cleaner_name: "Casey Cleaner", client_email: "client@example.com",
    report_sent_at: hoursAgo(30), report_bounced: false, report_status: "sent",
  };
  events = [];
  storeMeta = {
    gh_booking_id: BID, gh_state: "report_sent", gh_report_sent_at: hoursAgo(30),
    gh_report_amount_cents: "14900", gh_payment_method: "pm_1", gh_report_version: "1",
  };
  resendSubjects = [];
  piCalls = 0;
  logLines = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.hostname === "api.resend.com") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { subject?: string };
      resendSubjects.push(body.subject ?? "");
      return okRes({ id: "email-1" });
    }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        const query = u.searchParams.get("query") ?? "";
        const stateM = /gh_state'\]:'([^']+)'/.exec(query);
        const found = !stateM || storeMeta["gh_state"] === stateM[1]
          ? [{ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta }]
          : [];
        return okRes({ data: found });
      }
      if (u.pathname.endsWith("/payment_intents/search")) return okRes({ data: [] });
      if (u.pathname.endsWith("/payment_intents")) {
        piCalls++;
        return okRes({ id: "pi_1", status: "succeeded" });
      }
      if (u.pathname.endsWith("/payment_methods")) return okRes({ data: [] });
      const custM = /\/customers\/(cus_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (custM) {
        if (init?.body) {
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) storeMeta[m[1]] = v;
          }
          return okRes({ id: "cus_v" });
        }
        return okRes({ id: "cus_v", email: "client@example.com", name: "Casey Client", metadata: storeMeta });
      }
      return okRes({ id: "cus_v" });
    }
    if (u.pathname.includes("/rest/v1/gh_visits")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
        Object.assign(row, patch);
        return okRes([row]);
      }
      const qBid = u.searchParams.get("booking_id");
      if (qBid && qBid.startsWith("eq.")) {
        return okRes(decodeURIComponent(qBid.slice(3)) === BID ? [row] : []);
      }
      return okRes([]);
    }
    if (u.pathname.includes("/rest/v1/gh_events")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { booking_id?: string; event?: string; detail?: Record<string, unknown> | null };
        events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString(), booking_id: body.booking_id ?? BID });
        return okRes([{ id: events.length }]);
      }
      const qEv = u.searchParams.get("event");
      let out = [...events];
      if (qEv && qEv.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(qEv.slice(3)));
      if (qEv && qEv.startsWith("in.")) {
        const names = decodeURIComponent(qEv.slice(3)).replace(/^\(|\)$/g, "").split(",");
        out = out.filter((e) => names.includes(e.event));
      }
      out = [...out].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const limit = u.searchParams.get("limit");
      if (limit) out = out.slice(0, parseInt(limit, 10));
      return okRes(out);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const run = async () => {
  const r = res();
  await autoChargeHandler({ method: "GET", headers: { authorization: `Bearer ${CRON}` } }, r as never);
  return r;
};

describe("N29 bounced reminder blocks the charge until a fresh reminder", () => {
  it("latest reminder event is a bounce: re-reminds and skips the charge", async () => {
    storeMeta["gh_reminded_at"] = hoursAgo(25);
    events = [reportSentEv(30), ev("reminder_sent", 25), ev("reminder_bounced", 1)];
    const r = await run();
    expect(r.body["reminded"]).toBe(1);
    expect(resendSubjects).toContain("Reminder: your cleaning report is waiting");
    expect(r.body["charged"]).toBe(0);
    expect(r.body["skipped"]).toBe(1);
    expect(piCalls).toBe(0);
    // The re-send journaled a fresh reminder with its Resend id.
    const fresh = events.filter((e) => e.event === "reminder_sent");
    expect(fresh).toHaveLength(2);
    expect((fresh[1].detail as Record<string, unknown>)["email_id"]).toBe("email-1");
  });

  it("bounce superseded by a later reminder: charges on time", async () => {
    storeMeta["gh_reminded_at"] = hoursAgo(23);
    events = [reportSentEv(30), ev("reminder_sent", 25), ev("reminder_bounced", 24), ev("reminder_sent", 23)];
    const r = await run();
    expect(r.body["reminded"]).toBe(0);
    expect(r.body["charged"]).toBe(1);
    expect(piCalls).toBe(1);
    expect(row["status"]).toBe("paid");
  });
});
