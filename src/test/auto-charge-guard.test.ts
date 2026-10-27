// @vitest-environment node
// Auto-charge guards:
//  - a failed timer charge emails the client (once-guarded), it must
//    not fail silently into a panel flag;
//  - a report is never charged in the run that first reminded it, nor
//    before any reminder while reminders are enabled.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import autoChargeHandler, { selectDue } from "../../api/auto-charge";

const BID = "bid-charge-guard";
const VISIT_ID = "44444444-5555-6666-7777-888888888888";
const CRON = "cron-secret";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let resendSubjects: string[];
let piCalls: number;
let piResult: { status: string; error?: string };

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function res() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
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
  piResult = { status: "succeeded" };
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
      if (u.pathname.endsWith("/payment_intents/search")) {
        return okRes({ data: [] });
      }
      if (u.pathname.endsWith("/payment_intents")) {
        piCalls++;
        return okRes(piResult.status === "succeeded"
          ? { id: "pi_1", status: "succeeded" }
          : { status: piResult.status, error: { message: piResult.error ?? "card declined" } });
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
        events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString() });
        return okRes([{ id: events.length }]);
      }
      const qBid = u.searchParams.get("booking_id");
      const qEv = u.searchParams.get("event");
      let out = [...events];
      if (qEv && qEv.startsWith("eq.")) out = out.filter((e) => e.event === decodeURIComponent(qEv.slice(3)));
      out = [...out].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
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

describe("reminder-before-charge guard", () => {
  it("never reminded: reminds this run and skips the charge", async () => {
    const r = await run();
    expect(r.body["reminded"]).toBe(1);
    expect(r.body["charged"]).toBe(0);
    expect(r.body["skipped"]).toBe(1);
    expect(piCalls).toBe(0);
  });

  it("old reminder event without metadata flag: reminds again but still skips the charge", async () => {
    events = [{ event: "reminder_sent", detail: {}, created_at: hoursAgo(25) }];
    const r = await run();
    expect(r.body["reminded"]).toBe(1);
    expect(r.body["charged"]).toBe(0);
    expect(piCalls).toBe(0);
  });

  it("reminder from an earlier run: charges on time", async () => {
    storeMeta["gh_reminded_at"] = hoursAgo(25);
    events = [{ event: "reminder_sent", detail: {}, created_at: hoursAgo(25) }];
    const r = await run();
    expect(r.body["charged"]).toBe(1);
    expect(piCalls).toBe(1);
    expect(row["status"]).toBe("paid");
  });
});

describe("G2: timer charge re-verifies amount + identity against the row", () => {
  const ready = () => {
    storeMeta["gh_reminded_at"] = hoursAgo(25);
    events = [{ event: "reminder_sent", detail: {}, created_at: hoursAgo(25) }];
  };
  it("row amount mismatch blocks the charge", async () => {
    ready();
    row["amount_cents"] = 20000;
    const r = await run();
    expect(r.body["charged"]).toBe(0);
    expect(piCalls).toBe(0);
    expect(r.body["skipped"]).toBeGreaterThan(0);
  });
  it("row email mismatch blocks the charge", async () => {
    ready();
    row["client_email"] = "other@example.com";
    const r = await run();
    expect(r.body["charged"]).toBe(0);
    expect(piCalls).toBe(0);
  });
  it("cancelled or paid row blocks the charge", async () => {
    ready();
    row["status"] = "cancelled";
    const r = await run();
    expect(r.body["charged"]).toBe(0);
    expect(piCalls).toBe(0);
  });
});

describe("failed timer charge emails the client", () => {
  it("sends the payment-failed email once on a failed PaymentIntent", async () => {
    storeMeta["gh_reminded_at"] = hoursAgo(25);
    events = [{ event: "reminder_sent", detail: {}, created_at: hoursAgo(25) }];
    piResult = { status: "requires_payment_method", error: "card declined" };
    const r = await run();
    expect(r.body["failed"]).toBe(1);
    expect(resendSubjects).toContain("Payment didn't go through — Gatehouse Home Cleaning");
    expect(storeMeta["gh_state"]).toBe("payment_failed");
  });
});

describe("selectDue stays strict", () => {
  it("skips issue, bounce and unreminded-but-due the same way", () => {
    const base = {
      id: "cus_v", metadata: {
        gh_booking_id: BID, gh_state: "report_sent", gh_report_sent_at: hoursAgo(30),
        gh_report_amount_cents: "14900", gh_payment_method: "pm_1",
      },
    };
    expect(selectDue([base], Date.now()).length).toBe(1);
    expect(selectDue([{ ...base, metadata: { ...base.metadata, gh_issue_ever: "1" } }], Date.now()).length).toBe(0);
    expect(selectDue([{ ...base, metadata: { ...base.metadata, gh_report_bounced: "1" } }], Date.now()).length).toBe(0);
  });
});
