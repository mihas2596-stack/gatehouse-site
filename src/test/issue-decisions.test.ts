// @vitest-environment node
// TASK 1 (fix6): the owner's issue decisions.
//   - latestIssueDecision picks the newest decision event.
//   - A complaint blocks the 24h timer forever — even 72h+ later.
//   - A waived charge is terminal: chargeVisit refuses it on any basis.
//   - The timer itself still works 72h+ after a report with no issue.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { latestIssueDecision, paymentBasis } from "../../api/_payment_basis";
import { chargeVisit } from "../../api/_payment_obligation";

const BID = "bid-issue-decisions";
const VISIT_ID = "99999999-4444-5555-6666-777777777777";
const SENT_AT = "2026-11-01T10:00:00.000Z";

describe("latestIssueDecision", () => {
  it("returns null with no decision events", () => {
    expect(latestIssueDecision([
      { event: "issue_opened", detail: { reason: "x" }, created_at: "2026-11-01T11:00:00.000Z" },
    ])).toBeNull();
  });

  it("returns the newest decision when several exist", () => {
    const d = latestIssueDecision([
      { event: "issue_decision", detail: { decision: "payment_requested", resolution: "Pay us", decided_at: "2026-11-02T10:00:00.000Z" }, created_at: "2026-11-02T10:00:00.000Z" },
      { event: "issue_decision", detail: { decision: "waived", resolution: "On us", decided_at: "2026-11-03T10:00:00.000Z" }, created_at: "2026-11-03T10:00:00.000Z" },
    ]);
    expect(d?.decision).toBe("waived");
    expect(d?.resolution).toBe("On us");
    expect(d?.decided_at).toBe("2026-11-03T10:00:00.000Z");
  });

  it("ignores decision events with an unknown decision value", () => {
    expect(latestIssueDecision([
      { event: "issue_decision", detail: { decision: "refund" }, created_at: "2026-11-02T10:00:00.000Z" },
    ])).toBeNull();
  });
});

describe("timer after a complaint", () => {
  const events = [
    { event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: SENT_AT },
    { event: "issue_opened", detail: { reason: "Streaks" }, created_at: "2026-11-01T11:00:00.000Z" },
  ];
  it("no timer basis 72h+ after the report when an issue was ever opened", () => {
    expect(paymentBasis(
      { reportSentAt: SENT_AT, events, issueOpenRow: false, issueEverRow: true, bounced: false },
      Date.parse("2026-11-04T11:00:00.000Z"), // 73h after the report
    )).toBeNull();
  });

  it("timer basis still applies 72h+ after the report with no issue", () => {
    expect(paymentBasis(
      { reportSentAt: SENT_AT, events: [events[0]], issueOpenRow: false, issueEverRow: false, bounced: false },
      Date.parse("2026-11-04T11:00:00.000Z"),
    )).toBe("timer_rule");
  });
});

// --- chargeVisit: waived vs timer, with an in-memory Supabase + Stripe ---

type Row = Record<string, unknown>;
type Ev = { visit_id: string | null; booking_id?: string; event: string; detail?: Record<string, unknown>; created_at?: string };

