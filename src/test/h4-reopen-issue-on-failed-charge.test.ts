// @vitest-environment node
// H4: resolve-and-pay is not atomic — the owner resolves the dispute
// (closing it) and the charge then fails. The client cannot reopen
// it: the 24h complaint window runs from report_sent_at and may have
// expired. A terminal charge failure must reopen the resolved dispute
// so the owner sees it again and the client gets a fresh path to
// report. Requires_action and unknown outcomes do NOT reopen (the
// client can still complete 3DS; the money may have moved).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chargeVisit } from "../../api/_payment_obligation";

const BID = "bid-h4";
const VISIT_ID = "66666666-7777-8888-9999-000000000000";
const NOW = Date.parse("2026-11-19T00:00:00Z");

type Row = Record<string, unknown>;
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

function matchRow(row: Row, match: string): boolean {
  const parts = match.split("&").filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("or=(") && part.endsWith(")")) {
      const inner = part.slice(4, -1).split(",");
      const ok = inner.some((c) => {
        const [f, op, ...rest] = c.split(".");
        const v = rest.join(".");
        if (op === "is" && v === "null") return row[f] == null;
        if (op === "eq") return String(row[f] ?? "") === decodeURIComponent(v);
        return false;
      });
      if (!ok) return false;
      continue;
    }
    const [field, op, ...rest] = part.split(".");
    const value = decodeURIComponent(rest.join("."));
    if (field === "order" || field === "limit" || field === "offset") continue;
    if (op === "eq") {
      if (String(row[field] ?? "") !== value) return false;
    } else if (op === "neq") {
      if (String(row[field] ?? "") === value) return false;
    } else if (op === "is" && value === "null") {
      if (row[field] != null) return false;
    }
  }
  return true;
}

describe("H4: a failed charge after a resolved dispute reopens the dispute", () => {
  let rows: Row[];
  let events: Ev[];
  let piBehavior: "declined" | "requires_action" | "throws";
  let metaPatch: Record<string, string>;
  let failedEmailSent: boolean;

  const ev = (event: string, detail: Record<string, unknown> | null, created_at: string): Ev =>
    ({ event, detail, created_at });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows = [{
      id: VISIT_ID,
      booking_id: BID,
      visit_no: 1,
      status: "report_sent",
      report_status: "sent",
      report_sent_at: "2026-11-18T12:00:00.000Z",
      amount_cents: 14900,
      client_email: "client@example.com",
      visit_date: "2026-11-17",
      window: "midday",
      issue_open: false,
      issue_ever: true,
      report_bounced: false,
      payment_intent_id: null,
    }];
    events = [
      ev("report_sent", { version: 1, email_sent: true }, "2026-11-18T12:00:00.000Z"),
      ev("issue_opened", { reason: "Missed a spot", room: "Kitchen" }, "2026-11-18T14:00:00.000Z"),
      ev("issue_resolved", { via: "owner_resolve" }, "2026-11-18T15:00:00.000Z"),
      // The client approved AFTER the dispute was resolved — the
      // approval is newer than the dispute, so it is a live basis.
      ev("report_approved", { via: "client" }, "2026-11-18T16:00:00.000Z"),
    ];
    piBehavior = "declined";
    metaPatch = {};
    failedEmailSent = false;
    const supRes = (data: unknown, ok = true, status = 200) => ({
      ok, status,
      json: async () => data,
      text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.stripe.com/v1/payment_intents/search")) {
        return supRes({ data: [] });
      }
      if (u.includes("api.stripe.com/v1/payment_intents/") && u.includes("/confirm")) {
        return supRes({ id: "pi_test", status: "succeeded", amount: 14900 });
      }
      if (u.includes("api.stripe.com/v1/payment_intents") && method === "POST") {
        if (piBehavior === "throws") throw new Error("network down");
        if (piBehavior === "requires_action") {
          return supRes({ id: "pi_test", status: "requires_action", client_secret: "pi_test_secret_x", amount: 14900 });
        }
        return supRes({ error: { message: "Your card was declined.", code: "card_declined" } }, false, 402);
      }
      if (u.includes("api.stripe.com/v1/payment_intents/")) {
        return supRes({ id: "pi_test", status: "requires_payment_method", amount: 14900, metadata: {} });
      }
      if (u.includes("/rest/v1/gh_visits")) {
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Row;
          const q = u.split("?")[1] ?? "";
          const changed: Row[] = [];
          for (const r of rows) {
            if (matchRow(r, q)) { Object.assign(r, patch); changed.push(r); }
          }
          return supRes(changed);
        }
        return supRes(rows.slice(0, 1));
      }
      if (u.includes("/rest/v1/gh_events")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Row;
          events.push({ event: String(body["event"] ?? ""), detail: (body["detail"] as Record<string, unknown> | null) ?? null, created_at: new Date().toISOString() });
          return supRes([{ id: events.length }]);
        }
        return supRes([...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 60));
      }
      return supRes({}, false, 404);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const charge = () => chargeVisit({
    secretKey: "sk_test_x",
    bookingId: BID,
    customerId: "cus_test_h4",
    customerEmail: "client@example.com",
    paymentMethod: "pm_test_h4",
    source: "client_approve",
    allowedBases: ["client_approved", "timer_rule"],
    nowMs: NOW,
    deps: {
      setCustomerMeta: async (patch) => { Object.assign(metaPatch, patch); },
      sendReceipt: async () => true,
      sendPaymentFailedEmail: async () => { failedEmailSent = true; },
    },
  });

  it("a declined charge reopens the resolved dispute (row + journal)", async () => {
    const out = await charge();
    expect(out.outcome).toBe("failed");
    expect(failedEmailSent).toBe(true);
    expect(rows[0]["status"]).toBe("report_sent");
    expect(rows[0]["issue_open"]).toBe(true);
    const reopened = events.filter((e) => e.event === "issue_opened" && e.detail?.["reason"] === "payment_failed_after_resolve");
    expect(reopened).toHaveLength(1);
  });

  it("no reopen when the visit was never disputed", async () => {
    events = events.filter((e) => e.event !== "issue_opened" && e.event !== "issue_resolved");
    rows[0]["issue_ever"] = false;
    const out = await charge();
    expect(out.outcome).toBe("failed");
    expect(rows[0]["issue_open"]).toBe(false);
    expect(events.some((e) => e.event === "issue_opened" && e.detail?.["reason"] === "payment_failed_after_resolve")).toBe(false);
  });

  it("no reopen when the charge needs 3DS — the client can still complete it", async () => {
    piBehavior = "requires_action";
    const out = await charge();
    expect(out.outcome).toBe("failed");
    expect(out.error).toBe("payment_requires_action");
    expect(rows[0]["issue_open"]).toBe(false);
    expect(events.some((e) => e.event === "issue_opened" && e.detail?.["reason"] === "payment_failed_after_resolve")).toBe(false);
  });

  it("no reopen when the charge outcome is unknown — the money may have moved", async () => {
    piBehavior = "throws";
    const out = await charge();
    expect(out.outcome).toBe("unknown");
    expect(rows[0]["issue_open"]).toBe(false);
    expect(events.some((e) => e.event === "issue_opened" && e.detail?.["reason"] === "payment_failed_after_resolve")).toBe(false);
  });
});
