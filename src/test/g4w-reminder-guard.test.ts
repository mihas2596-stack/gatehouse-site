// @vitest-environment node
// G3: the reminder-before-charge guard is keyed to the CURRENT
// publication. A reminder sent for a publication that was later
// replaced (re-publication logs reminders_rearmed) never satisfies
// the guard — the client gets a fresh reminder before any charge on
// the new publication, and the charge waits for it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import autoChargeHandler, { publicationAnchorMs, latestCurrentEvent } from "../../api/auto-charge";

const BID = "bid-g4w-guard";
const VISIT_ID = "44444444-5555-6666-7777-888888888888";
const CRON = "cron-secret";

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
  ({ event, detail, created_at });

describe("publicationAnchorMs / latestCurrentEvent (pure)", () => {
  it("an old reminder does not survive a republication", () => {
    const sent30 = hoursAgo(30);
    const events = [
      ev("reminders_rearmed", { version: 2, report_sent_at: sent30 }, sent30),
      ev("report_sent", { version: 2 }, sent30),
      ev("reminder_sent", {}, hoursAgo(45)),
      ev("report_sent", { version: 1 }, hoursAgo(50)),
    ];
    expect(publicationAnchorMs(events)).toBe(Date.parse(sent30));
    expect(latestCurrentEvent(events, ["reminder_sent", "reminder_bounced"])).toBeNull();
  });

  it("a reminder sent after the republication counts", () => {
    const rem25 = hoursAgo(25);
    const sent30 = hoursAgo(30);
    const events = [
      ev("reminder_sent", {}, rem25),
      ev("reminders_rearmed", { version: 2, report_sent_at: sent30 }, sent30),
      ev("report_sent", { version: 2 }, sent30),
      ev("reminder_sent", {}, hoursAgo(45)),
    ];
    const latest = latestCurrentEvent(events, ["reminder_sent", "reminder_bounced"]);
    expect(latest?.event).toBe("reminder_sent");
    expect(latest?.created_at).toBe(rem25);
  });

  it("without a re-arm event the latest report_sent is the anchor", () => {
    const rem25 = hoursAgo(25);
    const sent30 = hoursAgo(30);
    const events = [
      ev("reminder_sent", {}, rem25),
      ev("report_sent", { version: 1 }, sent30),
    ];
    expect(latestCurrentEvent(events, ["reminder_sent"])?.created_at).toBe(rem25);
    const oldOnly = [
      ev("report_sent", { version: 2 }, hoursAgo(5)),
      ev("reminder_sent", {}, rem25),
    ];
    expect(latestCurrentEvent(oldOnly, ["reminder_sent"])).toBeNull();
  });

  it("with no publication on record any latest reminder counts (legacy fail-open)", () => {
    const rem25 = hoursAgo(25);
    const events = [ev("reminder_sent", {}, rem25)];
    expect(publicationAnchorMs(events)).toBeNull();
    expect(latestCurrentEvent(events, ["reminder_sent"])?.created_at).toBe(rem25);
  });

  it("a bounce after the republication means unreminded", () => {
    const events = [
      ev("reminder_bounced", {}, hoursAgo(24)),
      ev("reminder_sent", {}, hoursAgo(25)),
      ev("reminders_rearmed", { version: 2, report_sent_at: hoursAgo(30) }, hoursAgo(30)),
    ];
    const latest = latestCurrentEvent(events, ["reminder_sent", "reminder_bounced"]);
    expect(latest?.event).toBe("reminder_bounced");
  });

  it("the early reminder is keyed the same way", () => {
    const events = [
      ev("early_reminder_sent", {}, hoursAgo(40)),
      ev("reminders_rearmed", { version: 2, report_sent_at: hoursAgo(30) }, hoursAgo(30)),
    ];
    expect(latestCurrentEvent(events, ["early_reminder_sent"])).toBeNull();
  });

  it("the re-arm detail's report_sent_at is the anchor, not its own timestamp", () => {
    // The re-arm is journaled a moment after the publish; the
    // publication time in its detail is the exact anchor.
    const sent30 = hoursAgo(30);
    const rem295 = hoursAgo(29.5);
    const events = [
      ev("reminders_rearmed", { version: 2, report_sent_at: sent30 }, hoursAgo(29)),
      ev("reminder_sent", {}, rem295),
    ];
    // 29.5h ago is BEFORE the re-arm event's created_at but AFTER
    // the publication it re-armed — it belongs to the new publication.
    expect(latestCurrentEvent(events, ["reminder_sent"])?.created_at).toBe(rem295);
  });
});

// ---------- handler-level: the charge loop waits for a fresh reminder ----------

let row: Row;
let events: Ev[];
let storeMeta: Record<string, string>;
let resendSubjects: string[];
let piCalls: number;

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
    gh_report_amount_cents: "14900", gh_payment_method: "pm_1", gh_report_version: "2",
  };
  resendSubjects = [];
  piCalls = 0;
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
        events.push({ event: body.event ?? "", detail: body.detail ?? null, created_at: new Date().toISOString() });
        return okRes([{ id: events.length }]);
      }
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

// v1 sent 50h ago, reminded 45h ago, re-published 30h ago.
function republicationEvents(): Ev[] {
  return [
    ev("report_sent", { version: 2, email_sent: true }, hoursAgo(30)),
    ev("reminders_rearmed", { version: 2, report_sent_at: hoursAgo(30) }, hoursAgo(30)),
    ev("reminder_sent", {}, hoursAgo(45)),
    ev("report_sent", { version: 1, email_sent: true }, hoursAgo(50)),
  ];
}

describe("G3 reminder guard keyed to the current publication", () => {
  it("a pre-republication reminder never satisfies the guard: fresh reminder fires, charge waits", async () => {
    events = republicationEvents();
    // Post-hydration state: the re-arm cleared the reminder flags, so
    // the reminder passes see an unreminded publication.
    const r = await run();
    expect(r.body["reminded"]).toBe(1);
    expect(r.body["charged"]).toBe(0);
    expect(r.body["skipped"]).toBe(1);
    expect(piCalls).toBe(0);
    expect(events.some((e) => e.event === "reminder_sent")).toBe(true);
  });

  it("a reminder sent after the republication lets the charge through", async () => {
    events = [
      ev("reminder_sent", {}, hoursAgo(25)),
      ...republicationEvents(),
    ];
    storeMeta["gh_reminded_at"] = hoursAgo(25);
    storeMeta["gh_reminder_for"] = BID;
    const r = await run();
    expect(r.body["charged"]).toBe(1);
    expect(piCalls).toBe(1);
    expect(row["status"]).toBe("paid");
  });

  it("a bounced post-republication reminder re-reminds instead of charging", async () => {
    events = [
      ev("reminder_bounced", {}, hoursAgo(24)),
      ev("reminder_sent", {}, hoursAgo(25)),
      ...republicationEvents(),
    ];
    storeMeta["gh_reminded_at"] = hoursAgo(25);
    storeMeta["gh_reminder_for"] = BID;
    const r = await run();
    expect(r.body["reminded"]).toBe(1);
    expect(r.body["charged"]).toBe(0);
    expect(piCalls).toBe(0);
  });
});