describe("chargeVisit with a waived visit", () => {
  let rows: Row[];
  let events: Ev[];
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
          return supRes({ id: "pi_test_waive", status: "succeeded" });
        }
        if (u.includes("/customers/cus_test")) return supRes({ id: "cus_test" });
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
          const body = JSON.parse(String(init?.body ?? "{}")) as Ev;
          events.push({ ...body, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        let out = [...events];
        const qs = new URLSearchParams(u.split("?")[1] ?? "");
        const bid = qs.get("booking_id");
        if (bid?.startsWith("eq.")) out = out.filter((e) => e.booking_id === decodeURIComponent(bid.slice(3)));
        return supRes(out);
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    }));
  };

  const baseRow = (): Row => ({
    id: VISIT_ID,
    booking_id: BID,
    status: "report_sent",
    report_status: "sent",
    amount_cents: 14900,
    client_email: "client@example.com",
    report_sent_at: SENT_AT,
    issue_open: false,
    issue_ever: true,
    report_bounced: false,
    payment_intent_id: null,
  });

  const baseEvents = (): Ev[] => [
    { visit_id: VISIT_ID, booking_id: BID, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: SENT_AT },
    { visit_id: VISIT_ID, booking_id: BID, event: "issue_opened", detail: { reason: "Streaks on the floor" }, created_at: "2026-11-01T11:00:00.000Z" },
  ];

  const charge = () => chargeVisit({
    secretKey: "sk_test_x",
    bookingId: BID,
    customerId: "cus_test",
    customerEmail: "client@example.com",
    paymentMethod: "pm_test_1",
    source: "timer_24h",
    allowedBases: ["client_approved", "timer_rule"],
    nowMs: Date.parse("2026-11-04T11:00:00.000Z"), // 73h after the report
    deps: {
      setCustomerMeta: async () => {},
      sendReceipt: async () => true,
      sendPaymentFailedEmail: async () => {},
    },
  });

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    stripeCalls = [];
    piCreates = 0;
    installFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("refuses a waived visit and never touches Stripe", async () => {
    rows = [baseRow()];
    events = [
      ...baseEvents(),
      { visit_id: VISIT_ID, booking_id: BID, event: "issue_decision", detail: { decision: "waived", resolution: "On us", decided_at: "2026-11-02T10:00:00.000Z" }, created_at: "2026-11-02T10:00:00.000Z" },
      { visit_id: VISIT_ID, booking_id: BID, event: "issue_resolved", detail: { via: "owner_waive_charge" }, created_at: "2026-11-02T10:00:01.000Z" },
    ];
    const outcome = await charge();
    expect(outcome).toEqual({ outcome: "blocked", error: "charge_waived" });
    expect(stripeCalls.length).toBe(0);
    expect(piCreates).toBe(0);
    expect(rows[0]["status"]).toBe("report_sent");
  });

  it("refuses a waived visit even with a client approval logged before the waive", async () => {
    rows = [baseRow()];
    events = [
      ...baseEvents(),
      // Client approved, then complained, then the owner waived.
      { visit_id: VISIT_ID, booking_id: BID, event: "report_approved", detail: {}, created_at: "2026-11-01T12:00:00.000Z" },
      { visit_id: VISIT_ID, booking_id: BID, event: "issue_decision", detail: { decision: "waived", resolution: "On us", decided_at: "2026-11-02T10:00:00.000Z" }, created_at: "2026-11-02T10:00:00.000Z" },
      { visit_id: VISIT_ID, booking_id: BID, event: "issue_resolved", detail: { via: "owner_waive_charge" }, created_at: "2026-11-02T10:00:01.000Z" },
    ];
    const outcome = await chargeVisit({
      secretKey: "sk_test_x",
      bookingId: BID,
      customerId: "cus_test",
      customerEmail: "client@example.com",
      paymentMethod: "pm_test_1",
      source: "client_approve",
      allowedBases: ["client_approved"],
      nowMs: Date.parse("2026-11-04T11:00:00.000Z"),
      deps: {
        setCustomerMeta: async () => {},
        sendReceipt: async () => true,
        sendPaymentFailedEmail: async () => {},
      },
    });
    expect(outcome).toEqual({ outcome: "blocked", error: "charge_waived" });
    expect(piCreates).toBe(0);
  });

  it("still charges on the timer 73h after the report when no issue was ever opened", async () => {
    rows = [{ ...baseRow(), issue_open: false, issue_ever: false }];
    events = [
      { visit_id: VISIT_ID, booking_id: BID, event: "report_sent", detail: { email_sent: true, version: 1 }, created_at: SENT_AT },
    ];
    const outcome = await charge();
    expect(outcome.outcome).toBe("paid");
    expect(piCreates).toBe(1);
    expect(rows[0]["status"]).toBe("paid");
  });
});
